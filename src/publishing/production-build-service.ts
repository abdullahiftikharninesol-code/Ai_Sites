import { join } from "node:path";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type {
  CommandRequest,
  CommandResult,
  CreateEnvironmentOptions,
  ExecutionEnvironment,
} from "../execution/execution-types.js";
import { SiteSourceSnapshotService, type SiteSourceSnapshot } from "../sites/generation/source-snapshot.js";
import { SitePackageValidator } from "../sites/generation/site-policies.js";
import { DEFAULT_VITE_CONFIG } from "../sites/scaffold/react-vite-scaffold.js";
import { normalizeBuildLog, summarizeInstallFailure } from "../cli/runtime/build-log-normalizer.js";
import { PublishingError } from "./publishing-errors.js";
import {
  DEFAULT_STATIC_ARTIFACT_LIMITS,
  collectStaticOutput,
  analyzeSiteRouting,
  staticHostingConfig,
  validateStaticArtifact,
  type SiteRoutingMode,
  type StaticArtifactLimits,
  type StaticArtifactSummary,
  type StaticFile,
} from "./static-artifact.js";

/** The part of the local execution provider a production build needs. */
export interface ProductionBuildExecution {
  createEnvironment(options: CreateEnvironmentOptions): Promise<ExecutionEnvironment>;
  destroyEnvironment(id: string): Promise<void>;
  writeFileBytes(id: string, path: string, content: Uint8Array): Promise<void>;
  executeCommand(id: string, command: CommandRequest): Promise<CommandResult>;
  getWorkspacePath(id: string): string;
}

export interface ProductionBuildLimits {
  readonly installTimeoutMs: number;
  readonly buildTimeoutMs: number;
  /** V8 heap cap for npm and the Vite build (NODE_OPTIONS). */
  readonly memoryMb: number;
  readonly output: StaticArtifactLimits;
}

const bounded = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const value = Number(env[name] ?? fallback);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
};

export function loadProductionBuildLimits(env: NodeJS.ProcessEnv = process.env): ProductionBuildLimits {
  return {
    installTimeoutMs: bounded(env, "SITES_PUBLISH_INSTALL_TIMEOUT_MS", 300_000, 30_000, 900_000),
    buildTimeoutMs: bounded(env, "SITES_PUBLISH_BUILD_TIMEOUT_MS", 180_000, 15_000, 600_000),
    memoryMb: bounded(env, "SITES_PUBLISH_BUILD_MEMORY_MB", 1_536, 256, 8_192),
    output: {
      ...DEFAULT_STATIC_ARTIFACT_LIMITS,
      maxTotalBytes: bounded(env, "SITES_PUBLISH_MAX_OUTPUT_MB", 30, 1, 200) * 1024 * 1024,
    },
  };
}

export interface ProductionBuildInput {
  readonly siteId: string;
  readonly versionId: string;
  readonly sourceArtifactRef: string;
  /** The exact source bytes the preparation is bound to (already hashed by the caller). */
  readonly sourceBytes: Uint8Array;
}

export interface ProductionBuildResult {
  readonly files: readonly StaticFile[];
  readonly generated: readonly StaticFile[];
  readonly routing: SiteRoutingMode;
  /** Representative static client routes (history routing), for direct-access verification. */
  readonly routes: readonly string[];
  readonly summary: StaticArtifactSummary;
  readonly metrics: { readonly installMs: number; readonly buildMs: number; readonly totalMs: number };
}

/** Serves only the pinned source bytes, so verification and restore use exactly what was hashed. */
const pinnedStore = (ref: string, bytes: Uint8Array): ArtifactStore => ({
  get: (key) => Promise.resolve(key === ref ? bytes : undefined),
  exists: (key) => Promise.resolve(key === ref),
  put: () => Promise.reject(new Error("read-only")),
  delete: () => Promise.reject(new Error("read-only")),
});

/**
 * Verifies a saved snapshot without building it (shape, safe paths, per-file
 * size and SHA-256, approved packages, lockfile present).
 */
