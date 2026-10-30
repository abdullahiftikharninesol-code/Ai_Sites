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
import type { BuildRepairEvidence } from "../../cli/runtime/build-repair-patch-resolver.js";

export interface FailedCandidateEvidenceRequest {
  readonly execution: Pick<ExecutionProvider, "listFiles" | "readFile">;
  readonly environmentId: string;
  readonly jobId: string;
  readonly siteId: string;
  readonly report?: BrowserQAReport;
  readonly candidate?: SiteCoderFileBundle;
  readonly validationFailure?: { readonly failureStage: "STATIC_VALIDATION" | "BUILD" | "PATCH_APPLICATION"; readonly code: string; readonly check: string; readonly message: string; readonly buildPassed: boolean };
  readonly patchDiagnostics?: unknown;
  readonly buildRepair?: BuildRepairEvidence;
  /** Whitelisted below; never serialize arbitrary error metadata. */
  readonly functionalContract?: unknown;
  readonly accounting?: { readonly model: string; readonly role: string; readonly logicalRequests: number; readonly physicalRequests: number; readonly billingStatus: "NOT_FINALIZED" };
  readonly outerRequestId?: string;
  readonly editAttempt?: number;
  readonly generationAttempt?: 1 | 2;
  readonly repairRequirements?: readonly string[];
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

function functionalContractSummary(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.slice(0, 64).filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const route = (value: unknown) => typeof value === "string" && /^\/(?!\/)[\w/.:#-]*$/.test(value) && value.length <= 512 ? value : undefined;
  const id = (value: unknown) => typeof value === "string" && /^[\w:-]{1,120}$/.test(value) ? value : undefined;
  const assessment = (value: unknown) => {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return { state: ["RECOGNIZED", "PROVEN_MISSING", "UNCERTAIN"].includes(String(record.state)) ? record.state : undefined,
      reason: ["STRUCTURAL_MATCH_REQUIRES_BEHAVIOR", "NO_POSSIBLE_RENDERED_CONTROL", "DYNAMIC_OR_CUSTOM_IMPLEMENTATION"].includes(String(record.reason)) ? record.reason : undefined };
  };
  const refs = (value: unknown) => list(value).slice(0, 8).map(ref => ({ path: typeof ref.path === "string" && sourcePath.test(ref.path) ? ref.path : undefined,
    line: typeof ref.line === "number" && Number.isSafeInteger(ref.line) && ref.line > 0 ? ref.line : undefined }));
  return { version: 1, pages: list(entry.pages).map(page => ({ id: id(page.id), route: route(page.route), sourceEvidence: refs(page.sourceEvidence) })),
    actualRoutes: Array.isArray(entry.actualRoutes) ? entry.actualRoutes.slice(0, 64).map(route).filter(Boolean) : [],
    requirements: list(entry.requirements).map(requirement => ({ id: id(requirement.id), capability: id(requirement.capability),
      routes: Array.isArray(requirement.routes) ? requirement.routes.slice(0, 64).map(route).filter(Boolean) : [], sourceEvidence: refs(requirement.sourceEvidence), sourceAssessment: assessment(requirement.sourceAssessment) })),
  };
}

function buildRepairSummary(value: BuildRepairEvidence | undefined, clean: (value: string) => string) {
  if (!value) return undefined;
  const digest = (input: string | undefined) => input && /^[a-f0-9]{64}$/.test(input) ? input : undefined;
  const code = (input: string) => /^[A-Z_]{1,64}$/.test(input) ? input : undefined;
  const scanner = new SiteArtifactSecurityScanner();
  const sourceText = (path: string, content: string): string | undefined => {
    if (Buffer.byteLength(content) > 32_000 || content.includes("\0")) return undefined;
    try { scanner.scan([{ path, content }]); } catch { return undefined; }
    return clean(content);
  };
  return {
    attempt: Number.isSafeInteger(value.attempt) && value.attempt > 0 ? value.attempt : undefined,
    kind: ["build", "navigation", "interaction", "functional"].includes(value.kind) ? value.kind : undefined,
    sourceRevision: digest(value.sourceRevision), currentSourceRevision: digest(value.currentSourceRevision), contextDigest: digest(value.contextDigest),
    initialDiagnostics: value.initialDiagnostics.slice(0, 8_000), billingState: value.billingState === "NOT_FINALIZED" ? value.billingState : undefined,
    result: code(value.result),
    requestSnapshot: value.requestSnapshot ? {
      revision: digest(value.requestSnapshot.revision), contextDigest: digest(value.requestSnapshot.contextDigest),
      context: sourceText("src/repair-context.ts", value.requestSnapshot.context),
      files: value.requestSnapshot.files.slice(0, 64).filter(file => sourcePath.test(file.path) && !file.path.split("/").includes("..")).map(file => ({
        path: file.path, digest: digest(file.digest), bytes: Buffer.byteLength(file.content),
        excerpts: file.excerpts.slice(0, 128).map(range => ({ start: range.start, end: range.end })),
      })),
    } : undefined,
    proposal: value.proposal ? { patches: value.proposal.patches.slice(0, 8).filter(patch => sourcePath.test(patch.path) && !patch.path.split("/").includes("..")).map(patch => ({
      path: patch.path, findDigest: createHash("sha256").update(patch.find).digest("hex"), replacementDigest: createHash("sha256").update(patch.replace).digest("hex"),
      find: sourceText(patch.path, patch.find), replace: sourceText(patch.path, patch.replace),
    })) } : undefined,
    patches: value.patches.slice(0, 8).map(patch => ({
      path: sourcePath.test(patch.path) && !patch.path.split("/").includes("..") ? patch.path : undefined,
      findDigest: digest(patch.findDigest), sourceDigest: digest(patch.sourceDigest), currentSourceDigest: digest(patch.currentSourceDigest),
      matchCount: Number.isSafeInteger(patch.matchCount) && patch.matchCount >= 0 ? patch.matchCount : undefined,
      resolution: code(patch.resolution), locations: patch.locations.slice(0, 64).map(location => ({
        offset: Number.isSafeInteger(location.offset) && location.offset >= 0 ? location.offset : undefined,
        line: Number.isSafeInteger(location.line) && location.line > 0 ? location.line : undefined,
        column: Number.isSafeInteger(location.column) && location.column > 0 ? location.column : undefined,
      })),
    })),
  };
}

/** Metadata only: never serialize arbitrary error metadata or patch/source strings. */
function patchDiagnosticSummary(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const choice = (value: unknown, allowed: readonly string[]) => typeof value === "string" && allowed.includes(value) ? value : undefined;
  const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  return value.slice(0, 8).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    return [{ path: typeof entry.path === "string" && sourcePath.test(entry.path) && !entry.path.split("/").includes("..") ? entry.path : undefined,
      findDigest: digest(entry.findDigest), replacementDigest: digest(entry.replacementDigest), matchCount: integer(entry.matchCount),
      requestedMode: choice(entry.requestedMode, ["unique", "all"]), rebased: entry.rebased === true,
      resolution: choice(entry.resolution, ["REJECTED_MISSING_ANCHOR", "REJECTED_CASCADE", "REJECTED_AMBIGUITY", "SCOPED_GLOBAL_RENAME", "SCOPED_CONTEXT", "EXACT_UNIQUE", "REBASED_UNIQUE", "REQUESTED_ALL"]),
      intendedOperation: choice(entry.intendedOperation, ["EXACT_PATCH", "GLOBAL_RENAME", "LOCAL_HEADING", "LOCAL_DESCRIPTION", "CSS_DECLARATION"]),
      reason: choice(entry.reason, ["EXACT_SOURCE_NOT_FOUND", "EARLIER_PATCH_INTRODUCED_MATCH", "NO_UNIQUE_AUTHORIZED_CONTEXT", "VERIFIED_EXACT_SCOPE"]),
      locations: Array.isArray(entry.locations) ? entry.locations.slice(0, 64).map((item: unknown) => {
        const location = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { offset: integer(location.offset), line: integer(location.line), column: integer(location.column) };
      }) : [],
    }];
  });
}

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
    const entries = request.patchDiagnostics ? [] : request.candidate
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
      ...(request.outerRequestId && /^[a-f0-9-]{36}$/i.test(request.outerRequestId) ? { outerRequestId: request.outerRequestId } : {}),
      ...(request.editAttempt === 1 || request.editAttempt === 2 ? { editAttempt: request.editAttempt } : {}),
      ...(request.generationAttempt ? { generationAttempt: request.generationAttempt } : {}),
      ...(request.repairRequirements ? { repairRequirements: request.repairRequirements.filter(value => value === "rename" || value === "style").slice(0, 2) } : {}),
      functionalRequirements: request.functionalRequirements, referenceContext: request.referenceContext,
      validation: request.validationFailure ?? { failureStage: "BROWSER_QA", buildPassed: true, reportStatus: report?.status },
      patchDiagnostics: patchDiagnosticSummary(request.patchDiagnostics),
      buildRepair: buildRepairSummary(request.buildRepair, clean),
      functionalContract: functionalContractSummary(request.functionalContract),
      accounting: request.accounting ? { model: clean(request.accounting.model).slice(0, 80), role: request.accounting.role,
        logicalRequests: request.accounting.logicalRequests, physicalRequests: request.accounting.physicalRequests, billingStatus: request.accounting.billingStatus } : undefined,
      qa: report ? { summary: report.summary, routes: report.routes.slice(0, 50), viewports: report.viewports,
        checks: [...report.checks.filter(check => check.status === "FAIL"), ...report.checks.filter(check => check.status !== "FAIL")].slice(0, 256).map(check => ({ checkId: check.checkId, route: check.route, viewport: check.viewport,
          status: check.status, severity: check.severity, failureKind: check.failureKind, message: clean(check.message).slice(0, 2000),
          functionalProbes: check.functionalProbes?.slice(0, 64).map(probe => ({ requirementId: probe.requirementId, capability: probe.capability,
            expectedRoute: probe.expectedRoute, actualRoute: probe.actualRoute, result: probe.result, sourceAssessment: probe.sourceAssessment })),
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
    // Keep the original candidate and at most one repaired candidate. Existing
    // global count/age/byte bounds still apply; these are private diagnostics.
    const identity = request.generationAttempt === 2 ? request.jobId + ":generation-repair" : request.jobId;
    const name = `candidate-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}.json`;
    const diagnosticPath = join(this.root, name);
    let file;
    try { file = await open(diagnosticPath, "wx", 0o600); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return diagnosticPath;
      throw error;
    }
    try { await file.writeFile(serialized, "utf8"); } finally { await file.close(); }
    if (omittedFiles || redactedFiles) console.warn("[sites] Candidate diagnostic source is partial/redacted; see private evidence summary");
    return diagnosticPath;
  }
}
