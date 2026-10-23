import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserQAReport } from "../../browser-qa/browser-qa-domain.js";
import type { GenerationCompletionTelemetry } from "../../agents/validation/generation-completion.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { safeRedactSecrets } from "../../cli/runtime/build-log-normalizer.js";
import { SiteArtifactSecurityScanner } from "../../site-security/site-artifact-security-scanner.js";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import type { FunctionalRequirements } from "./functional-capabilities.js";
import type { referenceContextTelemetry } from "./generation-development-telemetry.js";

export interface FailedCandidateEvidenceRequest {
  readonly execution: Pick<ExecutionProvider, "listFiles" | "readFile">;
  readonly environmentId: string;
  readonly jobId: string;
  readonly siteId: string;
  readonly report?: BrowserQAReport;
  readonly candidate?: SiteCoderFileBundle;
  readonly validationFailure?: { readonly failureStage: "STATIC_VALIDATION" | "BUILD"; readonly code: string; readonly check: string; readonly message: string; readonly buildPassed: boolean };
  readonly completion?: GenerationCompletionTelemetry | undefined;
  readonly functionalRequirements?: FunctionalRequirements;
  readonly referenceContext?: ReturnType<typeof referenceContextTelemetry>;
}
export interface FailedCandidateEvidence {
  preserve(request: FailedCandidateEvidenceRequest): Promise<string | void>;
}

export const FAILED_CANDIDATE_LIMITS = Object.freeze({ maxFiles: 5, maxBytes: 2 * 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000, maxSourceFileBytes: 256 * 1024 });
export function createDevelopmentFailedCandidateEvidence(dataRoot: string, nodeEnv = process.env.NODE_ENV): LocalFailedCandidateEvidence | undefined {
  return nodeEnv === "production" ? undefined : new LocalFailedCandidateEvidence(join(dataRoot, "diagnostics", "failed-candidates"));
}
const candidateName = /^candidate-[a-f0-9]{32}\.json$/;
const sourcePath = /^(?:src\/(?!.*(?:^|\/)(?:\.\.?|node_modules)(?:\/|$))[\w./-]+\.(?:tsx?|jsx?|css|json)|index\.html|package\.json|tsconfig(?:\.[\w-]+)?\.json|vite\.config\.ts)$/;

/** Private local development evidence, outside the artifact store/API and product persistence. */
export class LocalFailedCandidateEvidence implements FailedCandidateEvidence {
  readonly root: string;
  #queue: Promise<void> = Promise.resolve();
  constructor(root: string, private readonly now: () => number = Date.now) { this.root = resolve(root); }

  async prune(reserve = 0): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("Diagnostic directory cannot be a link");
    const files = [];
    for (const name of await readdir(this.root)) {
      if (!candidateName.test(name)) continue;
      const path = join(this.root, name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (this.now() - info.mtimeMs >= FAILED_CANDIDATE_LIMITS.maxAgeMs || info.size > FAILED_CANDIDATE_LIMITS.maxBytes) await unlink(path);
      else files.push({ path, modified: info.mtimeMs });
    }
    files.sort((a, b) => b.modified - a.modified);
    // Delete only validated, directly contained diagnostic files; never recursively delete a directory.
    for (const file of files.slice(Math.max(0, FAILED_CANDIDATE_LIMITS.maxFiles - reserve))) await unlink(file.path);
  }

