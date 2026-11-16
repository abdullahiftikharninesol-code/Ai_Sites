import { createHash, randomUUID } from "node:crypto";
import type { SiteProject } from "../sites/domain/entities.js";
import type { SiteId } from "../shared/types.js";
import { VercelIntegrationError, type VercelConnectionService } from "../integrations/vercel/vercel-connection-service.js";
import type { LinkedVercelProject } from "../integrations/vercel/vercel-project-provider.js";
import { classifyVercelApiError } from "../integrations/vercel/vercel-api-errors.js";
import { VercelApiError, type VercelAuth } from "../integrations/vercel/vercel-projects-client.js";
import type { VercelDeploymentInfo, VercelDeploymentsClient } from "../integrations/vercel/vercel-deployments-client.js";
import { PublishingError, accountMismatchError, boundedMetadata, isPublishingErrorCode } from "./publishing-errors.js";
import type { PublishPreparationService, PublishPreparationView } from "./publish-preparation-service.js";
import { HOSTING_CONFIG_VERSION, type PreparedArtifactDocument } from "./static-artifact.js";
import { publicOriginFor, verifyPublicDeployment, type PublicVerificationResult } from "./public-site-verifier.js";
import { VercelRequestBudgetError, guardVercelDeployments } from "./vercel-api-guard.js";
import {
  IN_PROGRESS_STATUSES,
  SETTLED_DEPLOYMENT_STATES,
  type PublishOperationRecord,
  type PublishOperationStatus,
  type SitePublicationRecord,
  type VercelPublishRepository,
} from "./vercel-publish-repository.js";

export interface VercelPublishLimits {
  readonly maxConcurrentPublishes: number;
  readonly uploadConcurrency: number;
  readonly maxUploadFiles: number;
  readonly maxUploadBytes: number;
  /** Extra attempts per file upload after a 429/5xx/network failure. */
  readonly uploadRetries: number;
  readonly pollIntervalMs: number;
  readonly preparationTimeoutMs: number;
  readonly deploymentTimeoutMs: number;
  /** Bound for Vercel to point production at a deployment (promote / rollback jobs go stale after 3 minutes). */
  readonly promotionTimeoutMs: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  /** How long an unconfirmed create may still appear in Vercel's deployment list (eventual consistency). */
  readonly createSettleMs: number;
  /** List lookups after a lost create response, with growing delays. */
  readonly reconcileListAttempts: number;
  /** Hard cap on Vercel requests per attempt (uploads are bounded separately by file count). */
  readonly requestBudget: number;
  /** Bounded retries of idempotent reads after 429 / 5xx / network failures. */
  readonly readRetries: number;
  readonly maxRetryAfterMs: number;
  /**
   * Most unresolved earlier operations (any age) checked for deployments to
   * stop before a new create; a site with more is inconclusive, never skipped.
   */
  readonly supersedeMaxOperations: number;
  /** Pages of a project's deployment list read per lookup; a longer search is incomplete, never absence. */
  readonly listMaxPages: number;
}

export const DEFAULT_VERCEL_PUBLISH_LIMITS: VercelPublishLimits = Object.freeze({
  maxConcurrentPublishes: 1,
  uploadConcurrency: 4,
  maxUploadFiles: 2_001,
  maxUploadBytes: 64 * 1024 * 1024,
  uploadRetries: 1,
  pollIntervalMs: 3_000,
  preparationTimeoutMs: 15 * 60_000,
  deploymentTimeoutMs: 10 * 60_000,
  promotionTimeoutMs: 3 * 60_000,
  leaseMs: 30 * 60_000,
  maxAttempts: 5,
  createSettleMs: 15 * 60_000,
  reconcileListAttempts: 3,
  requestBudget: 500,
  readRetries: 2,
  maxRetryAfterMs: 30_000,
  supersedeMaxOperations: 25,
  listMaxPages: 10,
});

/** Live publishing needs both flags: project creation and deployment are live Vercel actions. */
export const isLivePublishingEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.VERCEL_LIVE_PUBLISHING_ENABLED === "true" && env.VERCEL_PROJECT_LINKING_ENABLED === "true";

export interface VercelPublishServiceOptions {
  readonly repository: VercelPublishRepository;
  readonly projects: { getOwnedById(id: SiteId, ownerId: string): Promise<SiteProject | undefined> };
  readonly preparations: Pick<PublishPreparationService, "prepare" | "latest" | "loadReadyArtifact">;
  readonly projectProvider: { ensureProject(ownerId: string, siteId: string): Promise<LinkedVercelProject> };
  /** isActiveConfiguration/activeAccount (Stage 5C) are optional so narrow test doubles keep working. */
  readonly connections: Pick<VercelConnectionService, "credentials"> & Partial<Pick<VercelConnectionService, "isActiveConfiguration" | "activeAccount">>;
  readonly deployments: VercelDeploymentsClient;
  readonly liveEnabled?: boolean;
  readonly verify?: (origin: string, artifact: PreparedArtifactDocument) => Promise<PublicVerificationResult>;
  readonly limits?: Partial<VercelPublishLimits>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observe-only reconciliation of unverified operations (off unless SITES_PUBLISH_RECONCILE_ENABLED=true). */
  readonly reconcileEnabled?: boolean;
  readonly reconcileLimits?: Partial<PublishReconcileLimits>;
}

/** Bounds of one reconciliation pass (see docs/PUBLISHING_RELIABILITY.md). */
export interface PublishReconcileLimits {
  readonly maxOperations: number;
  readonly maxPublications: number;
  /** Vercel requests per operation or publication checked. */
  readonly requestsPerItem: number;
  /** Operations older than this are left alone (the user can still publish again). */
  readonly maxAgeMs: number;
  readonly maxChecksPerOperation: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly leaseMs: number;
  /** How often a live publication's address is re-checked. */
  readonly publicationCheckIntervalMs: number;
}

export const DEFAULT_RECONCILE_LIMITS: PublishReconcileLimits = Object.freeze({
  maxOperations: 10,
  maxPublications: 10,
  requestsPerItem: 8,
  maxAgeMs: 48 * 60 * 60_000,
  maxChecksPerOperation: 20,
  baseBackoffMs: 2 * 60_000,
  maxBackoffMs: 60 * 60_000,
  leaseMs: 5 * 60_000,
  publicationCheckIntervalMs: 6 * 60 * 60_000,
});

export const isPublishReconcileEnabled = (env: NodeJS.ProcessEnv = process.env) => env.SITES_PUBLISH_RECONCILE_ENABLED === "true";

export interface PublishReconcileSummary {
  readonly enabled: boolean;
  operationsChecked: number;
  published: number;
  failed: number;
  cancelled: number;
  unverified: number;
  publicationsChecked: number;
  publicationsChanged: number;
  requests: number;
  /** The pass stopped early (deadline reached or shutting down); the rest waits for the next pass. */
  truncated: boolean;
}

export type PublishStatus = "NOT_PUBLISHED" | PublishOperationStatus;

/**
 * What a failed or unfinished update means for the site that was already
 * live, as observed on Vercel (never assumed):
 *   UNCHANGED          no deployment was created, so production was not touched
 *   PREVIOUS_LIVE      production still serves the last published deployment
 *   PREVIOUS_RESTORED  the new deployment went live, failed verification, and the previous one was restored
 *   NEW_UNVERIFIED     production now serves the new deployment, which was not verified
 *   UNKNOWN            what production serves could not be determined
 */
export type LiveImpact = "UNCHANGED" | "PREVIOUS_LIVE" | "PREVIOUS_RESTORED" | "NEW_UNVERIFIED" | "UNKNOWN";

/** Browser view: no tokens, artifact locations, workspace paths or account secrets. */
export interface VercelPublishView {
  readonly liveEnabled: boolean;
  readonly status: PublishStatus;
  /** The current editable (saved) version, and whether it differs from the live one. */
  readonly draft: { readonly versionId: string | null; readonly hasUnpublishedChanges: boolean };
  readonly published?: {
    readonly url: string;
    readonly versionId: string;
    readonly versionNumber: number;
    readonly deploymentId: string;
    readonly publishedAt: string;
    readonly isCurrentVersion: boolean;
    /** True when this publication moved the site to a different public address than the one before. */
    readonly urlChanged: boolean;
    /** VERIFIED at publish time (or by the last check); CHANGED when a later check found production serving something else. */
    readonly liveState: "VERIFIED" | "CHANGED";
    readonly checkedAt: string;
    readonly account: { readonly type: "personal" | "team"; readonly label?: string };
    readonly connectedAccountMatches?: boolean;
    /** Published with an older hosting configuration; publishing again (same version) applies the current one. */
    readonly hostingOutdated?: true;
  };
  readonly operation?: {
    readonly operationId: string;
    readonly versionId: string;
    readonly status: PublishOperationStatus;
    readonly attempt: number;
    readonly progress?: PublishOperationRecord["progress"];
    readonly publicUrl?: string;
    readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean };
    /** Only for updates of a published site that have not (yet) been verified. */
    readonly liveImpact?: LiveImpact;
    /** A requested deployment that Vercel may still finish and assign to production on its own. */
    readonly pendingDeployment?: true;
    readonly updatedAt: string;
  };
}