export async function verifyPublishableSource(input: Omit<ProductionBuildInput, "siteId" | "versionId">): Promise<SiteSourceSnapshot> {
  let snapshot: SiteSourceSnapshot;
  try {
    snapshot = await new SiteSourceSnapshotService(pinnedStore(input.sourceArtifactRef, input.sourceBytes)).verify(input.sourceArtifactRef);
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    throw new PublishingError(
      code === "ARTIFACT_NOT_FOUND" ? "PUBLISH_SOURCE_UNAVAILABLE" : "PUBLISH_SOURCE_INVALID",
      "The saved source for this version is missing or failed integrity verification.",
    );
  }
  const paths = new Set(snapshot.manifest.files.map((file) => file.path));
  for (const required of ["package.json", "package-lock.json", "index.html"])
    if (!paths.has(required))
      throw new PublishingError("PUBLISH_SOURCE_INVALID", `The saved source is missing ${required}; it cannot be built with locked dependencies.`, {
        metadata: { missing: required },
      });
  const packageJson = snapshot.files["package.json"]!;
  try {
    new SitePackageValidator().validate(packageJson);
  } catch (cause) {
    throw new PublishingError("PUBLISH_SOURCE_INVALID", "The saved package.json does not satisfy the dependency policy.", {
      metadata: { reason: (cause as Error).message.slice(0, 300) },
    });
  }
  const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts;
  if (typeof scripts?.build !== "string")
    throw new PublishingError("PUBLISH_SOURCE_INVALID", "The saved package.json has no build script.");
  verifyBuildInputs(snapshot, scripts.build);
  return snapshot;
}

/**
 * The only build inputs that execute on the build host are the build script,
 * vite.config.ts and the locked dependencies. All are Sites-managed files, but
 * a stored snapshot is data, so publishing accepts only the managed forms and
 * fails closed on anything else (legacy or tampered snapshots included).
 */
export const APPROVED_BUILD_SCRIPTS: readonly string[] = ["vite build", "tsc --noEmit && vite build"];
const NPM_REGISTRY = "https://registry.npmjs.org/";
const unmanaged = (message: string, metadata?: Record<string, unknown>) =>
  new PublishingError("PUBLISH_SOURCE_INVALID", `${message} Publishing only builds Sites-managed build configuration.`, { metadata });

function verifyBuildInputs(snapshot: SiteSourceSnapshot, buildScript: string) {
  if (!APPROVED_BUILD_SCRIPTS.includes(buildScript.trim()))
    throw unmanaged("The saved build script is not an approved Sites build command.", { buildScript: buildScript.slice(0, 200) });
  const viteConfig = snapshot.files["vite.config.ts"];
  if (viteConfig !== undefined && viteConfig.replace(/\r\n/g, "\n") !== DEFAULT_VITE_CONFIG.replace(/\r\n/g, "\n"))
    throw unmanaged("The saved vite.config.ts differs from the Sites-managed configuration.");
  let lock: { lockfileVersion?: unknown; packages?: unknown };
  try {
    lock = JSON.parse(snapshot.files["package-lock.json"]!) as typeof lock;
  } catch {
    throw unmanaged("The saved package-lock.json is not valid JSON.");
  }
  if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) || !lock.packages || typeof lock.packages !== "object")
    throw unmanaged("The saved package-lock.json is not a supported npm lockfile (v2 or v3).");
  for (const [path, value] of Object.entries(lock.packages as Record<string, unknown>)) {
    if (path === "") continue;
    const entry = (value ?? {}) as { resolved?: unknown; integrity?: unknown; link?: unknown };
    // Registry tarballs with integrity only: no git, file, link or other hosts.
    if (
      !path.startsWith("node_modules/") ||
      entry.link === true ||
      typeof entry.resolved !== "string" ||
      !entry.resolved.startsWith(NPM_REGISTRY) ||
      typeof entry.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
    )
      throw unmanaged("The saved package-lock.json references a package outside the npm registry or without integrity.", {
        package: path.slice(0, 200),
      });
  }
}

