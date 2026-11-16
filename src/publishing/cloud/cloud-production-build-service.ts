import { randomUUID } from "node:crypto";
import { PublishingError, type PublishingErrorCode } from "../publishing-errors.js";
import {
  loadProductionBuildLimits,
  verifyPublishableSource,
  type ProductionBuildInput,
  type ProductionBuildLimits,
  type ProductionBuildResult,
} from "../production-build-service.js";
import { analyzeSiteRouting, staticHostingConfig, validateArtifactPath, validateStaticArtifact, type StaticFile } from "../static-artifact.js";
import type { CloudBuildConfig } from "./cloud-build-config.js";
import { CloudTransferTooLargeError, type CloudExecutionStatus, type CloudRunJobsApi, type TransferStore } from "./cloud-build-gcp.js";
import type { CloudBuildLedger, CloudBuildStatus, CloudIsolationAttestation } from "./cloud-build-ledger.js";
import {
  BUILD_REQUEST_SCHEMA,
  BUILD_RESULT_SCHEMA,
  PROBE_REPORT_SCHEMA,
  WORKER_FAILURE_CODES,
  maxResultBytes,
  selfCheckViolations,
  sha256Hex,
  type CloudBuildLimits,
  type CloudBuildRequest,
} from "./cloud-build-protocol.js";
import type { CloudIsolationVerifier } from "./cloud-isolation-verifier.js";

const DAY_MS = 24 * 60 * 60_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Coordinator-controlled messages; the worker's text is never shown to users. */
const MESSAGES: Readonly<Record<string, string>> = {
  PUBLISH_SOURCE_INVALID: "The saved source failed verification in the isolated build.",
  PUBLISH_DEPENDENCY_INSTALL_FAILED: "Installing the site's locked dependencies failed.",
  PUBLISH_BUILD_FAILED: "The production build failed. The saved version was not changed.",
  PUBLISH_BUILD_TIMEOUT: "The production build timed out. The saved version was not changed.",
  PUBLISH_ARTIFACT_INVALID: "The production build produced output that failed verification.",
  PUBLISH_ISOLATION_UNAVAILABLE: "The isolated build environment could not be verified, so nothing was built for publishing.",
  PUBLISH_BUILD_WORKER_FAILED: "The isolated build worker stopped before finishing. Try again.",
};
const failure = (code: PublishingErrorCode, metadata?: Record<string, unknown>) =>
  new PublishingError(code, MESSAGES[code] ?? "Publishing preparation failed.", metadata ? { metadata } : {});