/** Polls before acting on a deployment Vercel has not pointed production at (auto-assignment may still be running). */
const PROMOTION_GRACE_POLLS = 2;
const UNSERVABLE_STATES = ["ERROR", "CANCELED", "DELETED", "BLOCKED"];
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** A deployment search: what it found, and whether it covered every page Vercel has. */
interface DeploymentLookup {
  readonly found?: VercelDeploymentInfo;
  readonly complete: boolean;
}

/** A running attempt: its latest record and its fenced writer. */
interface RunContext {
  op(): PublishOperationRecord;
  set(update: Partial<PublishOperationRecord>, unset?: (keyof PublishOperationRecord)[]): Promise<void>;
}

/** An inconclusive outcome: the deployment may be fine, but it was not proven live. */
class InconclusiveError extends PublishingError {}
/** The server is shutting down: stop at the next safe point and leave the operation resumable. */
class InterruptedError extends PublishingError {
  constructor() {
    super("PUBLISH_INTERRUPTED", "Publishing was interrupted by a server restart. Publish again; AI Sites checks Vercel before deploying again.");
  }
}

/** One attempt's Vercel credentials and its budgeted, retry-bounded client. */
interface VercelSession {
  readonly auth: VercelAuth;
  readonly api: VercelDeploymentsClient;
}

/** Deployment states after which Vercel no longer changes production on its own. */
const SETTLED_STATES = SETTLED_DEPLOYMENT_STATES;
/** Failures whose effect on the live site is known regardless of later observations. */
const DEFINITIVE_FAILURES = new Set(["VERCEL_DEPLOYMENT_FAILED", "PUBLISH_UPDATE_ROLLED_BACK", "PUBLISH_PRODUCTION_CHANGED"]);
const RECONCILE_DELAYS_MS = [2_000, 5_000, 10_000];

/** Published with an older generated hosting configuration (e.g. without deep-link support): republishing applies the current one. */
const hostingOutdated = (publication: SitePublicationRecord) => (publication.hostingVersion ?? 1) < HOSTING_CONFIG_VERSION;

/** A later check found the public address serving something other than the verified deployment. */
const publicationChanged = (publication: SitePublicationRecord) =>
  !!publication.checkedAt && publication.observedDeploymentId !== publication.deploymentId;

/** A requested deployment that may still finish building and be assigned to production by Vercel. */
/**
 * A create request whose outcome is unknown: no response, a provider error,
 * or a success (2xx) whose body could not be read. Only a 4xx is a rejection.
 */
const createOutcomeUnknown = (error: unknown) =>
  error instanceof VercelApiError && (error.status === undefined || error.status >= 500 || (error.status >= 200 && error.status < 300));

/**
 * An earlier deployment (as Vercel reports it) that can no longer change
 * production by itself: failed or cancelled, or READY with its assignment settled
 * (PROMOTED, STAGED, or aliases already assigned). A READY deployment still
 * rolling out, or one whose assignment Vercel doesn't report, is not.
 */
const cannotChangeProduction = (deployment: VercelDeploymentInfo) =>
  UNSERVABLE_STATES.includes(deployment.readyState) ||
  (deployment.readyState === "READY" &&
    (deployment.readySubstate === "PROMOTED" || deployment.readySubstate === "STAGED" || (deployment.readySubstate === undefined && deployment.aliasAssigned === true)));

export const deploymentMayStillGoLive = (op: Pick<PublishOperationRecord, "deploymentRequestedAt" | "deploymentId" | "deploymentState">) =>
  !!(op.deploymentRequestedAt || op.deploymentId) && (!op.deploymentId || !SETTLED_STATES.includes(op.deploymentState ?? ""));
/** Another attempt took over this operation; stop without writing. */
class StaleAttemptError extends Error {}

const siteNotFound = () => Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
};

/**
 * Publishes the exact, verified current version of a site to the user's own
 * Vercel account: preparation (Stage 2) → project create/reuse → file upload
 * (POST /v2/files, SHA-1 confirmed) → production deployment → bounded
 * polling → public verification → PUBLISHED. One active operation per site;
 * the previous verified publication is kept until a new one is proven live.
 *
 * Updates reuse the published site's project (the provider pins it) and its
 * production domain. Vercel points production at a new production deployment
 * as soon as it is READY (unless the project's auto-assignment is off), which
 * is before AI Sites can verify it; so the outcome is always read back from
 * Vercel: the production target and the public hostname's alias must name the
 * new deployment, a staged deployment is promoted explicitly, and an update
 * that went live but serves the wrong content is rolled back to the previous
 * verified deployment (Instant Rollback), and that restore is confirmed too.
 * No AI calls, no credits, no generated code runs here.
 */
export class VercelPublishService {
  readonly #o: VercelPublishServiceOptions;
  readonly #limits: VercelPublishLimits;
  readonly #now: () => Date;
  readonly #baseSleep: (ms: number) => Promise<void>;
  readonly #shutdown = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  /** Slots reserved by admissions awaiting their claim/insert, keyed by site. */
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #liveEnabled: boolean;
  readonly #reconcileEnabled: boolean;
  readonly #reconcileLimits: PublishReconcileLimits;
  #closed = false;

