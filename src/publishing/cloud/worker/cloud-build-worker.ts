import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PublishingError } from "../../publishing-errors.js";
import { verifyPublishableSource } from "../../production-build-service.js";
import { collectStaticOutput } from "../../static-artifact.js";
import {
  BUILD_REQUEST_SCHEMA,
  BUILD_RESULT_SCHEMA,
  PROBE_REPORT_SCHEMA,
  WORKER_FAILURE_CODES,
  selfCheckViolations,
  sha256Hex,
  type CloudBuildFailureCode,
  type CloudBuildRequest,
  type CloudBuildResult,
  type SandboxSelfCheck,
} from "../cloud-build-protocol.js";

/**
 * The trusted worker inside the Cloud Run job (pinned image). It holds the
 * two single-object signed URLs; site code never does. Untrusted work (npm ci
 * on the site's lockfile, the Vite build) runs only inside Cloud Run
 * sandboxes WITHOUT --allow-egress: no network, no metadata server, no
 * inherited environment, read-only root. Dependencies are fetched here, from
 * the npm registry only, each checked against the lockfile's sha512.
 */

export interface SandboxRun {
  readonly name: string;
  readonly command: readonly string[];
  readonly mounts: readonly { readonly host: string; readonly target: string; readonly readonly?: boolean }[];
  readonly workdir?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}
export interface SandboxRunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}
export interface SandboxRunner {
  run(input: SandboxRun): Promise<SandboxRunResult>;
}

/** `sandbox do` arguments. Never adds --allow-egress; mounts are explicit. */
export function sandboxCliArgs(input: SandboxRun): string[] {
  const args = ["do", "--sandbox-name", input.name];
  for (const mount of input.mounts) args.push("--mount", `${mount.host}:${mount.target}${mount.readonly ? ",readonly" : ""}`);
  if (input.workdir) args.push("-w", input.workdir);
  for (const [key, value] of Object.entries(input.env)) args.push("-e", `${key}=${value}`);
  return [...args, "--", ...input.command];
}

const OUTPUT_CAP = 64 * 1024;

/** Runs the platform `sandbox` CLI; on timeout the session is force-deleted. */
export function createSandboxCliRunner(binary = "sandbox"): SandboxRunner {
  return {
    run(input) {
      const started = Date.now();
      return new Promise((resolvePromise) => {
        const child = spawn(binary, sandboxCliArgs(input), { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_CAP)));
        child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_CAP)));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          spawn(binary, ["delete", "--force", input.name], { stdio: "ignore" }).on("error", () => undefined);
        }, input.timeoutMs);
        const finish = (exitCode: number | null) => {
          clearTimeout(timer);
          resolvePromise({ exitCode, timedOut, stdout, stderr, durationMs: Date.now() - started });
        };
        child.once("error", () => finish(null));
        child.once("close", (code) => finish(code));
      });
    },
  };
}

/** The worker's inputs; removed from process.env so no child inherits them. */
export interface WorkerEnv {
  readonly buildId: string;
  readonly requestUrl?: string;
  readonly requestSha256?: string;
  readonly resultUrl: string;
  readonly resultMaxBytes: number;
}

const SIGNED_URL = /^https:\/\/storage\.googleapis\.com\/[a-z0-9._-]+\/(?:builds|probes)\/[0-9a-f-]{36}\/[a-z]+\.json\?/;
const ID = /^[0-9a-f-]{36}$/;

export function captureWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const take = (name: string) => {
    const value = env[name];
    delete env[name];
    return value?.trim();
  };
  const buildId = take("SITES_BUILD_ID") ?? "";
  const requestUrl = take("SITES_BUILD_REQUEST_URL");
  const requestSha256 = take("SITES_BUILD_REQUEST_SHA256");
  const resultUrl = take("SITES_BUILD_RESULT_URL") ?? "";
  const resultMaxBytes = Number(take("SITES_BUILD_RESULT_MAX_BYTES"));
  if (!ID.test(buildId) || !SIGNED_URL.test(resultUrl) || !(resultMaxBytes > 0)) throw new Error("Invalid worker invocation");
  if (requestUrl !== undefined && (!SIGNED_URL.test(requestUrl) || !/^[a-f0-9]{64}$/.test(requestSha256 ?? ""))) throw new Error("Invalid worker invocation");
  return { buildId, ...(requestUrl ? { requestUrl, requestSha256: requestSha256! } : {}), resultUrl, resultMaxBytes };
}

export interface WorkerDeps {
  readonly env: WorkerEnv;
  readonly fetch: typeof fetch;
  readonly sandbox: SandboxRunner;
  /** Host directory for per-build files (never a secret location). */
  readonly workRoot: string;
  /** Absolute path of sandbox-self-check.js, visible read-only inside sandboxes. */
  readonly selfCheckScript: string;
}