  preserve(request: FailedCandidateEvidenceRequest): Promise<string | void> {
    const operation = this.#queue.then(() => this.#preserve(request));
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #preserve(request: FailedCandidateEvidenceRequest): Promise<string | void> {
    if (request.report?.status !== "FAIL" && !request.validationFailure) return;
    await this.prune(1);
    const secrets = Object.entries(process.env).filter(([key, value]) =>
      /TOKEN|SECRET|PASSWORD|API_?KEY|JWT|DATABASE|REDIS_URL|AUTHORIZATION|COOKIE/i.test(key) && value && value.length >= 6).map(([, value]) => value!);
    const clean = (value: string): string => {
      let result = value;
      for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
      return safeRedactSecrets(result)
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
        .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
        .replace(/\b(?:[\w-]*(?:token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key))["']?\s*[:=]\s*["'][^"'\r\n]+["']/gi, "redacted_secret=\"[REDACTED]\"")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
    };
    const files: Record<string, string> = {};
    let omittedFiles = 0, redactedFiles = 0, sourceBytes = 0;
    const scanner = new SiteArtifactSecurityScanner();
    const submitted = new Map(request.candidate?.files.map(file => [file.path, file.content]));
    const entries = request.candidate
      ? request.candidate.files.map(file => ({ path: file.path, type: "FILE" as const, sizeBytes: Buffer.byteLength(file.content) }))
      : await request.execution.listFiles(request.environmentId);
    for (const entry of entries) {
      if (entry.type !== "FILE") continue;
      if (!sourcePath.test(entry.path) || clean(entry.path) !== entry.path || entry.path.split("/").includes("..") || /(?:credential|secret|\.env)/i.test(entry.path) ||
          (entry.sizeBytes ?? Infinity) > FAILED_CANDIDATE_LIMITS.maxSourceFileBytes || Object.keys(files).length >= 128) { omittedFiles++; continue; }
      const content = request.candidate ? submitted.get(entry.path)! : await request.execution.readFile(request.environmentId, entry.path);
      if (Buffer.byteLength(content) > FAILED_CANDIDATE_LIMITS.maxSourceFileBytes || content.includes("\0")) { omittedFiles++; continue; }
      try { scanner.scan([{ path: entry.path, content }]); } catch { omittedFiles++; continue; }
      const sanitized = clean(content);
      sourceBytes += Buffer.byteLength(sanitized);
      if (sourceBytes > FAILED_CANDIDATE_LIMITS.maxBytes / 2) { omittedFiles++; continue; }
      files[entry.path] = sanitized;
      if (content !== sanitized) redactedFiles++;
    }
    const report = request.report;
    const evidence = {
      schemaVersion: 1, kind: "LOCAL_FAILED_CANDIDATE_DIAGNOSTIC", createdAt: new Date(this.now()).toISOString(),
      jobId: request.jobId, siteId: request.siteId, completion: request.completion,
      functionalRequirements: request.functionalRequirements, referenceContext: request.referenceContext,
      validation: request.validationFailure ?? { failureStage: "BROWSER_QA", buildPassed: true, reportStatus: report?.status },
      qa: report ? { summary: report.summary, routes: report.routes.slice(0, 50), viewports: report.viewports,
        checks: report.checks.slice(0, 256).map(check => ({ checkId: check.checkId, route: check.route, viewport: check.viewport,
          status: check.status, severity: check.severity, message: clean(check.message).slice(0, 1000),
          evidence: check.evidence?.filter(item => item.type === "element").slice(0, 30).map(item => ({
            type: item.type, locatorDescription: clean(item.locatorDescription).slice(0, 200), accessibleName: clean(item.accessibleName ?? "").slice(0, 200),
          })),
        })) } : undefined,
      source: { origin: request.candidate ? "submitted-candidate" : "execution-workspace", files, omittedFiles, redactedFiles, limitation: "Whitelisted text only; secret-bearing files omitted or redacted. Sanitized/partial source may not be rebuildable." },
    };
    const serialize = () => JSON.stringify(evidence, (_key, value: unknown) => typeof value === "string" ? clean(value) : value);
    let serialized = serialize();
    while (Buffer.byteLength(serialized) > FAILED_CANDIDATE_LIMITS.maxBytes && Object.keys(files).length) {
      delete files[Object.keys(files).at(-1)!]; evidence.source.omittedFiles++;
      serialized = serialize();
    }
    if (Buffer.byteLength(serialized) > FAILED_CANDIDATE_LIMITS.maxBytes) throw new Error("Diagnostic summary exceeds local bound");
    const name = `candidate-${createHash("sha256").update(request.jobId).digest("hex").slice(0, 32)}.json`;
    const diagnosticPath = join(this.root, name);
    const file = await open(diagnosticPath, "wx", 0o600);
    try { await file.writeFile(serialized, "utf8"); } finally { await file.close(); }
    if (omittedFiles || redactedFiles) console.warn("[sites] Candidate diagnostic source is partial/redacted; see private evidence summary");
    return diagnosticPath;
  }
}