  constructor(options: VercelPublishServiceOptions) {
    this.#o = options;
    this.#limits = {
      ...DEFAULT_VERCEL_PUBLISH_LIMITS,
      maxConcurrentPublishes: intEnv("SITES_PUBLISH_MAX_CONCURRENT_DEPLOYS", 1, 1, 4),
      ...options.limits,
    };
    this.#now = options.now ?? (() => new Date());
    this.#baseSleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#liveEnabled = options.liveEnabled ?? isLivePublishingEnabled();
    this.#reconcileEnabled = options.reconcileEnabled ?? isPublishReconcileEnabled();
    this.#reconcileLimits = { ...DEFAULT_RECONCILE_LIMITS, ...options.reconcileLimits };
  }

  get liveEnabled() {
    return this.#liveEnabled;
  }

  /** Observe-only reconciliation runs only with both its own flag and live publishing enabled. */
  get reconcileEnabled() {
    return this.#reconcileEnabled && this.#liveEnabled;
  }

  async status(ownerId: string, siteId: string): Promise<VercelPublishView> {
    const project = await this.#ownedProject(ownerId, siteId);
    const [latest, publication] = await Promise.all([
      this.#o.repository.findLatest(ownerId, project.id),
      this.#o.repository.findPublication(project.id),
    ]);
    // Repairs a crash between "operation PUBLISHED" and "publication saved".
    const repaired = latest?.status === "PUBLISHED" && (!publication || (publication.operationId !== latest.operationId && publication.publishedAt < (latest.completedAt ?? latest.updatedAt)))
      ? await this.#savePublication(latest)
      : publication;
    return this.#view(project, latest, repaired, await this.#o.connections.activeAccount?.(ownerId).catch(() => undefined));
  }

  async publish(ownerId: string, siteId: string, versionId: string): Promise<VercelPublishView> {
    const project = await this.#ownedProject(ownerId, siteId);
    if (!this.#liveEnabled)
      throw new PublishingError("PUBLISH_LIVE_DISABLED", "Live publishing to Vercel is disabled on this server. Your site was not deployed.");
    if (this.#closed) throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Publishing is shutting down. Try again shortly.");
    if (project.latestVersionId !== versionId)
      throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "Only the site's current saved version can be published. Reload the editor and try again.");

    const active = await this.#o.repository.findActive(project.id);
    if (active) {
      const abandoned = !this.#running.has(active.operationId) && !!active.leaseExpiresAt && active.leaseExpiresAt <= this.#now();
      if (!abandoned) {
        if (active.versionId !== versionId)
          throw new PublishingError("PUBLISH_IN_PROGRESS", "Another version of this site is being published. Wait for it to finish.");
        return this.status(ownerId, project.id);
      }
    }

    // Already live with exactly this version: nothing to deploy again (unless a check found production changed).
    const publication = await this.#o.repository.findPublication(project.id);
    const latest = await this.#o.repository.findLatest(ownerId, project.id);
    if (!active && publication?.versionId === versionId && latest?.status === "PUBLISHED" && latest.versionId === versionId && !publicationChanged(publication) && !hostingOutdated(publication))
      return this.#view(project, latest, publication);

    // Stage 2 preparation enforces the trusted-site gate, connection, source integrity and the build.
    const preparation = await this.#o.preparations.prepare(ownerId, project.id, versionId);
    if (preparation.status === "PREPARATION_FAILED" || preparation.status === "EXPIRED") throw this.#preparationError(preparation);

    // A request for this site is mid-admission: decide again once it has inserted or claimed
    // (same version → its status, other version → in progress), as a lost insert would.
    const pending = this.#admissions.get(project.id);
    if (pending) {
      await pending;
      return this.publish(ownerId, project.id, versionId);
    }
    // No await between this check and the reservation, so admission is atomic within this process.
    const release = this.#reserve(project.id);
    try {
      return await this.#admit(ownerId, project, versionId, active, latest, publication, preparation);
    } finally {
      release();
    }
  }

  /** Claims or inserts the site's operation while holding a reserved slot; starts it before the slot is released. */
  async #admit(
    ownerId: string,
    project: SiteProject,
    versionId: string,
    active: PublishOperationRecord | undefined,
    latest: PublishOperationRecord | undefined,
    publication: SitePublicationRecord | undefined,
    preparation: PublishPreparationView,
  ): Promise<VercelPublishView> {
    const resumable = active ?? (latest && latest.versionId === versionId && latest.preparationId === preparation.preparationId ? latest : undefined);
    if (resumable && resumable.status !== "PUBLISHED") {
      const now = this.#now();
      const claimed = await this.#o.repository.claim(resumable.operationId, {
        now, leaseExpiresAt: new Date(now.getTime() + this.#limits.leaseMs),
        // An unresolved create stays with its own operation (and meta tag) past the attempt limit, so
        // it is reconciled, never orphaned by a fresh operation that can't recognise its deployment.
        maxAttempts: deploymentMayStillGoLive(resumable) ? Number.MAX_SAFE_INTEGER : this.#limits.maxAttempts,
      });
      if (claimed) {
        this.#start(claimed);
        return this.#view(project, claimed, publication);
      }
      if (active) return this.status(ownerId, project.id);
    }

    const now = this.#now();
    const record: PublishOperationRecord = {
      operationId: randomUUID(),
      ownerId,
      siteId: project.id,
      versionId,
      preparationId: preparation.preparationId,
      provider: "vercel",
      status: "PREPARING",
      active: true,
      attempt: 1,
      leaseExpiresAt: new Date(now.getTime() + this.#limits.leaseMs),
      versionNumber: preparation.versionNumber,
      ...(publication ? { previousDeploymentId: publication.deploymentId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.#o.repository.insertActive(record))) {
      // A concurrent request created the site's active operation first.
      const winner = await this.#o.repository.findActive(project.id);
      if (winner && winner.versionId !== versionId)
        throw new PublishingError("PUBLISH_IN_PROGRESS", "Another version of this site is being published. Wait for it to finish.");
      return this.status(ownerId, project.id);
    }
    this.#start(record);
    return this.#view(project, record, publication);
  }

  /**
   * Stops running attempts at their next wait (never mid-request): each is
   * recorded as interrupted with its lease released, so a restart resumes it
   * immediately (reconciling with Vercel first, never creating blindly).
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort();
    // An admission already past its reservation starts its attempt (which stops at its first wait) or gives up.
    await Promise.allSettled([...this.#admissions.values()]);
    await Promise.allSettled([...this.#running.values()]);
  }

  /** A wait that ends early (InterruptedError) when the service shuts down. */
  #sleep(ms: number): Promise<void> {
    const signal = this.#shutdown.signal;
    if (signal.aborted) return Promise.reject(new InterruptedError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new InterruptedError());
      signal.addEventListener("abort", onAbort, { once: true });
      this.#baseSleep(ms).then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, reject);
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Synchronously takes a publish slot for an admission still awaiting its
   * claim/insert, so concurrent requests cannot all pass the limit. The
   * returned release is idempotent and must run in a finally block.
   */
  #reserve(siteId: string): () => void {
    if (this.#closed) throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Publishing is shutting down. Try again shortly.");
    if (this.#admissions.has(siteId) || this.#running.size + this.#admissions.size >= this.#limits.maxConcurrentPublishes)
      throw new PublishingError("PUBLISH_PREPARATION_BUSY", "Other sites are being published right now. Try again in a minute.");
    let settle!: () => void;
    const admission = new Promise<void>((resolve) => (settle = resolve));
    this.#admissions.set(siteId, admission);
    return () => {
      if (this.#admissions.get(siteId) === admission) this.#admissions.delete(siteId);
      settle();
    };
  }

  #start(record: PublishOperationRecord) {
    const job = this.#run(record)
      .catch((error: unknown) => console.error("[sites][publish] publish bookkeeping failed", { operationId: record.operationId, name: (error as Error)?.name }))
      .finally(() => this.#running.delete(record.operationId));
    this.#running.set(record.operationId, job);
  }

  async #run(initial: PublishOperationRecord): Promise<void> {
    const { operationId, attempt, ownerId, siteId } = initial;
    let op = initial;
    let session: VercelSession | undefined;
    const set = async (update: Partial<PublishOperationRecord>, unset: (keyof PublishOperationRecord)[] = []) => {
      const now = this.#now();
      const full = { ...update, updatedAt: now, ...(update.active === false ? {} : { leaseExpiresAt: new Date(now.getTime() + this.#limits.leaseMs) }) };
      if (!(await this.#o.repository.update(operationId, attempt, full, unset))) throw new StaleAttemptError();
      const next: Partial<Record<keyof PublishOperationRecord, unknown>> = { ...op, ...full };
      for (const key of unset) delete next[key];
      op = next as PublishOperationRecord;
    };
    const run: RunContext = { op: () => op, set };
    try {
      // A resumed attempt re-observes production; an earlier attempt's observation may be outdated.
      await set({ status: "PREPARING" }, ["productionDeploymentId", "productionCheckedAt"]);
      await this.#awaitPreparation(ownerId, siteId, op.preparationId);
      // Re-verifies the source and every artifact file against the exact current version.
      const { record: prepared, artifact } = await this.#o.preparations.loadReadyArtifact(ownerId, op.preparationId);
      if (artifact.versionId !== op.versionId || prepared.versionId !== op.versionId)
        throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "The prepared build does not belong to the version being published.");

      // An update: the verified publication it replaces stays the live record until the new one is verified.
      const previous = await this.#o.repository.findPublication(siteId);
      const credentials = await this.#credentials(ownerId);
      const accountId = credentials.teamId ?? credentials.vercelUserId;
      if (previous && previous.accountId !== accountId) throw accountMismatchError(previous);
      if (op.accountId && op.accountId !== accountId) throw accountMismatchError({ ...op, accountId: op.accountId });
      // The provider pins a published site to its project: reused, never replaced by a second one.
      const linked = await this.#o.projectProvider.ensureProject(ownerId, siteId);
      if (linked.configurationId !== credentials.configurationId || linked.accountId !== accountId)
        throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "The Vercel project does not belong to the account you authorized. Reconnect Vercel.");
      if (previous && linked.projectId !== previous.projectId)
        throw new PublishingError("VERCEL_PROJECT_UNAVAILABLE", "This website is published to a different Vercel project than the one AI Sites can reach now. Nothing was deployed.");
      if (op.projectId && linked.projectId !== op.projectId)
        throw new PublishingError("VERCEL_PROJECT_UNAVAILABLE", "This publishing attempt belongs to a different Vercel project. Reconnect its original account to check it again.");
      const vercelAuth: VercelAuth = { accessToken: credentials.accessToken, teamId: credentials.teamId };
      let connectionCheckedAt = Date.now();
      // Every Vercel request of this attempt is budgeted; only idempotent reads are retried (bounded, Retry-After aware).
      const api = guardVercelDeployments(this.#o.deployments, {
        budget: this.#limits.requestBudget, readRetries: this.#limits.readRetries, maxRetryAfterMs: this.#limits.maxRetryAfterMs, sleep: (ms) => this.#sleep(ms),
        // A disconnected or replaced connection is never used again by this attempt (checked at most once a second).
        beforeRequest: async () => {
          if (!this.#o.connections.isActiveConfiguration || Date.now() - connectionCheckedAt < 1_000) return;
          if (!(await this.#o.connections.isActiveConfiguration(ownerId, credentials.configurationId)))
            throw new PublishingError("VERCEL_NOT_CONNECTED", "The Vercel connection this update started with was disconnected or replaced, so it was stopped. Reconnect Vercel and publish again.");
          connectionCheckedAt = Date.now();
        },
      });
      const accountLabel = (await this.#o.connections.activeAccount?.(ownerId))?.displayName;
      const current: VercelSession = { auth: vercelAuth, api };
      session = current;
      await set({
        projectId: linked.projectId, projectName: linked.projectName, accountId: linked.accountId, configurationId: linked.configurationId,
        versionNumber: prepared.versionNumber, sourceSha256: prepared.sourceSha256, artifactSha256: prepared.artifact!.sha256,
        hostingVersion: artifact.hostingVersion ?? 1,
        ...(previous ? { previousDeploymentId: previous.deploymentId } : {}),
        ...(accountLabel ? { accountLabel } : {}),
      });

      const files = this.#uploadPlan(artifact);
      let deployment = await this.#existingDeployment(current, op);
      if (!deployment) {
        // Never deploy a version the user has since replaced (Vercel may put it live as soon as it is ready).
        await this.#assertCurrentVersion(op);
        // Earlier attempts' unfinished deployments must not finish later and replace this one.
        await this.#supersedeUnfinished(current, op);
        await set({ status: "UPLOADING", progress: { filesTotal: files.length, filesUploaded: 0, bytesTotal: files.reduce((sum, f) => sum + f.content.length, 0) } }, ["deploymentId", "deploymentUrl", "deploymentState", "deploymentRequestedAt"]);
        await this.#uploadAll(current, files, async (uploaded) => set({ progress: { ...op.progress!, filesUploaded: uploaded } }));
        await this.#assertCurrentVersion(op);
        await set({ status: "DEPLOYING", deploymentRequestedAt: this.#now() });
        deployment = await this.#createDeployment(current, run, files);
      } else await set({ status: "DEPLOYING" });
      await set({ deploymentId: deployment.id, ...(deployment.url ? { deploymentUrl: deployment.url } : {}), deploymentState: deployment.readyState });

      deployment = await this.#awaitReady(current, run, deployment);
      const origin = await this.#goLive(current, run, deployment, previous);
      const verification = await (this.#o.verify ?? ((o, a) => verifyPublicDeployment(o, a, { sleep: (ms) => this.#sleep(ms) })))(origin, artifact);
      const checkedAt = this.#now();
      await set({ publicUrl: origin, verification: { checkedAt, checks: verification.checks.slice(0, 20), ...(verification.coverage ? { coverage: verification.coverage } : {}) } });
      if (!verification.ok) {
        if (verification.reason === "MISMATCH" && previous) await this.#restorePrevious(current, run, previous);
        throw verification.reason === "PROTECTED"
          ? new InconclusiveError("PUBLISH_PUBLIC_URL_PROTECTED", "The deployment is ready but its public address requires a Vercel login (Deployment Protection). Make the production domain public in Vercel, then publish again.")
          : new InconclusiveError("PUBLISH_VERIFICATION_FAILED", "The deployment is ready but its public address did not serve this exact version yet. Publish again to re-check; nothing will be redeployed.");
      }
      // What was verified must still be what the public address serves.
      const serving = await this.#vercel(() => api.getAliasDeploymentId(vercelAuth, hostOf(origin)!, op.projectId!));
      if (serving !== deployment.id)
        throw new InconclusiveError("PUBLISH_PROMOTION_UNCONFIRMED", "Vercel's production address changed while the new version was being verified. Publish again to re-check.");
      await set({ productionDeploymentId: deployment.id, productionCheckedAt: this.#now() });

      await set({ status: "PUBLISHED", active: false, completedAt: this.#now() }, ["leaseExpiresAt", "failure"]);
      await this.#savePublication(op);
      console.info(`[sites][publish] published site=${siteId} version=${op.versionId} deployment=${op.deploymentId}`);
    } catch (error) {
      if (error instanceof StaleAttemptError) return;
      const failure = this.#failure(error);
      // For an update, read back what production serves now; never assume the previous site is still live.
      const observed = this.#shutdown.signal.aborted ? { update: {}, unset: [], known: false } : await this.#observeProduction(session, op);
      const status = this.#outcomeStatus(error, op, observed.known);
      console.warn(`[sites][publish] ${status.toLowerCase()} site=${siteId} version=${op.versionId} code=${failure.code} attempt=${attempt}`);
      await set({ status, active: false, failure, completedAt: this.#now(), ...observed.update }, ["leaseExpiresAt", ...observed.unset]).catch(() => undefined);
    }
  }

  async #awaitPreparation(ownerId: string, siteId: string, preparationId: string) {
    const deadline = Date.now() + this.#limits.preparationTimeoutMs;
    for (;;) {
      const latest = await this.#o.preparations.latest(ownerId, siteId);
      if (!latest || latest.preparationId !== preparationId)
        throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "The site changed while it was being prepared. Publish again.");
      if (latest.status === "READY_TO_DEPLOY") return;
      if (latest.status !== "PREPARING") throw this.#preparationError(latest);
      if (Date.now() >= deadline) throw new PublishingError("PUBLISH_INTERRUPTED", "Preparing the production build took too long. Publish again.");
      await this.#sleep(this.#limits.pollIntervalMs);
    }
  }

  #uploadPlan(artifact: PreparedArtifactDocument) {
    if (artifact.files.length > this.#limits.maxUploadFiles)
      throw new PublishingError("PUBLISH_LIMIT_EXCEEDED", `The site has more than ${this.#limits.maxUploadFiles} files to upload.`);
    let total = 0;
    const files = artifact.files.map((file) => {
      const content = Buffer.from(file.contentBase64, "base64");
      // loadReadyArtifact checked SHA-256 and size; the upload digest must match too.
      if (createHash("sha1").update(content).digest("hex") !== file.sha1 || content.length !== file.sizeBytes)
        throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared production build failed integrity verification. Prepare it again.");
      total += content.length;
      return { path: file.path, sha1: file.sha1, content };
    });
    if (total > this.#limits.maxUploadBytes)
      throw new PublishingError("PUBLISH_LIMIT_EXCEEDED", "The site is too large to upload.");
    return files;
  }

  async #uploadAll({ auth, api }: VercelSession, files: readonly { sha1: string; content: Buffer }[], progress: (uploaded: number) => Promise<void>) {
    const unique = [...new Map(files.map((file) => [file.sha1, file])).values()];
    let next = 0;
    let uploaded = 0;
    const worker = async () => {
      while (next < unique.length) {
        const file = unique[next++]!;
        await this.#uploadOne({ auth, api }, file);
        uploaded++;
        if (uploaded % 10 === 0 || uploaded === unique.length) await progress(Math.min(files.length, uploaded));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#limits.uploadConcurrency, unique.length) }, worker));
    await progress(files.length);
  }

  async #uploadOne({ auth, api }: VercelSession, file: { sha1: string; content: Buffer }) {
    for (let attempt = 0; ; attempt++) {
      try {
        await api.uploadFile(auth, file);
        return;
      } catch (error) {
        const transient = error instanceof VercelApiError && (error.status === undefined || error.status === 429 || error.status >= 500);
        const hinted = error instanceof VercelApiError ? error.retryAfterMs : undefined;
        // Uploads are content-addressed (SHA-1), so repeating one is idempotent; still bounded.
        if (transient && attempt < this.#limits.uploadRetries && (hinted === undefined || hinted <= this.#limits.maxRetryAfterMs)) {
          await this.#sleep(hinted ?? 1_000 * (attempt + 1));
          continue;
        }
        if (error instanceof VercelApiError && (error.status === 401 || error.status === 403 || error.status === 429))
          throw classifyVercelApiError(error, "deployment");
        if (error instanceof PublishingError) throw error;
        throw new PublishingError("VERCEL_UPLOAD_FAILED", "Uploading the site's files to Vercel failed. Try again.", {
          metadata: error instanceof VercelApiError ? { status: error.status, ...(error.vercelCode ? { vercelCode: error.vercelCode } : {}) } : undefined,
        });
      }
    }
  }

  /**
   * A deployment this operation already created (resume), found by ID or by
   * its operation tag. A create whose answer was lost is never repeated while
   * Vercel might still list it: until the settle window passes the attempt
   * stays inconclusive instead of risking a duplicate deployment.
   */
  async #existingDeployment(session: VercelSession, op: PublishOperationRecord): Promise<VercelDeploymentInfo | undefined> {
    const { auth, api } = session;
    if (op.deploymentId) {
      const known = await this.#vercel(() => api.getDeployment(auth, op.deploymentId!));
      // A settled failure can't go live: a fresh deployment is safe.
      if (known) return UNSERVABLE_STATES.includes(known.readyState) ? undefined : known;
      // A 404 alone is not proof it is gone: only a complete listing without it is.
      if (await this.#confirmedGone(session, op, op.deploymentId)) return undefined;
      throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "Vercel didn't return this site's earlier deployment and AI Sites couldn't confirm it is gone. It won't deploy again until it can tell; try again in a few minutes.");
    }
    if (!op.deploymentRequestedAt) return undefined;
    const { found, complete } = await this.#reconcile(session, op);
    if (found) return UNSERVABLE_STATES.includes(found.readyState) ? undefined : found;
    if (!complete || this.#now().getTime() - op.deploymentRequestedAt.getTime() < this.#limits.createSettleMs)
      throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "Vercel hasn't confirmed whether an earlier deployment request was accepted. AI Sites won't deploy again until it can tell; try again in a few minutes.");
    // A complete search, long past the settle window, lists no such deployment: it was never created.
    return undefined;
  }

  /**
   * Looks the operation's deployment up by its meta tag across the project's
   * deployment list (Vercel's list is eventually consistent, so callers
   * still wait out the settle window before treating `complete` as absence).
   */
  async #reconcile(session: VercelSession, op: PublishOperationRecord, attempts = 1): Promise<DeploymentLookup> {
    for (let lookup = 0; ; lookup++) {
      const result = await this.#searchDeployments(session, op, (deployment) => deployment.meta.aiSitesOperationId === op.operationId);
      if (result.found || lookup + 1 >= attempts) return result;
      await this.#sleep(RECONCILE_DELAYS_MS[lookup] ?? 10_000);
    }
  }

  /** A known deployment Vercel no longer returns by ID and that a complete listing of its project also lacks. */
  async #confirmedGone(session: VercelSession, op: PublishOperationRecord, deploymentId: string): Promise<boolean> {
    const { found, complete } = await this.#searchDeployments(session, op, (deployment) => deployment.id === deploymentId);
    return complete && !found;
  }

  /**
   * Pages through the operation's project's deployments created since its
   * request (newest first), bounded by `listMaxPages`. `complete` only when
   * Vercel reported the last page and every page was consistent; a bounded,
   * unreadable or non-advancing search is incomplete and never proves absence.
   * Read failures propagate (they are never absence either).
   */
  async #searchDeployments({ auth, api }: VercelSession, op: PublishOperationRecord, match: (deployment: VercelDeploymentInfo) => boolean): Promise<DeploymentLookup> {
    const since = (op.deploymentRequestedAt ?? op.createdAt).getTime() - 5 * 60_000;
    const seen = new Set<string>();
    let until: number | undefined;
    for (let page = 0; page < this.#limits.listMaxPages; page++) {
      const { deployments, next } = await this.#vercel(() => api.listProjectDeployments(auth, op.projectId!, since, until));
      let fresh = 0;
      let foreign = false;
      for (const deployment of deployments) {
        if (seen.has(deployment.id)) continue;
        seen.add(deployment.id);
        fresh++;
        // A listing scoped to this project that returns another project's deployment can't be trusted for absence.
        if (deployment.projectId && deployment.projectId !== op.projectId) {
          foreign = true;
          continue;
        }
        if (match(deployment)) return { found: deployment, complete: true };
      }
      if (foreign) return { complete: false };
      if (next === null) return { complete: true };
      // Unknown completeness, or a cursor that doesn't move back in time: stop without concluding.
      if (next === undefined || (until !== undefined && next + 1 >= until) || (page > 0 && fresh === 0)) return { complete: false };
      // The cursor is a creation timestamp: +1 re-reads that instant (however Vercel bounds it); IDs dedupe.
      until = next + 1;
    }
    return { complete: false };
  }

  async #createDeployment(session: VercelSession, run: RunContext, files: readonly { path: string; sha1: string; content: Buffer }[]): Promise<VercelDeploymentInfo> {
    const { auth, api } = session;
    const op = run.op();
    const input = {
      name: op.projectName!,
      projectId: op.projectId!,
      files: files.map((file) => ({ file: file.path, sha: file.sha1, size: file.content.length })),
      meta: { aiSitesOperationId: op.operationId, aiSitesSiteId: op.siteId, aiSitesVersionId: op.versionId },
    };
    for (let round = 0; round < 2; round++) {
      let result: VercelDeploymentInfo | { readonly missing: readonly string[] };
      try {
        result = await api.createDeployment(auth, input);
      } catch (error) {
        // The request may have succeeded on Vercel: look (with eventual-consistency delays) before ever creating again.
        // A 2xx whose body was unreadable or lacked an ID (invalid_response) was accepted, not rejected.
        if (createOutcomeUnknown(error)) {
          const lookup = await this.#reconcile(session, op, this.#limits.reconcileListAttempts).catch((cause: unknown) => {
            if (cause instanceof InterruptedError) throw cause;
            return undefined;
          });
          if (lookup?.found) return lookup.found;
          throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "Vercel didn't confirm the deployment request. AI Sites will look for it before ever deploying again; try again in a few minutes.");
        }
        // Rejected outright (4xx, 429): nothing was created, so no uncertainty remains.
        if (error instanceof VercelApiError) {
          await run.set({}, ["deploymentRequestedAt"]);
          throw classifyVercelApiError(error, "deployment");
        }
        throw error;
      }
      if (!("missing" in result)) return result;
      if (round === 1 || !result.missing.length) {
        await run.set({}, ["deploymentRequestedAt"]);
        throw new PublishingError("VERCEL_UPLOAD_FAILED", "Vercel reported files missing after upload. Try again.");
      }
      const missing = new Set(result.missing);
      for (const file of files.filter((f) => missing.has(f.sha1))) await this.#uploadOne(session, file);
    }
    throw new PublishingError("VERCEL_UPLOAD_FAILED", "Vercel reported files missing after upload. Try again.");
  }

  /**
   * Polls until READY. An edit saved while Vercel builds makes this version
   * stale: the build is cancelled before it can be auto-assigned to
   * production (Vercel's cancel endpoint; nothing is deleted).
   */
  async #awaitReady(session: VercelSession, run: RunContext, initial: VercelDeploymentInfo): Promise<VercelDeploymentInfo> {
    const { auth, api } = session;
    const deadline = Date.now() + this.#limits.deploymentTimeoutMs;
    let deployment = initial;
    let lastState = initial.readyState as string;
    let cancelAttempts = 0;
    for (;;) {
      if (UNSERVABLE_STATES.includes(deployment.readyState))
        throw new PublishingError("VERCEL_DEPLOYMENT_FAILED", `Vercel could not complete the deployment (${deployment.readyState.toLowerCase()})${deployment.errorMessage ? `: ${deployment.errorMessage}` : "."}`, {
          metadata: { readyState: deployment.readyState, ...(deployment.errorCode ? { errorCode: deployment.errorCode } : {}) },
        });
      // Whether production points at it (auto-assigned, staged or elsewhere) is read back by #goLive.
      if (deployment.readyState === "READY") return deployment;
      if (Date.now() >= deadline)
        throw new InconclusiveError("VERCEL_DEPLOYMENT_TIMEOUT", "Vercel is still finishing the deployment. Publish again to check on it; it will not be deployed twice.");
      await this.#sleep(this.#limits.pollIntervalMs);
      if (cancelAttempts < 2 && !(await this.#isCurrentVersion(run.op()))) {
        cancelAttempts++;
        await run.set({ cancelRequestedAt: this.#now() });
        const outcome = await api.cancelDeployment(auth, deployment.id).catch((cause: unknown) => {
          if (cause instanceof InterruptedError || cause instanceof VercelRequestBudgetError) throw cause;
          return "UNKNOWN" as const;
        });
        if (outcome === "CANCELED") {
          await run.set({ deploymentState: "CANCELED" });
          throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "This website was edited while Vercel was building it, so that older version was stopped before going live. Publish again to publish the latest version.");
        }
        // NOT_CANCELABLE: it already finished; it is observed and reported like any other deployment.
      }
      const next = await this.#vercel(() => api.getDeployment(auth, deployment.id));
      if (!next) throw new PublishingError("VERCEL_DEPLOYMENT_FAILED", "Vercel no longer reports this deployment.");
      deployment = next;
      if (deployment.readyState !== lastState) {
        lastState = deployment.readyState;
        await run.set({ deploymentState: lastState });
      }
    }
  }

  /**
   * Stops unfinished deployments of this site's earlier attempts before a new
   * one is created, so a stale version can't finish later and be assigned to
   * production after a newer one. Bounded; cancels only (never deletes).
   *
   * A cancel reply is not proof: each deployment is read back, and the new
   * deployment is created only once every earlier one is confirmed unable to
   * change production by itself (gone, failed/cancelled, or READY with its
   * production assignment settled). Otherwise this attempt stops, inconclusive.
   */
  async #supersedeUnfinished(session: VercelSession, op: PublishOperationRecord) {
    // Every unresolved earlier operation of the site, whatever its age or attempt count (bounded; more is inconclusive).
    const unresolved = await this.#o.repository.findUnresolved(op.siteId, this.#limits.supersedeMaxOperations + 1);
    if (unresolved.filter((other) => other.operationId !== op.operationId).length > this.#limits.supersedeMaxOperations)
      throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "This site has too many earlier deployments whose outcome Vercel hasn't confirmed. AI Sites won't start another deployment until they are resolved; try again later.");
    let unsettled = 0;
    for (const other of unresolved) {
      if (other.operationId === op.operationId || other.status === "PUBLISHED" || other.supersededAt || other.projectId !== op.projectId) continue;
      if (!deploymentMayStillGoLive(other)) continue;
      if (!other.accountId || other.accountId !== op.accountId)
        throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "An earlier deployment's original Vercel account could not be confirmed. Nothing was canceled or deployed.");
      let deploymentId = other.deploymentId;
      if (!deploymentId) {
        const { found, complete } = await this.#reconcile(session, other);
        deploymentId = found?.id;
        if (!deploymentId && (!complete || this.#now().getTime() - (other.deploymentRequestedAt?.getTime() ?? 0) < this.#limits.createSettleMs))
          throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "Vercel hasn't confirmed an earlier deployment request for this site yet. AI Sites won't start another deployment until it can tell; try again in a few minutes.");
        if (!deploymentId) {
          // A complete search long past the settle window: that request never created a deployment.
          await this.#o.repository.update(other.operationId, other.attempt, { supersededAt: this.#now() }).catch(() => false);
          continue;
        }
      }
      const now = this.#now();
      const outcome = await session.api.cancelDeployment(session.auth, deploymentId).catch((cause: unknown) => {
        if (cause instanceof InterruptedError || cause instanceof VercelRequestBudgetError) throw cause;
        return "UNKNOWN" as const;
      });
      // Whatever the reply, what Vercel reports now decides (a failed read stops this attempt too).
      const observed = await this.#vercel(() => session.api.getDeployment(session.auth, deploymentId));
      // A 404 counts only when a complete listing of the project lacks it too.
      const settled = observed ? cannotChangeProduction(observed) : await this.#confirmedGone(session, other, deploymentId);
      if (!settled) unsettled++;
      await this.#o.repository
        .update(other.operationId, other.attempt, {
          cancelRequestedAt: now,
          ...(settled ? { supersededAt: now, deploymentState: observed?.readyState ?? "DELETED" } : {}),
          ...(other.deploymentId ? {} : { deploymentId }),
        })
        .catch(() => false);
      console.info(`[sites][publish] superseded deployment site=${op.siteId} operation=${other.operationId} outcome=${outcome.toLowerCase()} settled=${settled}`);
    }
    if (unsettled)
      throw new InconclusiveError("VERCEL_DEPLOYMENT_UNCONFIRMED", "An earlier deployment of this site is still finishing on Vercel and couldn't be confirmed stopped, so it could still replace your live site. AI Sites won't start a newer deployment until it has finished or stopped; try again in a few minutes.");
  }

  /**
   * Makes sure production serves this READY deployment and returns its
   * confirmed public origin. Vercel normally auto-assigns production domains
   * to a READY production deployment; a staged one (auto-assignment off, e.g.
   * after a rollback) is promoted. Success is only what Vercel reports back:
   * the project's production target and the public hostname's alias.
   */
  async #goLive({ auth, api }: VercelSession, run: RunContext, deployment: VercelDeploymentInfo, previous: SitePublicationRecord | undefined): Promise<string> {
    const projectId = run.op().projectId!;
    const deadline = Date.now() + this.#limits.promotionTimeoutMs;
    let promoteAccepted = false;
    let promoteRequests = 0;
    for (let polls = 0; ; polls++) {
      if ((await this.#observeTarget({ auth, api }, run)) === deployment.id) break;
      const current = await this.#vercel(() => api.getDeployment(auth, deployment.id));
      if (current?.readyState !== "READY")
        throw new PublishingError("VERCEL_DEPLOYMENT_FAILED", "Vercel no longer reports this deployment as ready.");
      if (polls >= PROMOTION_GRACE_POLLS) {
        // It already served production and was replaced since; Vercel cannot promote it again.
        if (current.readySubstate === "PROMOTED")
          throw new PublishingError("PUBLISH_PRODUCTION_CHANGED", "Vercel's production address was moved to another deployment after this one went live. Publish again to create a fresh deployment.");
        if (!promoteAccepted && promoteRequests < 3) {
          // Never promote a version the user has since replaced.
          await this.#assertCurrentVersion(run.op());
          await run.set({ promotionRequestedAt: this.#now() });
          promoteRequests++;
          try {
            promoteAccepted = (await api.promoteDeployment(auth, projectId, deployment.id)) === "ACCEPTED";
          } catch (error) {
            // An unanswered request may still have been applied: the next observation decides.
            if (!(error instanceof VercelApiError)) throw error;
            if (error.status !== undefined && error.status < 500) throw classifyVercelApiError(error, "deployment");
          }
        }
      }
      if (Date.now() >= deadline)
        throw new InconclusiveError("PUBLISH_PROMOTION_UNCONFIRMED", "Vercel hasn't pointed your production address at the new deployment yet. Publish again to check; nothing will be deployed twice.");
      await this.#sleep(this.#limits.pollIntervalMs);
    }
    // The public address: the previous one when it now serves this deployment, else the production alias Vercel assigned.
    const previousHost = previous ? hostOf(previous.publicUrl) : undefined;
    for (;;) {
      const current = (await this.#vercel(() => api.getDeployment(auth, deployment.id))) ?? deployment;
      const candidates = [...new Set([previousHost, ...this.#productionHosts(current, run.op().projectName)])].filter((host): host is string => !!host).slice(0, 3);
      for (const host of candidates) {
        if (!publicOriginFor(host)) continue;
        if ((await this.#vercel(() => api.getAliasDeploymentId(auth, host, projectId))) === deployment.id) return publicOriginFor(host)!;
      }
      if (Date.now() >= deadline)
        throw new InconclusiveError("PUBLISH_PROMOTION_UNCONFIRMED", "The new deployment is live on Vercel, but its public address could not be confirmed yet. Publish again to re-check.");
      await this.#sleep(this.#limits.pollIntervalMs);
    }
  }

  /** Production hostnames reported for a deployment (prefers <project>.vercel.app), never its per-deployment URL. */
  #productionHosts(deployment: VercelDeploymentInfo, projectName: string | undefined): string[] {
    const aliases = deployment.alias.map((alias) => alias.toLowerCase()).filter((alias) => alias !== deployment.url?.toLowerCase());
    const named = projectName ? `${projectName}.vercel.app` : undefined;
    return [...(named && aliases.includes(named) ? [named] : []), ...aliases.filter((alias) => alias.endsWith(".vercel.app")), ...aliases, ...(named ? [named] : [])];
  }

  /** Records and returns the deployment behind the project's production domains. */
  async #observeTarget({ auth, api }: VercelSession, run: RunContext): Promise<string | null> {
    const id = await this.#vercel(() => api.getProductionDeploymentId(auth, run.op().projectId!));
    await run.set({ productionDeploymentId: id, productionCheckedAt: this.#now() });
    return id;
  }

  /**
   * The update went live but served the wrong content: point production back
   * at the last verified deployment (Instant Rollback) and confirm it. Always
   * throws: a confirmed restore fails the update; otherwise it is inconclusive.
   */
  async #restorePrevious({ auth, api }: VercelSession, run: RunContext, previous: SitePublicationRecord): Promise<never> {
    const projectId = run.op().projectId!;
    const previousHost = hostOf(previous.publicUrl);
    if (previous.projectId === projectId && previousHost) {
      try {
        await run.set({ rollbackRequestedAt: this.#now() });
        const deadline = Date.now() + this.#limits.promotionTimeoutMs;
        let accepted = false;
        let requests = 0;
        for (;;) {
          if (!accepted && requests < 3) {
            requests++;
            try {
              accepted = (await api.rollbackDeployment(auth, projectId, previous.deploymentId)) === "ACCEPTED";
            } catch (error) {
              // Only an unanswered request may still have been applied; anything else is final.
              if (!(error instanceof VercelApiError) || (error.status !== undefined && error.status < 500)) throw error;
            }
          }
          if (
            (await this.#observeTarget({ auth, api }, run)) === previous.deploymentId &&
            (await this.#vercel(() => api.getAliasDeploymentId(auth, previousHost, projectId))) === previous.deploymentId
          )
            throw new PublishingError("PUBLISH_UPDATE_ROLLED_BACK", "The updated website didn't serve this exact version on Vercel, so AI Sites restored your previous version. Your live link still shows the last published version.");
          if (Date.now() >= deadline) break;
          await this.#sleep(this.#limits.pollIntervalMs);
        }
      } catch (error) {
        if (error instanceof StaleAttemptError || (error instanceof PublishingError && error.code === "PUBLISH_UPDATE_ROLLED_BACK")) throw error;
        console.warn(`[sites][publish] restoring the previous deployment failed site=${run.op().siteId} name=${(error as Error)?.name}`);
      }
    }
    throw new InconclusiveError("PUBLISH_VERIFICATION_FAILED", "The new deployment went live on Vercel but didn't serve this exact version, and restoring the previous version could not be confirmed. Check the project in Vercel, then publish again.");
  }

  /** After a failed update, what production serves now (cleared when it cannot be read). */
  /** After a failed attempt that requested a deployment: what production serves now (cleared when it cannot be read). */
  async #observeProduction(session: VercelSession | undefined, op: PublishOperationRecord): Promise<{ update: Partial<PublishOperationRecord>; unset: (keyof PublishOperationRecord)[]; known: boolean }> {
    if (!op.deploymentRequestedAt && !op.deploymentId) return { update: {}, unset: [], known: true };
    if (!session || !op.projectId) return { update: {}, unset: ["productionDeploymentId", "productionCheckedAt"], known: false };
    try {
      const id = await session.api.getProductionDeploymentId(session.auth, op.projectId);
      return { update: { productionDeploymentId: id, productionCheckedAt: this.#now() }, unset: [], known: true };
    } catch {
      return { update: {}, unset: ["productionDeploymentId", "productionCheckedAt"], known: false };
    }
  }

  /**
   * FAILED only when this attempt's effect on the live site is known: nothing
   * was requested, the failure is definitive, or the deployment has settled
   * and production was read back. Otherwise the live state is uncertain and
   * the attempt is reported as unverified (and stays resumable).
   */
  #outcomeStatus(error: unknown, op: PublishOperationRecord, productionKnown: boolean): PublishOperationStatus {
    if (error instanceof InconclusiveError) return "VERIFICATION_INCONCLUSIVE";
    if (error instanceof PublishingError && DEFINITIVE_FAILURES.has(error.code)) return "FAILED";
    if (!op.deploymentRequestedAt && !op.deploymentId) return "FAILED";
    if (deploymentMayStillGoLive(op) || !productionKnown) return "VERIFICATION_INCONCLUSIVE";
    return "FAILED";
  }

  async #isCurrentVersion(op: PublishOperationRecord) {
    const project = await this.#o.projects.getOwnedById(op.siteId as SiteId, op.ownerId);
    return project?.latestVersionId === op.versionId;
  }

  /** The operation's version must still be the site's current saved version. */
  async #assertCurrentVersion(op: PublishOperationRecord) {
    if (!(await this.#isCurrentVersion(op)))
      throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "This website was edited while it was being published, so that older version was not put live. Publish again to publish the latest version.");
  }

  async #savePublication(op: PublishOperationRecord): Promise<SitePublicationRecord | undefined> {
    if (!op.deploymentId || !op.publicUrl || !op.projectId || !op.accountId || !op.configurationId || !op.sourceSha256 || !op.artifactSha256) return undefined;
    const record: SitePublicationRecord = {
      siteId: op.siteId, ownerId: op.ownerId, provider: "vercel", operationId: op.operationId,
      versionId: op.versionId, versionNumber: op.versionNumber ?? 0, sourceSha256: op.sourceSha256, artifactSha256: op.artifactSha256,
      configurationId: op.configurationId, accountId: op.accountId, ...(op.accountLabel ? { accountLabel: op.accountLabel } : {}), ...(op.hostingVersion ? { hostingVersion: op.hostingVersion } : {}), projectId: op.projectId,
      deploymentId: op.deploymentId, ...(op.deploymentUrl ? { deploymentUrl: op.deploymentUrl } : {}),
      publicUrl: op.publicUrl, publishedAt: op.completedAt ?? this.#now(),
    };
    await this.#o.repository.savePublication(record);
    return (await this.#o.repository.findPublication(op.siteId)) ?? record;
  }

  async #credentials(ownerId: string) {
    try {
      return await this.#o.connections.credentials(ownerId);
    } catch (error) {
      if (error instanceof VercelIntegrationError)
        throw new PublishingError(
          error.code === "VERCEL_INTEGRATION_NOT_CONFIGURED" ? "VERCEL_INTEGRATION_NOT_CONFIGURED" : error.code === "VERCEL_TOKEN_UNAVAILABLE" ? "VERCEL_TOKEN_UNAVAILABLE" : "VERCEL_NOT_CONNECTED",
          error.message,
        );
      throw error;
    }
  }

  async #vercel<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw error instanceof VercelApiError ? classifyVercelApiError(error, "deployment") : error;
    }
  }

  #preparationError(preparation: PublishPreparationView): PublishingError {
    const failure = preparation.failure;
    if (preparation.status === "EXPIRED") return new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared build expired. Publish again.");
    return isPublishingErrorCode(failure?.code)
      ? new PublishingError(failure.code, failure.message)
      : new PublishingError("PUBLISH_PREPARATION_FAILED", failure?.message ?? "Preparing the production build failed.");
  }

  #failure(error: unknown): NonNullable<PublishOperationRecord["failure"]> {
    if (error instanceof PublishingError) {
      const metadata = boundedMetadata(error.metadata);
      return { code: error.code, message: error.message, retryable: error.retryable, ...(metadata ? { metadata } : {}) };
    }
    console.error("[sites][publish] unexpected publish error", { name: (error as Error)?.name });
    return { code: "PUBLISH_PREPARATION_FAILED", message: "Publishing failed unexpectedly. Try again.", retryable: true };
  }

  async #ownedProject(ownerId: string, siteId: string): Promise<SiteProject> {
    if (typeof ownerId !== "string" || !ownerId) throw Object.assign(new Error("An authenticated owner is required"), { code: "AUTHENTICATION_REQUIRED" });
    const project = await this.#o.projects.getOwnedById(siteId as SiteId, ownerId);
    if (!project) throw siteNotFound();
    return project;
  }

  /**
   * One bounded reconciliation pass, also invoked by the internal scheduler
   * (see docs/PUBLISHING_RELIABILITY.md). For
   * unverified or abandoned operations it reads Vercel's state and records
   * it; it may complete a publication that is verifiably live, mark one
   * failed when its deployment settled without effect, or cancel a still
   * building deployment of a version the user has since replaced. It never
   * creates, promotes or rolls back deployments and never retries a create.
   * It also re-checks what live publications' addresses actually serve.
   */
  async reconcilePass(options: { readonly timeoutMs?: number } = {}): Promise<PublishReconcileSummary> {
    const summary: PublishReconcileSummary = {
      enabled: this.reconcileEnabled, operationsChecked: 0, published: 0, failed: 0, cancelled: 0, unverified: 0,
      publicationsChecked: 0, publicationsChanged: 0, requests: 0, truncated: false,
    };
    if (!summary.enabled || this.#closed) return summary;
    const limits = this.#reconcileLimits;
    const now = this.#now();
    const deadline = options.timeoutMs === undefined ? undefined : now.getTime() + options.timeoutMs;
    // Checked before each item (an item in flight is bounded by its request budget and request timeouts).
    const stop = () => {
      if (this.#closed || (deadline !== undefined && this.#now().getTime() >= deadline)) summary.truncated = true;
      return summary.truncated;
    };
    const candidates = await this.#o.repository.findReconcilable({
      now, createdAfter: new Date(now.getTime() - limits.maxAgeMs), maxCount: limits.maxChecksPerOperation, limit: limits.maxOperations,
    });
    for (const candidate of candidates) {
      if (stop()) return summary;
      if (this.#running.has(candidate.operationId)) continue;
      const claimed = await this.#o.repository.claimReconcile(candidate.operationId, candidate.attempt, now, new Date(now.getTime() + limits.leaseMs));
      if (!claimed) continue;
      summary.operationsChecked++;
      const api = this.#reconcileApi(claimed.ownerId, claimed.accountId);
      const outcome = await this.#reconcileOperation(claimed, api).catch((error: unknown) => {
        console.warn("[sites][publish] reconciliation failed", { operationId: claimed.operationId, name: (error as Error)?.name });
        return "UNVERIFIED" as const;
      });
      summary.requests += api.used();
      if (outcome === "PUBLISHED") summary.published++;
      else if (outcome === "FAILED") summary.failed++;
      else if (outcome === "CANCELLED") summary.cancelled++;
      else summary.unverified++;
    }
    for (const publication of await this.#o.repository.findPublicationsToCheck(new Date(now.getTime() - limits.publicationCheckIntervalMs), limits.maxPublications)) {
      if (stop()) return summary;
      const api = this.#reconcileApi(publication.ownerId, publication.accountId);
      try {
        const credentials = await this.#credentials(publication.ownerId);
        // Another connected account can't see this project's aliases: its view is not a production change.
        if (publication.accountId !== (credentials.teamId ?? credentials.vercelUserId)) continue;
        const host = hostOf(publication.publicUrl);
        if (!host) continue;
        const observed = (await api.getAliasDeploymentId({ accessToken: credentials.accessToken, teamId: credentials.teamId }, host, publication.projectId)) ?? null;
        await this.#assertReconcileConnection(publication.ownerId, publication.accountId, { accessToken: credentials.accessToken, teamId: credentials.teamId });
        await this.#o.repository.recordPublicationCheck(publication.siteId, publication.operationId, { checkedAt: now, observedDeploymentId: observed });
        summary.publicationsChecked++;
        if (observed !== publication.deploymentId) {
          summary.publicationsChanged++;
          console.warn(`[sites][publish] production changed outside AI Sites site=${publication.siteId} expected=${publication.deploymentId} observed=${observed ?? "none"}`);
        }
      } catch {
        // Not checkable now (credentials, Vercel unavailable): left for the next pass.
      } finally {
        summary.requests += api.used();
      }
    }
    return summary;
  }

  #reconcileApi(ownerId: string, accountId: string | undefined) {
    return guardVercelDeployments(this.#o.deployments, {
      budget: this.#reconcileLimits.requestsPerItem, readRetries: 0, maxRetryAfterMs: 0, sleep: (ms) => this.#sleep(ms),
      beforeRequest: (auth) => this.#assertReconcileConnection(ownerId, accountId, auth),
      checkCancellation: true,
    });
  }

  /** Pin an item's requests and observations to the connection it started with, including cancellation. */
  async #assertReconcileConnection(ownerId: string, accountId: string | undefined, auth: VercelAuth) {
    const credentials = await this.#credentials(ownerId);
    if (!accountId || accountId !== (credentials.teamId ?? credentials.vercelUserId) || credentials.teamId !== auth.teamId || credentials.accessToken !== auth.accessToken)
      throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "The Vercel connection changed while this publishing outcome was being checked. Reconnect the original account to check again.");
  }

  async #reconcileOperation(op: PublishOperationRecord, api: VercelDeploymentsClient): Promise<"PUBLISHED" | "FAILED" | "CANCELLED" | "UNVERIFIED"> {
    const limits = this.#reconcileLimits;
    const now = this.#now();
    const count = (op.reconcileCount ?? 0) + 1;
    const bookkeeping = { reconcileCount: count, reconciledAt: now, nextReconcileAt: new Date(now.getTime() + Math.min(limits.maxBackoffMs, limits.baseBackoffMs * 2 ** (count - 1))) };
    // Fenced by attempt: if a publish request resumed the operation meanwhile, nothing is written.
    let session: VercelSession | undefined;
    const write = async (update: Partial<PublishOperationRecord>, unset: (keyof PublishOperationRecord)[] = []) => {
      if (session) await this.#assertReconcileConnection(op.ownerId, op.accountId, session.auth);
      return this.#o.repository.update(op.operationId, op.attempt, { ...bookkeeping, ...update, updatedAt: now }, [...unset, "reconcileLeaseExpiresAt"]);
    };
    // An abandoned in-progress attempt is only observed; its status belongs to whoever resumes it.
    const settle = async (update: Partial<PublishOperationRecord>, unset: (keyof PublishOperationRecord)[] = []) =>
      write(op.active ? Object.fromEntries(Object.entries(update).filter(([key]) => !["status", "failure", "completedAt"].includes(key))) : update, op.active ? [] : unset);
    if (!op.accountId || !op.projectId || (!op.deploymentId && !op.deploymentRequestedAt)) {
      await write({});
      return "UNVERIFIED";
    }
    const previous = await this.#o.repository.findPublication(op.siteId);
    // Recovery must never replace a verified publication's original owner/account/project binding.
    if (previous && (previous.ownerId !== op.ownerId || previous.accountId !== op.accountId || previous.projectId !== op.projectId)) {
      await write({});
      return "UNVERIFIED";
    }
    try {
      const credentials = await this.#credentials(op.ownerId);
      if (op.accountId !== (credentials.teamId ?? credentials.vercelUserId)) {
        await write({});
        return "UNVERIFIED";
      }
      session = { auth: { accessToken: credentials.accessToken, teamId: credentials.teamId }, api };
    } catch {
      await write({});
      return "UNVERIFIED";
    }
    const { auth } = session;
    const lookup = op.deploymentId ? undefined : await this.#reconcile(session, op);
    const deployment = op.deploymentId ? await this.#vercel(() => api.getDeployment(auth, op.deploymentId!)) : lookup!.found;
    // A lookup by deployment ID is account-scoped, not project-scoped. Never act on another project's deployment.
    if (deployment && deployment.projectId !== op.projectId) {
      await write({});
      return "UNVERIFIED";
    }
    const production = await this.#vercel(() => api.getProductionDeploymentId(auth, op.projectId!));
    const observed: Partial<PublishOperationRecord> = {
      productionDeploymentId: production, productionCheckedAt: now,
      ...(deployment ? { deploymentState: deployment.readyState } : {}),
      ...(deployment && !op.deploymentId ? { deploymentId: deployment.id, ...(deployment.url ? { deploymentUrl: deployment.url } : {}) } : {}),
    };
    if (!deployment) {
      // Absence only from a complete search past the settle window, or a 404 a complete listing confirms.
      const absent = op.deploymentId
        ? await this.#confirmedGone(session, op, op.deploymentId)
        : lookup!.complete && now.getTime() - op.deploymentRequestedAt!.getTime() >= this.#limits.createSettleMs;
      if (absent) {
        await settle({ ...observed, status: "FAILED", completedAt: now, failure: { code: "VERCEL_DEPLOYMENT_FAILED", message: "Vercel has no deployment for this attempt, so nothing changed on the live site. Publish again.", retryable: true } }, ["deploymentRequestedAt"]);
        return "FAILED";
      }
      await write(observed);
      return "UNVERIFIED";
    }
    if (UNSERVABLE_STATES.includes(deployment.readyState)) {
      await settle({ ...observed, status: "FAILED", completedAt: now, failure: { code: "VERCEL_DEPLOYMENT_FAILED", message: `Vercel could not complete the deployment (${deployment.readyState.toLowerCase()}).`, retryable: true } });
      return "FAILED";
    }
    if (deployment.readyState !== "READY") {
      // Still building: a version the user has replaced must not go live late.
      if (!(await this.#isCurrentVersion(op)) && (await api.cancelDeployment(auth, deployment.id).catch(() => "UNKNOWN")) === "CANCELED") {
        await settle({ ...observed, deploymentState: "CANCELED", cancelRequestedAt: now, status: "FAILED", completedAt: now, failure: { code: "PUBLISH_VERSION_NOT_CURRENT", message: "This website was edited after this update started, so the unfinished older version was stopped before going live.", retryable: false } });
        return "CANCELLED";
      }
      await write(observed);
      return "UNVERIFIED";
    }
    if (op.active || production !== deployment.id) {
      await write(observed);
      return "UNVERIFIED";
    }
    // Vercel serves this deployment in production: confirm the public address and its exact content.
    const hosts = [...new Set([op.publicUrl ? hostOf(op.publicUrl) : undefined, previous ? hostOf(previous.publicUrl) : undefined, ...this.#productionHosts(deployment, op.projectName)])]
      .filter((host): host is string => !!host && !!publicOriginFor(host)).slice(0, 3);
    let origin: string | undefined;
    for (const host of hosts)
      if ((await this.#vercel(() => api.getAliasDeploymentId(auth, host, op.projectId!))) === deployment.id) {
        origin = publicOriginFor(host);
        break;
      }
    if (!origin) {
      await write(observed);
      return "UNVERIFIED";
    }
    let artifact: PreparedArtifactDocument;
    try {
      ({ artifact } = await this.#o.preparations.loadReadyArtifact(op.ownerId, op.preparationId));
    } catch {
      // The prepared build expired: what is live can't be proven to be this version.
      await write({ ...observed, publicUrl: origin });
      return "UNVERIFIED";
    }
    const verification = await (this.#o.verify ?? ((o, a) => verifyPublicDeployment(o, a, { sleep: (ms) => this.#sleep(ms) })))(origin, artifact);
    const checks = { checkedAt: now, checks: verification.checks.slice(0, 20) };
    if (!verification.ok) {
      await write({ ...observed, publicUrl: origin, verification: checks });
      return "UNVERIFIED";
    }
    if (!(await write({ ...observed, publicUrl: origin, verification: checks, status: "PUBLISHED", completedAt: now }, ["failure"]))) return "UNVERIFIED";
    await this.#savePublication({ ...op, ...observed, deploymentId: deployment.id, publicUrl: origin, status: "PUBLISHED", completedAt: now });
    console.info(`[sites][publish] reconciled late publication site=${op.siteId} version=${op.versionId} deployment=${deployment.id}`);
    return "PUBLISHED";
  }

  #view(project: SiteProject, latest: PublishOperationRecord | undefined, publication: SitePublicationRecord | undefined, connected?: { readonly accountId: string }): VercelPublishView {
    const now = this.#now();
    let operation = latest;
    // A crashed server's attempt: its lease lapsed and nothing here is running it.
    if (operation?.active && IN_PROGRESS_STATUSES.includes(operation.status) && operation.leaseExpiresAt && operation.leaseExpiresAt <= now && !this.#running.has(operation.operationId))
      operation = { ...operation, status: "VERIFICATION_INCONCLUSIVE", failure: { code: "PUBLISH_INTERRUPTED", message: "Publishing was interrupted. Publish again; AI Sites checks Vercel before deploying again.", retryable: true } };
    const history = publication?.history ?? [];
    const before = history.length >= 2 && history.at(-1)?.operationId === publication?.operationId ? history.at(-2) : undefined;
    const published = publication
      ? {
          url: publication.publicUrl,
          versionId: publication.versionId,
          versionNumber: publication.versionNumber,
          deploymentId: publication.deploymentId,
          publishedAt: publication.publishedAt.toISOString(),
          isCurrentVersion: publication.versionId === project.latestVersionId,
          urlChanged: !!before && before.publicUrl !== publication.publicUrl,
          // Verified when published; CHANGED once a later check found the address serving another deployment.
          liveState: publicationChanged(publication) ? ("CHANGED" as const) : ("VERIFIED" as const),
          checkedAt: (publication.checkedAt ?? publication.publishedAt).toISOString(),
          // Which kind of account updates need; its name only when Vercel reported one. No IDs.
          account: { type: publication.accountId.startsWith("team_") ? ("team" as const) : ("personal" as const), ...(publication.accountLabel ? { label: publication.accountLabel } : {}) },
          // Republishing (even the same version) regenerates its hosting configuration.
          ...(hostingOutdated(publication) ? { hostingOutdated: true as const } : {}),
          // Known only while a connection exists: false means updates need the account this site was published with.
          ...(connected ? { connectedAccountMatches: connected.accountId === publication.accountId } : {}),
        }
      : undefined;
    // An unverified attempt started after the live publication is an update of it.
    const liveImpact = operation && publication && operation.status !== "PUBLISHED" && operation.createdAt > publication.publishedAt
      ? this.#liveImpact(operation, publication, operation !== latest)
      : undefined;
    // An active attempt, or a finished one newer than the live publication, describes the site;
    // otherwise the last verified publication does. A failed attempt never hides `published`.
    const newerThanPublication = !!operation && (!publication || operation.createdAt > publication.publishedAt);
    const status: PublishStatus = operation && (operation.active || newerThanPublication)
      ? operation.status
      : published ? "PUBLISHED" : "NOT_PUBLISHED";
    return {
      liveEnabled: this.#liveEnabled,
      status,
      draft: { versionId: project.latestVersionId ?? null, hasUnpublishedChanges: !!publication && publication.versionId !== project.latestVersionId },
      ...(published ? { published } : {}),
      ...(operation
        ? {
            operation: {
              operationId: operation.operationId,
              versionId: operation.versionId,
              status: operation.status,
              attempt: operation.attempt,
              ...(operation.progress ? { progress: operation.progress } : {}),
              ...(operation.status === "PUBLISHED" && operation.publicUrl ? { publicUrl: operation.publicUrl } : {}),
              ...(operation.failure ? { failure: { code: operation.failure.code, message: operation.failure.message, retryable: operation.failure.retryable } } : {}),
              ...(liveImpact ? { liveImpact } : {}),
              // Vercel may still finish this deployment and assign it to production on its own.
              ...(operation.status !== "PUBLISHED" && deploymentMayStillGoLive(operation) ? { pendingDeployment: true } : {}),
              updatedAt: operation.updatedAt.toISOString(),
            },
          }
        : {}),
    };
  }

  #liveImpact(operation: PublishOperationRecord, publication: SitePublicationRecord, interrupted: boolean): LiveImpact {
    if (!operation.deploymentRequestedAt && !operation.deploymentId) return "UNCHANGED";
    // An interrupted attempt's last observation may be outdated.
    if (interrupted || !operation.productionDeploymentId) return "UNKNOWN";
    if (operation.productionDeploymentId === publication.deploymentId) return operation.rollbackRequestedAt ? "PREVIOUS_RESTORED" : "PREVIOUS_LIVE";
    if (operation.productionDeploymentId === operation.deploymentId) return "NEW_UNVERIFIED";
    return "UNKNOWN";
  }
}
