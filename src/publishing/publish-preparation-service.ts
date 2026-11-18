import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { SiteProject, SiteVersion } from "../sites/domain/entities.js";
import type { SiteId, VersionId } from "../shared/types.js";
import { VercelIntegrationError, type VercelConnectionService } from "../integrations/vercel/vercel-connection-service.js";
import type { LinkedVercelProject } from "../integrations/vercel/vercel-project-provider.js";
import { PublishingError, boundedMetadata } from "./publishing-errors.js";
import {
  DiagnosticThrottle,
  emitDiagnostic,
  resolveDiagnosticsSink,
  resources,
  type AdmissionRejectReason,
  type PublishDiagnosticsSink,
} from "./publish-diagnostics.js";
import type { ProductionBuildResult, ProductionBuildInput } from "./production-build-service.js";
import { verifyPublishableSource } from "./production-build-service.js";
import {
  HOSTING_CONFIG_VERSION,
  parsePreparedArtifact,
  serializePreparedArtifact,
  type PreparedArtifactDocument,
} from "./static-artifact.js";
import type {
  PublishPreparationArtifact,
  PublishPreparationFailure,
  PublishPreparationProject,
  PublishPreparationRecord,
  PublishPreparationRepository,
} from "./publish-preparation-repository.js";

/**
 * Which sites may run a production build. Builds execute the site's locked
 * dependencies and the Vite toolchain:
 *   - local (non-isolated) builds: only explicitly trusted (test) sites;
 *     an empty trusted set allows nothing;
 *   - verified cloud builds: any owner's eligible site, but only while the
 *     isolation verifier proves the live environment (job, IAM, probe) is
 *     isolated. A provider's own claim of isolation is never enough.
 * Required, so a caller cannot forget it.
 */
export type PublishBuildAccess =
  | { readonly isolatedExecution: false; readonly trustedSiteIds: ReadonlySet<string> }
  | { readonly isolatedExecution: "verified-cloud"; readonly isolation: { assertVerified(): Promise<unknown> } };

const TRUSTED_SITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Local build access. Fails closed: SITES_PUBLISH_TRUSTED_SITE_IDS unset
 * trusts no site. An execution provider reporting `secureIsolation` (a
 * self-description, e.g. a remote sandbox) does NOT unlock untrusted sites:
 * only the verified cloud build path does (Stage 5A).
 */
export function loadPublishBuildAccess(
  execution: { getCapabilities?(): { readonly secureIsolation?: boolean } },
  env: NodeJS.ProcessEnv = process.env,
): PublishBuildAccess {
  if (execution.getCapabilities?.().secureIsolation === true)
    console.warn("[sites][publish] the execution provider reports secure isolation; publishing builds still require trusted site IDs or verified cloud builds");
  const trustedSiteIds = new Set(
    (env.SITES_PUBLISH_TRUSTED_SITE_IDS ?? "").split(",").map((id) => id.trim()).filter((id) => TRUSTED_SITE_ID.test(id)),
  );
  return { isolatedExecution: false, trustedSiteIds };
}

export interface PublishPreparationServiceOptions {
  readonly buildAccess: PublishBuildAccess;
  readonly repository: PublishPreparationRepository;
  readonly projects: { getOwnedById(id: SiteId, ownerId: string): Promise<SiteProject | undefined> };
  readonly versions: { getById(id: VersionId, ownerId?: string): Promise<SiteVersion | undefined> };
  readonly artifacts: ArtifactStore;
  readonly builder: { build(input: ProductionBuildInput): Promise<ProductionBuildResult>; cancelAll?(): Promise<void> };
  readonly connections: Pick<VercelConnectionService, "credentials">;
  readonly projectProvider?: { ensureProject(ownerId: string, siteId: string): Promise<LinkedVercelProject> };
  /** Creates/reuses the Vercel project during preparation. Off unless VERCEL_PROJECT_LINKING_ENABLED=true. */
  readonly linkProjects?: boolean;
  readonly maxConcurrent?: number;
  readonly maxAttempts?: number;
  /** How long an attempt owns a preparation before another request may take it over. */
  readonly leaseMs?: number;
  /** How long a READY artifact may be consumed for deployment. */
  readonly readyTtlMs?: number;
  readonly now?: () => Date;
  /** Structured diagnostics (default: console JSON lines; false disables). See publish-diagnostics.ts. */
  readonly diagnostics?: PublishDiagnosticsSink | false;
}