/**
 * Builds one verified snapshot in a fresh, separate workspace: restore →
 * `npm ci --ignore-scripts` from the registry-only lockfile (cache preferred)
 * → `npm run build` → collect and validate dist. Commands run with an
 * allow-listed environment (no server credentials), a V8 heap cap and hard
 * timeouts. This is NOT a sandbox: on the local provider the toolchain can
 * still read the host filesystem and reach the network, which is why the
 * preparation service only builds trusted sites there. The saved source is
 * only read; the workspace is always destroyed. No AI repair is attempted.
 */
export class ProductionBuildService {
  constructor(
    private readonly execution: ProductionBuildExecution,
    private readonly limits: ProductionBuildLimits = loadProductionBuildLimits(),
  ) {}

  async build(input: ProductionBuildInput): Promise<ProductionBuildResult> {
    const started = Date.now();
    const snapshot = await verifyPublishableSource(input);
    const { mode: routing, routes } = analyzeSiteRouting(
      Object.fromEntries(
        snapshot.manifest.files.filter((file) => !file.encoding).map((file) => [file.path, snapshot.files[file.path]!]),
      ),
    );
    const environment = await this.execution.createEnvironment({
      memoryMb: this.limits.memoryMb,
      timeoutSeconds: Math.ceil((this.limits.installTimeoutMs + this.limits.buildTimeoutMs) / 1_000),
    });
    try {
      for (const file of snapshot.manifest.files)
        await this.execution.writeFileBytes(environment.id, file.path, Buffer.from(snapshot.files[file.path]!, file.encoding ?? "utf8"));
      const workspace = this.execution.getWorkspacePath(environment.id);
      const redact = (text: string) => text.split(workspace).join("<workspace>");
      const environmentVariables = {
        NODE_OPTIONS: `--max-old-space-size=${this.limits.memoryMb}`,
        CI: "true",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      };
      const install = await this.execution.executeCommand(environment.id, {
        executable: "npm",
        // Dependency lifecycle scripts never run: the approved stack (Vite,
        // esbuild/rollup via platform packages) builds without them.
        args: ["ci", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts"],
        timeoutMs: this.limits.installTimeoutMs,
        environment: environmentVariables,
        isolatedEnvironment: true,
      });
      if (install.timedOut || install.exitCode !== 0) {
        const summary = summarizeInstallFailure(redact(install.stderr), redact(install.stdout), 1_500);
        throw new PublishingError(
          install.timedOut ? "PUBLISH_BUILD_TIMEOUT" : "PUBLISH_DEPENDENCY_INSTALL_FAILED",
          install.timedOut
            ? "Installing the site's locked dependencies timed out."
            : "Installing the site's locked dependencies failed.",
          { metadata: { stage: "INSTALL", exitCode: install.exitCode, durationMs: install.durationMs, ...(summary.npmErrorCode ? { npmErrorCode: summary.npmErrorCode } : {}), log: summary.output } },
        );
      }
      const build = await this.execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: this.limits.buildTimeoutMs,
        environment: environmentVariables,
        isolatedEnvironment: true,
      });
      if (build.timedOut || build.exitCode !== 0)
        throw new PublishingError(
          build.timedOut ? "PUBLISH_BUILD_TIMEOUT" : "PUBLISH_BUILD_FAILED",
          build.timedOut
            ? "The production build timed out. The saved version was not changed."
            : "The production build failed. The saved version was not changed.",
          { metadata: { stage: "BUILD", exitCode: build.exitCode, durationMs: build.durationMs, log: normalizeBuildLog(redact(build.stderr), redact(build.stdout), { maxBytes: 2_000 }) } },
        );
      const files = await collectStaticOutput(join(workspace, "dist"), workspace, this.limits.output);
      const summary = validateStaticArtifact(files, routing);
      return {
        files,
        generated: [staticHostingConfig(routing)],
        routing,
        routes,
        summary,
        metrics: { installMs: install.durationMs, buildMs: build.durationMs, totalMs: Date.now() - started },
      };
    } finally {
      await this.execution.destroyEnvironment(environment.id).catch(() =>
        console.warn("[sites][publish] build workspace cleanup failed; startup reconciliation will report it"),
      );
    }
  }
}