const FAIL_CLOSED_CHECK: SandboxSelfCheck = {
  metadataReachable: true, egressReachable: true, inheritedEnv: ["self-check-unavailable"], hostEnvironReadable: true, rootWritable: true, credentialFilesVisible: true,
};

async function selfCheck(deps: WorkerDeps): Promise<SandboxSelfCheck> {
  const result = await deps.sandbox.run({ name: `check-${deps.env.buildId.slice(0, 8)}`, command: ["node", deps.selfCheckScript], mounts: [], env: {}, timeoutMs: 60_000 });
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as SandboxSelfCheck;
    return result.exitCode === 0 && Array.isArray(parsed.inheritedEnv) ? parsed : FAIL_CLOSED_CHECK;
  } catch {
    return FAIL_CLOSED_CHECK;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("too large");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const workerFailure = (code: CloudBuildFailureCode, stage: string, log?: string) => Object.assign(new Error(code), { workerCode: code, stage, log });

const NPM_REGISTRY = "https://registry.npmjs.org/";

/** Downloads every locked tarball (registry only, sha512-verified) and points the lockfile at the local copies. */
async function fetchDependencies(deps: WorkerDeps, lockText: string, depsDir: string, request: CloudBuildRequest): Promise<{ lock: string; count: number; bytes: number }> {
  const lock = JSON.parse(lockText) as { packages: Record<string, { resolved?: string; integrity?: string }> };
  const entries = Object.entries(lock.packages).filter(([path]) => path !== "");
  if (entries.length > request.limits.maxDependencies) throw workerFailure("PUBLISH_DEPENDENCY_INSTALL_FAILED", "DOWNLOAD", "too many dependencies");
  const byUrl = new Map<string, { integrity: string; local: string }>();
  for (const [, entry] of entries) {
    // verifyPublishableSource already required registry URLs with sha512 integrity.
    if (!entry.resolved?.startsWith(NPM_REGISTRY) || !entry.integrity?.startsWith("sha512-")) throw workerFailure("PUBLISH_SOURCE_INVALID", "DOWNLOAD");
    if (!byUrl.has(entry.resolved)) byUrl.set(entry.resolved, { integrity: entry.integrity, local: `${byUrl.size}.tgz` });
  }
  let total = 0;
  const queue = [...byUrl.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [url, target] = next;
      let bytes: Buffer;
      try {
        const response = await deps.fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`status ${response.status}`);
        bytes = await readCapped(response, Math.min(64 * 1024 * 1024, request.limits.maxDependencyBytes - total));
      } catch (error) {
        throw workerFailure("PUBLISH_DEPENDENCY_INSTALL_FAILED", "DOWNLOAD", `${new URL(url).pathname.slice(0, 120)}: ${(error as Error).message}`.slice(0, 300));
      }
      total += bytes.length;
      if (total > request.limits.maxDependencyBytes) throw workerFailure("PUBLISH_DEPENDENCY_INSTALL_FAILED", "DOWNLOAD", "dependencies too large");
      if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== target.integrity)
        throw workerFailure("PUBLISH_DEPENDENCY_INSTALL_FAILED", "DOWNLOAD", `integrity mismatch for ${new URL(url).pathname.slice(0, 120)}`);
      await writeFile(join(depsDir, target.local), bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  // npm ci verifies the same integrity against the local tarball; nothing else in the lockfile changes.
  for (const [, entry] of entries) entry.resolved = `file:../deps/${byUrl.get(entry.resolved!)!.local}`;
  return { lock: `${JSON.stringify(lock, null, 2)}\n`, count: byUrl.size, bytes: total };
}

async function build(deps: WorkerDeps, request: CloudBuildRequest, root: string): Promise<CloudBuildResult["outcome"]> {
  const started = Date.now();
  const sourceBytes = Buffer.from(request.sourceBase64, "base64");
  if (sha256Hex(sourceBytes) !== request.sourceSha256) throw workerFailure("PUBLISH_SOURCE_INVALID", "SOURCE");
  const snapshot = await verifyPublishableSource({ sourceArtifactRef: request.sourceArtifactRef, sourceBytes }).catch(() => {
    throw workerFailure("PUBLISH_SOURCE_INVALID", "SOURCE");
  });
  const project = join(root, "project");
  const depsDir = join(root, "deps");
  await mkdir(project, { recursive: true });
  await mkdir(depsDir, { recursive: true });
  for (const file of snapshot.manifest.files) {
    const target = resolve(project, ...file.path.split("/"));
    if (!target.startsWith(project + sep)) throw workerFailure("PUBLISH_SOURCE_INVALID", "SOURCE");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(snapshot.files[file.path]!, file.encoding ?? "utf8"));
  }
  const dependencies = await fetchDependencies(deps, snapshot.files["package-lock.json"]!, depsDir, request);
  await writeFile(join(project, "package-lock.json"), dependencies.lock);

  const redact = (text: string) => text.split(root).join("<workspace>").slice(-2_000);
  const env = { NODE_OPTIONS: `--max-old-space-size=${request.limits.memoryMb}`, CI: "true", HOME: "/tmp", npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
  const short = deps.env.buildId.slice(0, 8);
  const install = await deps.sandbox.run({
    name: `install-${short}`, command: ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    mounts: [{ host: project, target: project }, { host: depsDir, target: depsDir, readonly: true }], workdir: project, env, timeoutMs: request.limits.installTimeoutMs,
  });
  if (install.timedOut) throw workerFailure("PUBLISH_BUILD_TIMEOUT", "INSTALL");
  if (install.exitCode !== 0) throw workerFailure("PUBLISH_DEPENDENCY_INSTALL_FAILED", "INSTALL", redact(install.stderr || install.stdout));
  const built = await deps.sandbox.run({
    name: `build-${short}`, command: ["npm", "run", "build"], mounts: [{ host: project, target: project }], workdir: project, env, timeoutMs: request.limits.buildTimeoutMs,
  });
  if (built.timedOut) throw workerFailure("PUBLISH_BUILD_TIMEOUT", "BUILD");
  if (built.exitCode !== 0) throw workerFailure("PUBLISH_BUILD_FAILED", "BUILD", redact(built.stderr || built.stdout));
  // The same link-free, bounded collector as local builds; the coordinator re-validates everything.
  const files = await collectStaticOutput(join(project, "dist"), project, request.limits.output).catch((error: unknown) => {
    throw workerFailure("PUBLISH_ARTIFACT_INVALID", "COLLECT", error instanceof PublishingError ? error.message : undefined);
  });
  return {
    status: "SUCCEEDED",
    files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.content), sizeBytes: file.content.length, contentBase64: file.content.toString("base64") })),
    metrics: { installMs: install.durationMs, buildMs: built.durationMs, totalMs: Date.now() - started, dependencies: dependencies.count, dependencyBytes: dependencies.bytes },
  };
}