export interface CloudProductionBuildOptions {
  readonly config: CloudBuildConfig;
  readonly jobs: CloudRunJobsApi;
  readonly transfer: TransferStore;
  readonly ledger: CloudBuildLedger;
  readonly verifier: Pick<CloudIsolationVerifier, "assertVerified" | "inspect" | "invalidate">;
  readonly limits?: ProductionBuildLimits;
  readonly maxConcurrent?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Builds a verified snapshot in a dedicated Cloud Run job execution whose
 * worker runs dependency install and the Vite build inside Cloud Run
 * sandboxes (no network, no metadata credentials, no inherited environment).
 * This process only: verifies the source, uploads an immutable request,
 * signs two single-object URLs, runs and tracks the execution, and validates
 * everything that comes back (paths, sizes, per-file SHA-256, the in-sandbox
 * isolation self-check, the execution's own sandbox/image/identity) before
 * returning the same result shape as the local builder. No generated code
 * runs on this host; nothing is retried automatically.
 */
export class CloudProductionBuildService {
  readonly #o: CloudProductionBuildOptions;
  readonly #limits: ProductionBuildLimits;
  readonly #inFlight = new Map<string, string | undefined>();
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #closed = false;

  constructor(options: CloudProductionBuildOptions) {
    this.#o = options;
    this.#limits = options.limits ?? loadProductionBuildLimits();
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get activeBuilds() {
    return this.#inFlight.size;
  }

  async build(input: ProductionBuildInput & { readonly ownerId?: string }): Promise<ProductionBuildResult> {
    const started = Date.now();
    if (this.#closed) throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Publishing preparation is shutting down.");
    const ownerId = input.ownerId;
    if (!ownerId) throw new PublishingError("PUBLISH_PREPARATION_FAILED", "A cloud build requires the site owner.");
    // Re-checked per build (cached briefly): never submit untrusted code to an unverified environment.
    await this.#o.verifier.assertVerified();
    const snapshot = await verifyPublishableSource(input);
    const { mode: routing, routes } = analyzeSiteRouting(
      Object.fromEntries(snapshot.manifest.files.filter((file) => !file.encoding).map((file) => [file.path, snapshot.files[file.path]!])),
    );
    const sourceSha256 = sha256Hex(input.sourceBytes);
    const { config, ledger } = this.#o;
    if ((await ledger.countOwnerBuildsSince(ownerId, new Date(this.#now().getTime() - DAY_MS))) >= config.dailyBuildsPerOwner)
      throw new PublishingError("PUBLISH_BUILD_QUOTA_EXCEEDED", "You've reached today's limit of publishing builds. Try again tomorrow.");
    if (this.#inFlight.size >= (this.#o.maxConcurrent ?? 2))
      throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Other sites are being built right now. Try again in a minute.");
    // An interrupted earlier attempt for this exact source must not keep running.
    for (const stale of await ledger.findUnfinished(input.siteId, sourceSha256)) await this.#cancel(stale.buildId, stale.executionId, "CANCELLED");

    const buildId = randomUUID();
    this.#inFlight.set(buildId, undefined);
    const limits = this.#cloudLimits();
    const request: CloudBuildRequest = {
      schema: BUILD_REQUEST_SCHEMA, buildId, siteId: input.siteId, versionId: input.versionId,
      sourceArtifactRef: input.sourceArtifactRef, sourceSha256, sourceBase64: Buffer.from(input.sourceBytes).toString("base64"),
      limits, createdAt: this.#now().toISOString(),
    };
    const requestBytes = Buffer.from(JSON.stringify(request));
    const requestSha256 = sha256Hex(requestBytes);
    const requestObject = `builds/${buildId}/request.json`;
    const resultObject = `builds/${buildId}/result.json`;
    const now = this.#now();
    await ledger.insertBuild({ buildId, ownerId, siteId: input.siteId, versionId: input.versionId, sourceSha256, requestSha256, requestObject, resultObject, status: "SUBMITTED", createdAt: now, updatedAt: now });
    let status: CloudBuildStatus = "FAILED";
    let failureCode: string | undefined;
    try {
      await this.#o.transfer.putObject(requestObject, requestBytes, "application/json");
      const resultMaxBytes = maxResultBytes(limits);
      const execution = await this.#execute(buildId, [
        { name: "SITES_BUILD_ID", value: buildId },
        { name: "SITES_BUILD_REQUEST_URL", value: await this.#o.transfer.signedReadUrl(requestObject, this.#urlExpiry()) },
        { name: "SITES_BUILD_REQUEST_SHA256", value: requestSha256 },
        { name: "SITES_BUILD_RESULT_URL", value: await this.#o.transfer.signedWriteUrl(resultObject, resultMaxBytes, this.#urlExpiry()) },
        { name: "SITES_BUILD_RESULT_MAX_BYTES", value: String(resultMaxBytes) },
      ], ["build"]);
      const bytes = await this.#readResult(resultObject, resultMaxBytes);
      if (execution.state !== "SUCCEEDED" || !bytes) throw failure("PUBLISH_BUILD_WORKER_FAILED", { executionState: execution.state, resultReceived: !!bytes });
      const { files, metrics } = this.#parseResult(bytes, { buildId, requestSha256, limits });
      const summary = validateStaticArtifact(files, routing);
      status = "SUCCEEDED";
      return {
        files, generated: [staticHostingConfig(routing)], routing, routes, summary,
        metrics: { ...metrics, totalMs: Date.now() - started },
      };
    } catch (error) {
      failureCode = error instanceof PublishingError ? error.code : "PUBLISH_BUILD_WORKER_FAILED";
      if (failureCode === "PUBLISH_BUILD_TIMEOUT") status = "CANCELLED";
      throw error instanceof PublishingError ? error : failure("PUBLISH_BUILD_WORKER_FAILED");
    } finally {
      this.#inFlight.delete(buildId);
      const end = this.#now();
      // Transfer objects are never the canonical artifact; they may be removed once the build is terminal.
      await ledger.updateBuild(buildId, { status, ...(failureCode ? { failureCode } : {}), completedAt: end, updatedAt: end, transferDeletableAfter: end }).catch(() => undefined);
    }
  }

  /**
   * Runs the pinned worker in probe mode (no tenant data) and records whether
   * the sandbox actually blocked the metadata server, egress, the worker's
   * environment and writes. Required before cloud builds are allowed.
   */
  async attest(): Promise<CloudIsolationAttestation> {
    const { violations, configHash } = await this.#o.verifier.inspect();
    if (violations.length)
      throw new PublishingError("PUBLISH_ISOLATION_UNAVAILABLE", "The cloud build job does not meet the isolation requirements.", { metadata: { violations } });
    const probeId = randomUUID();
    const reportObject = `probes/${probeId}/report.json`;
    const maxBytes = 65_536;
    const execution = await this.#execute(probeId, [
      { name: "SITES_BUILD_ID", value: probeId },
      { name: "SITES_BUILD_RESULT_URL", value: await this.#o.transfer.signedWriteUrl(reportObject, maxBytes, this.#urlExpiry()) },
      { name: "SITES_BUILD_RESULT_MAX_BYTES", value: String(maxBytes) },
    ], ["probe"]).catch((error: unknown) => {
      // An execution Cloud Run reports as unsandboxed is a failed probe, not a crash.
      if (error instanceof PublishingError && error.code === "PUBLISH_ISOLATION_UNAVAILABLE") return undefined;
      throw error;
    });
    const found: string[] = [];
    const bytes = await this.#readResult(reportObject, maxBytes).catch(() => undefined);
    if (!execution) found.push("the probe execution did not run with the sandbox launcher, pinned image and worker identity");
    else if (execution.state !== "SUCCEEDED") found.push(`the probe execution ended ${execution.state}`);
    if (!bytes) found.push("the probe report was not received");
    else {
      try {
        const report = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
        const isolation = (report.isolation ?? {}) as Record<string, unknown>;
        if (report.schema !== PROBE_REPORT_SCHEMA || report.probeId !== probeId || isolation.sandbox !== true) found.push("the probe report is malformed");
        else found.push(...selfCheckViolations(isolation.checks));
      } catch {
        found.push("the probe report is not valid JSON");
      }
    }
    const attestation: CloudIsolationAttestation = {
      attestationId: probeId, configHash, image: this.#o.config.image, executionId: execution?.executionId ?? "unknown",
      passed: found.length === 0, violations: found.slice(0, 20), createdAt: this.#now(),
    };
    await this.#o.ledger.saveAttestation(attestation);
    this.#o.verifier.invalidate();
    return attestation;
  }

  /** Cancels running executions (server shutdown). */
  async cancelAll(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#inFlight.entries()].map(([buildId, executionId]) => this.#cancel(buildId, executionId, "CANCELLED")));
  }

  // -------------------------------------------------------------------------

  #cloudLimits(): CloudBuildLimits {
    return {
      installTimeoutMs: this.#limits.installTimeoutMs, buildTimeoutMs: this.#limits.buildTimeoutMs, memoryMb: this.#limits.memoryMb,
      output: this.#limits.output, maxDependencies: 3_000, maxDependencyBytes: 400 * 1024 * 1024,
    };
  }

  /** Signed URLs live only as long as one execution can (plus queueing margin). */
  #urlExpiry() {
    return new Date(this.#now().getTime() + (this.#o.config.taskTimeoutSeconds + 300) * 1_000);
  }

  async #execute(id: string, env: { name: string; value: string }[], args: string[]): Promise<CloudExecutionStatus> {
    const { config, jobs, ledger } = this.#o;
    const { executionId } = await jobs.runJob({ env, args, timeoutSeconds: config.taskTimeoutSeconds });
    if (this.#inFlight.has(id)) this.#inFlight.set(id, executionId);
    await ledger.updateBuild(id, { status: "RUNNING", executionId, updatedAt: this.#now() }).catch(() => undefined);
    // The coordinator gives up slightly after Cloud Run's own task timeout, then cancels.
    const deadline = this.#now().getTime() + (config.taskTimeoutSeconds + 120) * 1_000;
    let errors = 0;
    let execution: CloudExecutionStatus;
    for (;;) {
      try {
        execution = await jobs.getExecution(executionId);
        errors = 0;
      } catch {
        if (++errors >= 3) {
          await this.#cancel(id, executionId, "FAILED");
          throw failure("PUBLISH_BUILD_WORKER_FAILED", { reason: "execution status unavailable" });
        }
        await this.#sleep(config.pollIntervalMs);
        continue;
      }
      if (execution.state !== "RUNNING") break;
      if (this.#now().getTime() >= deadline || this.#closed) {
        await this.#cancel(id, executionId, "CANCELLED");
        throw failure("PUBLISH_BUILD_TIMEOUT", { stage: "CLOUD", executionId });
      }
      await this.#sleep(config.pollIntervalMs);
    }
    // What actually ran, from Cloud Run itself: never accept output from anything else.
    if (!execution.sandboxLauncher || execution.image !== config.image || execution.serviceAccount !== config.workerServiceAccount) {
      this.#o.verifier.invalidate();
      throw failure("PUBLISH_ISOLATION_UNAVAILABLE", { reason: "the execution did not run in the verified isolated configuration" });
    }
    if (execution.state === "CANCELLED") throw failure("PUBLISH_BUILD_TIMEOUT", { stage: "CLOUD", executionId });
    return execution;
  }

  async #readResult(object: string, maxBytes: number): Promise<Uint8Array | undefined> {
    try {
      return await this.#o.transfer.readObject(object, maxBytes);
    } catch (error) {
      if (error instanceof CloudTransferTooLargeError) throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "result too large" });
      throw failure("PUBLISH_BUILD_WORKER_FAILED", { reason: "result transfer failed" });
    }
  }

  async #cancel(buildId: string, executionId: string | undefined, status: CloudBuildStatus) {
    if (executionId) await this.#o.jobs.cancelExecution(executionId).catch(() => undefined);
    await this.#o.ledger.updateBuild(buildId, { status, updatedAt: this.#now(), completedAt: this.#now(), transferDeletableAfter: this.#now() }).catch(() => undefined);
  }

  /** Validates an untrusted result document and returns its files. */
  #parseResult(bytes: Uint8Array, expected: { buildId: string; requestSha256: string; limits: CloudBuildLimits }): { files: StaticFile[]; metrics: { installMs: number; buildMs: number } } {
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "result is not JSON" });
    }
    if (result.schema !== BUILD_RESULT_SCHEMA || result.buildId !== expected.buildId || result.requestSha256 !== expected.requestSha256)
      throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "result does not belong to this build request" });
    const isolation = (result.isolation ?? {}) as Record<string, unknown>;
    const violations = isolation.sandbox === true ? selfCheckViolations(isolation.checks) : ["sandbox:missing"];
    if (violations.length) {
      this.#o.verifier.invalidate();
      throw failure("PUBLISH_ISOLATION_UNAVAILABLE", { violations: violations.slice(0, 6) });
    }
    const outcome = (result.outcome ?? {}) as Record<string, unknown>;
    if (outcome.status === "FAILED") {
      const code = typeof outcome.code === "string" && WORKER_FAILURE_CODES.has(outcome.code) ? (outcome.code as PublishingErrorCode) : "PUBLISH_BUILD_WORKER_FAILED";
      const log = typeof outcome.log === "string" ? outcome.log.slice(0, 2_000) : undefined;
      const stage = typeof outcome.stage === "string" ? outcome.stage.slice(0, 32) : undefined;
      throw failure(code, { ...(stage ? { stage } : {}), ...(log ? { log } : {}) });
    }
    if (outcome.status !== "SUCCEEDED" || !Array.isArray(outcome.files)) throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "result has no files" });
    const { output } = expected.limits;
    if (outcome.files.length > output.maxFiles) throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "too many files" });
    const seen = new Set<string>();
    let total = 0;
    const files: StaticFile[] = [];
    for (const entry of outcome.files as Record<string, unknown>[]) {
      const path = typeof entry?.path === "string" ? entry.path : "";
      validateArtifactPath(path);
      if (path.split("/").length > output.maxDepth + 1 || seen.has(path)) throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "duplicate or deep path", path: path.slice(0, 200) });
      seen.add(path);
      if (typeof entry.contentBase64 !== "string" || !BASE64.test(entry.contentBase64) || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256))
        throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "malformed file entry", path });
      const content = Buffer.from(entry.contentBase64, "base64");
      if (content.length !== entry.sizeBytes || content.length > output.maxFileBytes || sha256Hex(content) !== entry.sha256)
        throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "file size or SHA-256 mismatch", path });
      total += content.length;
      if (total > output.maxTotalBytes) throw failure("PUBLISH_ARTIFACT_INVALID", { reason: "output too large" });
      files.push({ path, content });
    }
    const metrics = (outcome.metrics ?? {}) as Record<string, unknown>;
    const metric = (key: string) => {
      const value = metrics[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
    };
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), metrics: { installMs: metric("installMs"), buildMs: metric("buildMs") } };
  }
}