/** What the browser sees: no artifact location, token, workspace path or public URL. */
export interface PublishPreparationView {
  readonly preparationId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly status: PublishPreparationRecord["status"] | "EXPIRED";
  /** Always false in Stage 2: a prepared build is not a live site. */
  readonly published: false;
  readonly isCurrentVersion?: boolean;
  readonly attempt: number;
  readonly artifact?: { readonly fileCount: number; readonly totalBytes: number; readonly routing: string; readonly sha256: string };
  readonly project: PublishPreparationProject;
  readonly failure?: PublishPreparationFailure;
  readonly metrics?: PublishPreparationRecord["metrics"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly expiresAt?: string;
}

const siteNotFound = () => Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });

const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
};

/**
 * Prepares a verified site version for publishing: authenticated owner →
 * owned site → its current verified version → intact source snapshot →
 * separate-workspace production build → validated static artifact bound to that exact
 * version (by version ID, source ref and source SHA-256).
 *
 * Idempotent per (owner, site, version, source digest, Vercel installation):
 * concurrent or repeated requests share one record and at most one build.
 * Preparation never deploys, never marks a site published, never calls an
 * AI provider and never touches credits.
 */
export class PublishPreparationService {
  readonly #options: PublishPreparationServiceOptions;
  readonly #running = new Map<string, Promise<void>>();
  /** Slots reserved by admissions awaiting their insert/claim, keyed by idempotency key. */
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #now: () => Date;
  readonly #maxConcurrent: number;
  readonly #maxAttempts: number;
  readonly #leaseMs: number;
  readonly #readyTtlMs: number;
  readonly #linkProjects: boolean;
  readonly #diagnostics: PublishDiagnosticsSink;
  readonly #rejections = new DiagnosticThrottle();
  #closed = false;