async function upload(deps: WorkerDeps, document: unknown): Promise<boolean> {
  let body = Buffer.from(JSON.stringify(document));
  if (body.length > deps.env.resultMaxBytes) {
    const original = document as CloudBuildResult;
    body = Buffer.from(JSON.stringify({ ...original, outcome: { status: "FAILED", code: "PUBLISH_ARTIFACT_INVALID", stage: "UPLOAD", log: "result too large" } }));
  }
  const response = await deps.fetch(deps.env.resultUrl, {
    method: "PUT", body, redirect: "error",
    headers: { "content-type": "application/json", "x-goog-content-length-range": `0,${deps.env.resultMaxBytes}` },
    signal: AbortSignal.timeout(120_000),
  });
  return response.ok;
}

/** Returns the process exit code: 0 once a result (success or failure) was delivered. */
export async function runCloudBuildWorker(mode: string, deps: WorkerDeps): Promise<number> {
  const checks = await selfCheck(deps);
  const isolation = { sandbox: true as const, checks };
  if (mode === "probe") return (await upload(deps, { schema: PROBE_REPORT_SCHEMA, probeId: deps.env.buildId, isolation })) ? 0 : 1;
  if (mode !== "build" || !deps.env.requestUrl) return 2;

  const root = join(deps.workRoot, deps.env.buildId);
  let outcome: CloudBuildResult["outcome"];
  try {
    const response = await deps.fetch(deps.env.requestUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw workerFailure("PUBLISH_BUILD_WORKER_FAILED", "REQUEST");
    const bytes = await readCapped(response, 128 * 1024 * 1024);
    if (sha256Hex(bytes) !== deps.env.requestSha256) throw workerFailure("PUBLISH_SOURCE_INVALID", "REQUEST");
    const request = JSON.parse(bytes.toString("utf8")) as CloudBuildRequest;
    if (request.schema !== BUILD_REQUEST_SCHEMA || request.buildId !== deps.env.buildId) throw workerFailure("PUBLISH_SOURCE_INVALID", "REQUEST");
    // Never run site code unless this sandbox proved it is isolated.
    if (selfCheckViolations(checks).length) throw workerFailure("PUBLISH_ISOLATION_UNAVAILABLE", "ISOLATION");
    outcome = await build(deps, request, root);
  } catch (error) {
    const code = (error as { workerCode?: string }).workerCode;
    outcome = {
      status: "FAILED",
      code: code && WORKER_FAILURE_CODES.has(code) ? (code as CloudBuildFailureCode) : "PUBLISH_BUILD_WORKER_FAILED",
      stage: (error as { stage?: string }).stage ?? "WORKER",
      ...((error as { log?: string }).log ? { log: (error as { log: string }).log.slice(0, 2_000) } : {}),
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  const result: CloudBuildResult = { schema: BUILD_RESULT_SCHEMA, buildId: deps.env.buildId, requestSha256: deps.env.requestSha256!, isolation, outcome };
  return (await upload(deps, result).catch(() => false)) ? 0 : 1;
}