  constructor(options: PublishPreparationServiceOptions) {
    this.#options = options;
    this.#diagnostics = resolveDiagnosticsSink(options.diagnostics);
    this.#now = options.now ?? (() => new Date());
    this.#maxConcurrent = options.maxConcurrent ?? intEnv("SITES_PUBLISH_MAX_CONCURRENT", 1, 1, 4);
    this.#maxAttempts = options.maxAttempts ?? 5;
    // Longer than the maximum configurable install + build timeouts plus project linking.
    this.#leaseMs = options.leaseMs ?? 30 * 60_000;
    this.#readyTtlMs = options.readyTtlMs ?? 24 * 60 * 60_000;
    this.#linkProjects = options.linkProjects ?? process.env.VERCEL_PROJECT_LINKING_ENABLED === "true";
    if (this.#linkProjects && !options.projectProvider)
      throw new Error("Vercel project linking requires a project provider");
  }

  /** Number of builds this process is running (bounded by maxConcurrent). */
  get activeBuilds(): number {
    return this.#running.size;
  }

  async prepare(ownerId: string, siteId: string, versionId: string): Promise<PublishPreparationView> {
    if (this.#closed) throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Publishing preparation is shutting down.");
    const { project, version } = await this.#currentVersion(ownerId, siteId, versionId);
    // After ownership (a foreign site stays a 404), before credentials, source reads or any build.
    const access = this.#options.buildAccess;
    // Verified cloud isolation is checked live (cached briefly) and fails closed.
    if (access.isolatedExecution === "verified-cloud") await access.isolation.assertVerified();
    else if (!access.trustedSiteIds.has(project.id))
      throw new PublishingError(
        "PUBLISH_SITE_NOT_TRUSTED",
        "Publishing builds on this server are limited to trusted test sites until isolated build execution is available.",
      );
    const credentials = await this.#connection(ownerId);
    const connection = { configurationId: credentials.configurationId, teamId: credentials.teamId, vercelUserId: credentials.vercelUserId };

    // Pin the exact source bytes; everything downstream is bound to their digest.
    const sourceBytes = await this.#options.artifacts.get(version.sourceArtifactRef);
    if (!sourceBytes)
      throw new PublishingError("PUBLISH_SOURCE_UNAVAILABLE", "The saved source for this version is missing. The site cannot be published until it is saved again.");
    await verifyPublishableSource({ sourceArtifactRef: version.sourceArtifactRef, sourceBytes });
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const idempotencyKey = createHash("sha256")
      .update(JSON.stringify(["vercel", ownerId, project.id, version.id, sourceSha256, connection.configurationId, `hosting-${HOSTING_CONFIG_VERSION}`]))
      .digest("hex");
    const input = { ownerId, siteId: project.id, versionId: version.id, sourceArtifactRef: version.sourceArtifactRef, sourceBytes, sourceSha256 };

    let record = await this.#options.repository.findByKey(idempotencyKey);
    // An identical request is mid-admission: share its record instead of competing for a slot.
    for (let pending = this.#admissions.get(idempotencyKey); pending; pending = this.#admissions.get(idempotencyKey)) {
      await pending;
      record = await this.#options.repository.findByKey(idempotencyKey);
    }
    // From here to each reservation there is no await, so admission is atomic within this process.
    if (!record) {
      const release = this.#reserve(idempotencyKey);
      const now = this.#now();
      const fresh: PublishPreparationRecord = {
        preparationId: randomUUID(),
        idempotencyKey,
        provider: "vercel",
        ownerId,
        siteId: project.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
        sourceArtifactRef: version.sourceArtifactRef,
        sourceSha256,
        connection,
        status: "PREPARING",
        attempt: 1,
        leaseExpiresAt: new Date(now.getTime() + this.#leaseMs),
        createdAt: now,
        updatedAt: now,
      };
      let inserted = false;
      try {
        inserted = await this.#options.repository.insert(fresh);
        // Started before the reservation is released, so the slot is never briefly free.
        if (inserted) this.#start(fresh, input);
      } finally {
        release();
      }
      if (inserted) return this.#view(fresh, project);
      record = await this.#options.repository.findByKey(idempotencyKey);
      if (!record) throw new PublishingError("PUBLISH_PREPARATION_FAILED", "Publishing preparation could not be recorded.");
    }
    if (this.#running.has(record.preparationId) || !this.#claimable(record)) return this.#view(record, project);
    const release = this.#reserve(idempotencyKey);
    let claimed: PublishPreparationRecord | undefined;
    try {
      const now = this.#now();
      claimed = await this.#options.repository.claim(idempotencyKey, {
        now,
        leaseExpiresAt: new Date(now.getTime() + this.#leaseMs),
        maxAttempts: this.#maxAttempts,
        connection,
      });
      if (claimed) this.#start(claimed, input);
    } finally {
      release();
    }
    if (!claimed) return this.#view((await this.#options.repository.findByKey(idempotencyKey)) ?? record, project);
    return this.#view(claimed, project);
  }

  /** Latest preparation for an owned site (404 for another owner's site). */
  async latest(ownerId: string, siteId: string): Promise<PublishPreparationView | undefined> {
    const project = await this.#ownedProject(ownerId, siteId);
    const record = await this.#options.repository.findLatestForSite(ownerId, project.id);
    return record ? this.#view(record, project) : undefined;
  }

  /**
   * Stage 3 entry point: the verified artifact of a READY, unexpired
   * preparation whose version is still the site's current one, with the saved
   * source unchanged since it was built. Anything else is refused.
   */
  async loadReadyArtifact(ownerId: string, preparationId: string): Promise<{ readonly record: PublishPreparationRecord; readonly artifact: PreparedArtifactDocument }> {
    const record = await this.#options.repository.findOwned(ownerId, preparationId);
    if (!record) throw new PublishingError("PUBLISH_PREPARATION_NOT_FOUND", "Publishing preparation not found");
    if (record.status !== "READY_TO_DEPLOY" || !record.artifact || (record.expiresAt && record.expiresAt <= this.#now()))
      throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "This site has no ready production build. Prepare it again.");
    const project = await this.#ownedProject(ownerId, record.siteId);
    const version = await this.#options.versions.getById(record.versionId as VersionId, ownerId);
    if (project.latestVersionId !== record.versionId || !version || version.sourceArtifactRef !== record.sourceArtifactRef)
      throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "The site changed after this build was prepared. Prepare it again.");
    const source = await this.#options.artifacts.get(record.sourceArtifactRef);
    if (!source || createHash("sha256").update(source).digest("hex") !== record.sourceSha256)
      throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "The saved source changed after this build was prepared. Prepare it again.");
    const artifact = parsePreparedArtifact(await this.#options.artifacts.get(record.artifact.ref), {
      sha256: record.artifact.sha256, siteId: record.siteId, versionId: record.versionId, sourceSha256: record.sourceSha256,
    });
    return { record, artifact };
  }

  /** Stops accepting work and waits for running builds (their workspaces are always destroyed). */
  async close(): Promise<void> {
    this.#closed = true;
    // An admission already past its reservation starts its build (or not) before cancellation.
    await Promise.allSettled([...this.#admissions.values()]);
    // Remote builds are cancelled rather than left running past shutdown.
    await this.#options.builder.cancelAll?.().catch(() => undefined);
    await Promise.allSettled([...this.#running.values()]);
  }

  #claimable(record: PublishPreparationRecord): boolean {
    const now = this.#now();
    if (record.status === "READY_TO_DEPLOY") return !!record.expiresAt && record.expiresAt <= now;
    if (record.attempt >= this.#maxAttempts) return false;
    if (record.status === "PREPARING") return !!record.leaseExpiresAt && record.leaseExpiresAt <= now;
    return record.failure?.retryable === true;
  }

  /**
   * Synchronously takes a build slot for an admission still awaiting its
   * insert/claim, so concurrent requests cannot all pass the limit. The
   * returned release is idempotent and must run in a finally block.
   */
  #reserve(key: string): () => void {
    if (this.#closed) {
      this.#rejected("CLOSED");
      throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Publishing preparation is shutting down.");
    }
    if (this.#admissions.has(key) || this.#running.size + this.#admissions.size >= this.#maxConcurrent) {
      this.#rejected(this.#admissions.has(key) ? "DUPLICATE" : "CAPACITY");
      throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Other sites are being prepared for publishing right now. Try again in a minute.");
    }
    let settle!: () => void;
    const admission = new Promise<void>((resolve) => (settle = resolve));
    this.#admissions.set(key, admission);
    return () => {
      if (this.#admissions.get(key) === admission) this.#admissions.delete(key);
      settle();
    };
  }

  /** Throttled: at most one event per reason per minute, carrying the count dropped meanwhile. */
  #rejected(reason: AdmissionRejectReason) {
    const suppressed = this.#rejections.admit(reason);
    if (suppressed === undefined) return;
    emitDiagnostic(this.#diagnostics, {
      event: "build_admission_rejected", reason, active: this.#running.size, admitting: this.#admissions.size, maxConcurrent: this.#maxConcurrent,
      ...(suppressed ? { suppressed } : {}),
    });
  }

  #start(record: PublishPreparationRecord, input: ProductionBuildInput & { ownerId: string; sourceSha256: string }) {
    const job = this.#run(record, input)
      .catch((error: unknown) =>
        console.error("[sites][publish] preparation bookkeeping failed", { preparationId: record.preparationId, name: (error as Error)?.name }),
      )
      .finally(() => this.#running.delete(record.preparationId));
    this.#running.set(record.preparationId, job);
  }

  async #run(record: PublishPreparationRecord, input: ProductionBuildInput & { ownerId: string; sourceSha256: string }) {
    const { preparationId, attempt } = record;
    let project: PublishPreparationProject = { status: "NOT_LINKED" };
    const started = Date.now();
    let stage = "BUILD";
    let reused = false;
    let metrics: PublishPreparationRecord["metrics"];
    const finished = (outcome: "READY" | "FAILED", failure?: PublishPreparationFailure) => {
      const meta = failure?.metadata;
      emitDiagnostic(this.#diagnostics, {
        event: "build_finished", preparationId, siteId: input.siteId, attempt, outcome, stage,
        ...(typeof meta?.stage === "string" ? { buildStage: meta.stage } : {}),
        ...(typeof meta?.exitCode === "number" ? { exitCode: meta.exitCode } : {}),
        ...(failure ? { code: failure.code, retryable: failure.retryable } : {}),
        reused, durationMs: Date.now() - started,
        ...(metrics ? { installMs: metrics.installMs, buildMs: metrics.buildMs } : {}),
        active: this.#running.size, maxConcurrent: this.#maxConcurrent,
        ...resources(),
      });
    };
    try {
      const existing = await this.#reusableArtifact(record);
      reused = !!existing;
      let artifact = existing;
      if (!artifact) ({ artifact, metrics } = await this.#buildArtifact(record, input, () => (stage = "ARTIFACT")));
      await this.#assertPreparationCurrent(record);
      stage = "LINK";
      if (this.#linkProjects) {
        const linked = await this.#options.projectProvider!.ensureProject(input.ownerId, input.siteId);
        if (linked.configurationId !== record.connection.configurationId || linked.accountId !== (record.connection.teamId ?? record.connection.vercelUserId))
          throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "The Vercel account changed during preparation. Prepare again using the intended account.");
        project = { status: "LINKED", projectId: linked.projectId, projectName: linked.projectName, accountId: linked.accountId };
      }
      stage = "COMPLETE";
      await this.#assertPreparationCurrent(record);
      const completedAt = this.#now();
      await this.#options.repository.complete(preparationId, attempt, {
        status: "READY_TO_DEPLOY",
        project,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + this.#readyTtlMs),
      });
      console.info(`[sites][publish] prepared site=${input.siteId} version=${input.versionId} files=${artifact.fileCount} bytes=${artifact.totalBytes} attempt=${attempt}`);
      finished("READY");
    } catch (error) {
      const failure = this.#failure(error);
      console.warn(`[sites][publish] preparation failed site=${input.siteId} version=${input.versionId} code=${failure.code} attempt=${attempt}`);
      finished("FAILED", failure);
      await this.#options.repository.complete(preparationId, attempt, {
        status: "PREPARATION_FAILED",
        project,
        failure,
        completedAt: this.#now(),
      });
    }
  }

  /** A previous attempt's artifact for the same exact source, if it still verifies. */
  async #reusableArtifact(record: PublishPreparationRecord): Promise<PublishPreparationArtifact | undefined> {
    if (!record.artifact) return undefined;
    try {
      parsePreparedArtifact(await this.#options.artifacts.get(record.artifact.ref), {
        sha256: record.artifact.sha256, siteId: record.siteId, versionId: record.versionId, sourceSha256: record.sourceSha256,
      });
      return record.artifact;
    } catch {
      return undefined;
    }
  }

  async #buildArtifact(
    record: PublishPreparationRecord,
    input: ProductionBuildInput & { sourceSha256: string },
    built: () => void,
  ): Promise<{ artifact: PublishPreparationArtifact; metrics: ProductionBuildResult["metrics"] }> {
    const result = await this.#options.builder.build(input);
    built();
    const serialized = serializePreparedArtifact({
      siteId: record.siteId,
      versionId: record.versionId,
      sourceSha256: record.sourceSha256,
      routing: result.routing,
      routes: result.routes,
      files: result.files,
      generated: result.generated,
      createdAt: this.#now(),
    });
    // Outside versions/: never part of a source snapshot and never a cleanup candidate.
    const ref = `sites/${record.siteId}/publishing/${record.preparationId}/attempt-${record.attempt}/artifact.json`;
    await this.#options.artifacts.put(ref, serialized.bytes, { kind: "PRODUCTION_BUILD", contentType: "application/json" });
    const artifact: PublishPreparationArtifact = {
      ref,
      sha256: serialized.sha256,
      sizeBytes: serialized.bytes.length,
      fileCount: result.summary.fileCount + result.generated.length,
      totalBytes: result.summary.totalBytes + result.generated.reduce((sum, file) => sum + file.content.length, 0),
      routing: result.routing,
      indexSha256: serialized.indexSha256,
      summary: result.summary,
    };
    await this.#options.repository.saveArtifact(record.preparationId, record.attempt, artifact, result.metrics, this.#now());
    return { artifact, metrics: result.metrics };
  }

  #failure(error: unknown): PublishPreparationFailure {
    if (error instanceof PublishingError) {
      const metadata = boundedMetadata(error.metadata);
      return { code: error.code, message: error.message, retryable: error.retryable, ...(metadata ? { metadata } : {}) };
    }
    console.error("[sites][publish] unexpected preparation error", { name: (error as Error)?.name });
    return { code: "PUBLISH_PREPARATION_FAILED", message: "Publishing preparation failed unexpectedly. Try again.", retryable: true };
  }

  async #ownedProject(ownerId: string, siteId: string): Promise<SiteProject> {
    if (typeof ownerId !== "string" || !ownerId) throw Object.assign(new Error("An authenticated owner is required"), { code: "AUTHENTICATION_REQUIRED" });
    const project = await this.#options.projects.getOwnedById(siteId as SiteId, ownerId);
    if (!project || project.id !== siteId || project.ownerId !== ownerId) throw siteNotFound();
    return project;
  }

  async #currentVersion(ownerId: string, siteId: string, versionId: string) {
    const project = await this.#ownedProject(ownerId, siteId);
    if (!project.latestVersionId) throw Object.assign(new Error("Version not found"), { code: "VERSION_NOT_FOUND" });
    // Only the current saved version may be prepared: never an older or different one.
    if (versionId !== project.latestVersionId)
      throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "Only the site's current saved version can be published. Reload the editor and try again.");
    const version = await this.#options.versions.getById(versionId as VersionId, ownerId);
    if (!version || version.siteId !== project.id) throw Object.assign(new Error("Version not found"), { code: "VERSION_NOT_FOUND" });
    const qaAccepted =
      version.browserQAStatus === "PASSED" ||
      version.browserQAStatus === "PASSED_WITH_WARNINGS" ||
      (version.browserQAStatus === undefined && version.visualQAStatus === "PASSED");
    if (version.buildStatus !== "SUCCEEDED" || !qaAccepted)
      throw new PublishingError("PUBLISH_VERSION_NOT_VERIFIED", "This version has not passed build and quality checks, so it cannot be published.");
    if (version.assetManifestArtifactRef && !(await this.#options.artifacts.exists(version.assetManifestArtifactRef)))
      throw new PublishingError("PUBLISH_SOURCE_UNAVAILABLE", "This version's asset manifest is missing, so it cannot be published.");
    return { project, version };
  }

  async #connection(ownerId: string) {
    try {
      // Decrypting proves the stored token is usable; the token itself is not kept here.
      const credentials = await this.#options.connections.credentials(ownerId);
      return { configurationId: credentials.configurationId, teamId: credentials.teamId, vercelUserId: credentials.vercelUserId };
    } catch (error) {
      if (error instanceof VercelIntegrationError)
        throw new PublishingError(
          error.code === "VERCEL_INTEGRATION_NOT_CONFIGURED"
            ? "VERCEL_INTEGRATION_NOT_CONFIGURED"
            : error.code === "VERCEL_TOKEN_UNAVAILABLE"
              ? "VERCEL_TOKEN_UNAVAILABLE"
              : "VERCEL_NOT_CONNECTED",
          error.message,
        );
      throw error;
    }
  }

  async #assertPreparationCurrent(record: PublishPreparationRecord) {
    if (this.#closed) throw new PublishingError("PUBLISH_INTERRUPTED", "Publishing preparation was interrupted by shutdown. Try again.");
    const { version } = await this.#currentVersion(record.ownerId, record.siteId, record.versionId);
    if (version.sourceArtifactRef !== record.sourceArtifactRef) throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "The saved source changed during preparation. Prepare again.");
    const source = await this.#options.artifacts.get(record.sourceArtifactRef);
    if (!source || createHash("sha256").update(source).digest("hex") !== record.sourceSha256)
      throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "The saved source changed during preparation. Prepare again.");
    const currentRecord = await this.#options.repository.findOwned(record.ownerId, record.preparationId);
    if (!currentRecord || currentRecord.attempt !== record.attempt || currentRecord.status !== "PREPARING")
      throw new PublishingError("PUBLISH_INTERRUPTED", "This preparation attempt was replaced. Check its current status.");
    const current = await this.#connection(record.ownerId), expected = record.connection;
    if (current.configurationId !== expected.configurationId || current.teamId !== expected.teamId || current.vercelUserId !== expected.vercelUserId)
      throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "The Vercel connection changed during preparation. Prepare again using the intended account.");
  }

  #view(record: PublishPreparationRecord, project: SiteProject): PublishPreparationView {
    return preparationStatusView(record, project, { now: this.#now(), maxAttempts: this.#maxAttempts, isRunning: id => this.#running.has(id) });
  }
}
import { preparationStatusView } from "./publishing-status-views.js";
