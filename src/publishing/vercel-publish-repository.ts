import { Schema, type Connection, type Model } from "mongoose";
import { randomUUID } from "node:crypto";
import { IN_PROGRESS_STATUSES, SETTLED_DEPLOYMENT_STATES } from "./publishing-status-views.js";
export { IN_PROGRESS_STATUSES, SETTLED_DEPLOYMENT_STATES } from "./publishing-status-views.js";

/**
 * Live publishing state. An operation is one attempt to publish one exact
 * saved version; `active` operations are unique per site (partial unique
 * index), which is the one-publish-at-a-time guarantee across processes.
 * The last *verified* publication lives in a separate per-site record that
 * only a PUBLISHED operation replaces, so a failed deployment never hides
 * or overwrites the site that is already live.
 */
export type PublishOperationStatus = "PREPARING" | "UPLOADING" | "DEPLOYING" | "PUBLISHED" | "FAILED" | "VERIFICATION_INCONCLUSIVE";

export interface PublishOperationRecord {
  readonly operationId: string;
  readonly ownerId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly preparationId: string;
  readonly provider: "vercel";
  readonly status: PublishOperationStatus;
  /** True until the operation reaches a terminal state; unique per site. */
  readonly active: boolean;
  readonly attempt: number;
  readonly leaseExpiresAt?: Date;
  readonly versionNumber?: number;
  readonly sourceSha256?: string;
  readonly artifactSha256?: string;
  readonly configurationId?: string;
  readonly accountId?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  /** The Vercel account's verified display name when this attempt started (shown, never used for access). */
  readonly accountLabel?: string;
  readonly progress?: { readonly filesTotal: number; readonly filesUploaded: number; readonly bytesTotal: number };
  /** Set immediately before the create request, so a timed-out create is reconciled, never repeated blindly. */
  readonly deploymentRequestedAt?: Date;
  readonly deploymentId?: string;
  readonly deploymentUrl?: string;
  readonly deploymentState?: string;
  readonly publicUrl?: string;
  /** The live publication this operation would replace (an update), if any. */
  readonly previousDeploymentId?: string;
  /** Last observed deployment behind the project's production domains (null: none), and when. */
  readonly productionDeploymentId?: string | null;
  readonly productionCheckedAt?: Date;
  /** Set immediately before a promote / rollback request, so outcomes are reconciled, never assumed. */
  readonly promotionRequestedAt?: Date;
  readonly rollbackRequestedAt?: Date;
  /** A newer operation cancelled (or tried to cancel) this one's unfinished deployment. */
  readonly supersededAt?: Date;
  readonly cancelRequestedAt?: Date;
  /** Observe-only reconciliation bookkeeping (bounded, backed off). */
  readonly reconcileCount?: number;
  readonly nextReconcileAt?: Date;
  readonly reconcileLeaseExpiresAt?: Date;
  readonly reconcileLeaseToken?: string;
  readonly reconciledAt?: Date;
  readonly verification?: {
    readonly checkedAt: Date;
    readonly checks: readonly { readonly path: string; readonly ok: boolean; readonly kind?: string; readonly detail?: string }[];
    readonly coverage?: { readonly routing: string; readonly routes: readonly string[]; readonly serverFallback: boolean; readonly clientRendering: string };
  };
  /** HOSTING_CONFIG_VERSION of the artifact being deployed (absent: 1). */
  readonly hostingVersion?: number;
  readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean; readonly metadata?: Record<string, unknown> };
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

/** One verified publication; the per-site history keeps the newest PUBLICATION_HISTORY_LIMIT. */
export interface PublicationHistoryEntry {
  readonly operationId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly deploymentId: string;
  readonly publicUrl: string;
  readonly publishedAt: Date;
}
export const PUBLICATION_HISTORY_LIMIT = 20;
export const PUBLISH_OPERATIONS_COLLECTION = "sites_publish_operations";
export const SITE_PUBLICATIONS_COLLECTION = "sites_site_publications";
export const historyEntryOf = (record: SitePublicationRecord): PublicationHistoryEntry => ({
  operationId: record.operationId, versionId: record.versionId, versionNumber: record.versionNumber,
  deploymentId: record.deploymentId, publicUrl: record.publicUrl, publishedAt: record.publishedAt,
});

export interface SitePublicationRecord {
  readonly siteId: string;
  readonly ownerId: string;
  readonly provider: "vercel";
  readonly operationId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly sourceSha256: string;
  readonly artifactSha256: string;
  readonly configurationId: string;
  readonly accountId: string;
  /** Verified display name of that account, to say which account updates require. */
  readonly accountLabel?: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly deploymentUrl?: string;
  readonly publicUrl: string;
  readonly publishedAt: Date;
  /** HOSTING_CONFIG_VERSION the live deployment's vercel.json was generated with (absent: 1). */
  readonly hostingVersion?: number;
  /** Bounded metadata only; Vercel deployments themselves are never deleted. */
  readonly history?: readonly PublicationHistoryEntry[];
  /** Last time reconciliation read what the public hostname serves, and what it found (null: nothing). */
  readonly checkedAt?: Date;
  readonly observedDeploymentId?: string | null;
  readonly reconcileLeaseExpiresAt?: Date;
  readonly reconcileLeaseToken?: string;
}

/** Deployment states after which a deployment can no longer go live by itself. */

type OperationUpdate =Partial<Omit<PublishOperationRecord, "operationId" | "ownerId" | "siteId" | "createdAt">>;

export interface VercelPublishRepository {
  /** Inserts an active operation; false when the site already has one. */
  insertActive(record: PublishOperationRecord): Promise<boolean>;
  findActive(siteId: string): Promise<PublishOperationRecord | undefined>;
  findLatest(ownerId: string, siteId: string): Promise<PublishOperationRecord | undefined>;
  /** Resumes a retryable/inconclusive/abandoned operation as the site's active one (attempt+1 fences old workers). */
  claim(operationId: string, input: { readonly now: Date; readonly leaseExpiresAt: Date; readonly maxAttempts: number }): Promise<PublishOperationRecord | undefined>;
  /** Fenced update of the current attempt; false when another attempt took over. */
  update(operationId: string, attempt: number, update: OperationUpdate, unset?: readonly (keyof PublishOperationRecord)[]): Promise<boolean>;
  findPublication(siteId: string): Promise<SitePublicationRecord | undefined>;
  /** Replaces the site's publication only with a newer one and appends it to the bounded history. */
  savePublication(record: SitePublicationRecord): Promise<void>;
  /** Running (active) operations of one owner across all sites. */
  countActiveForOwner(ownerId: string): Promise<number>;
  /**
   * The site's operations (any age or attempt count, newest first) whose
   * deployment may still go live: not published or superseded, with a create
   * requested but no deployment known, or a known deployment not yet settled.
   */
  findUnresolved(siteId: string, limit: number): Promise<readonly PublishOperationRecord[]>;
  /** Unverified or abandoned operations due for observe-only reconciliation. */
  findReconcilable(input: { readonly now: Date; readonly createdAfter: Date; readonly maxCount: number; readonly limit: number }): Promise<readonly PublishOperationRecord[]>;
  /** Takes the reconciliation lease of one attempt; undefined when another reconciler holds it or the attempt changed. */
  claimReconcile(operationId: string, attempt: number, now: Date, leaseExpiresAt: Date): Promise<PublishOperationRecord | undefined>;
  renewReconcile(operationId: string, attempt: number, token: string, now: Date, expires: Date): Promise<boolean>;
  updateReconcile(operationId: string, attempt: number, token: string, now: Date, update: OperationUpdate, unset?: readonly (keyof PublishOperationRecord)[]): Promise<boolean>;
  releaseReconcile(operationId: string, attempt: number, token: string): Promise<void>;
  /** Publications not checked since `checkedBefore` (oldest first). */
  findPublicationsToCheck(checkedBefore: Date, limit: number): Promise<readonly SitePublicationRecord[]>;
  /** Records what the public hostname serves, only while this publication is still the site's current one. */
  claimPublicationCheck(siteId: string, operationId: string, now: Date, expires: Date, checkedBefore?: Date): Promise<string | undefined>;
  renewPublicationCheck(siteId: string, operationId: string, token: string, now: Date, expires: Date): Promise<boolean>;
  recordPublicationCheck(siteId: string, operationId: string, check: { readonly checkedAt: Date; readonly observedDeploymentId: string | null }, lease: { readonly token: string; readonly now: Date }): Promise<boolean>;
  releasePublicationCheck(siteId: string, operationId: string, token: string): Promise<void>;
}

const operationSchema = new Schema<PublishOperationRecord>(
  {
    operationId: { type: String, required: true, unique: true, immutable: true },
    ownerId: { type: String, required: true },
    siteId: { type: String, required: true },
    versionId: { type: String, required: true },
    preparationId: { type: String, required: true },
    provider: { type: String, required: true, enum: ["vercel"] },
    status: { type: String, required: true, enum: ["PREPARING", "UPLOADING", "DEPLOYING", "PUBLISHED", "FAILED", "VERIFICATION_INCONCLUSIVE"] },
    active: { type: Boolean, required: true },
    attempt: { type: Number, required: true, min: 1 },
    leaseExpiresAt: Date,
    versionNumber: Number,
    sourceSha256: String,
    artifactSha256: String,
    configurationId: String,
    accountId: String,
    projectId: String,
    projectName: String,
    accountLabel: String,
    hostingVersion: Number,
    progress: { type: new Schema({ filesTotal: Number, filesUploaded: Number, bytesTotal: Number }, { _id: false, strict: "throw" }), required: false },
    deploymentRequestedAt: Date,
    deploymentId: String,
    deploymentUrl: String,
    deploymentState: String,
    publicUrl: String,
    previousDeploymentId: String,
    productionDeploymentId: { type: String, required: false },
    productionCheckedAt: Date,
    promotionRequestedAt: Date,
    rollbackRequestedAt: Date,
    supersededAt: Date,
    cancelRequestedAt: Date,
    reconcileCount: Number,
    nextReconcileAt: Date,
    reconcileLeaseExpiresAt: Date,
    reconcileLeaseToken: String,
    reconciledAt: Date,
    verification: { type: Schema.Types.Mixed, required: false },
    failure: {
      type: new Schema({ code: { type: String, required: true }, message: { type: String, required: true }, retryable: { type: Boolean, required: true }, metadata: Schema.Types.Mixed }, { _id: false, strict: "throw" }),
      required: false,
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    completedAt: Date,
  },
  { collection: PUBLISH_OPERATIONS_COLLECTION, versionKey: false, strict: "throw" },
);
// One active publish operation per site, enforced by MongoDB.
operationSchema.index({ siteId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "one_active_publish_per_site" });
operationSchema.index({ ownerId: 1, siteId: 1, createdAt: -1 });
operationSchema.index({ status: 1, nextReconcileAt: 1 });

const publicationSchema = new Schema<SitePublicationRecord>(
  {
    siteId: { type: String, required: true, unique: true, immutable: true },
    ownerId: { type: String, required: true, index: true },
    provider: { type: String, required: true, enum: ["vercel"] },
    operationId: { type: String, required: true },
    versionId: { type: String, required: true },
    versionNumber: { type: Number, required: true },
    sourceSha256: { type: String, required: true },
    artifactSha256: { type: String, required: true },
    configurationId: { type: String, required: true },
    accountId: { type: String, required: true },
    accountLabel: String,
    hostingVersion: Number,
    projectId: { type: String, required: true },
    deploymentId: { type: String, required: true },
    deploymentUrl: String,
    publicUrl: { type: String, required: true },
    publishedAt: { type: Date, required: true },
    history: {
      type: [
        new Schema<PublicationHistoryEntry>(
          {
            operationId: { type: String, required: true },
            versionId: { type: String, required: true },
            versionNumber: { type: Number, required: true },
            deploymentId: { type: String, required: true },
            publicUrl: { type: String, required: true },
            publishedAt: { type: Date, required: true },
          },
          { _id: false, strict: "throw" },
        ),
      ],
      default: undefined,
    },
    checkedAt: Date,
    observedDeploymentId: { type: String, required: false },
    reconcileLeaseExpiresAt: Date,
    reconcileLeaseToken: String,
  },
  { collection: SITE_PUBLICATIONS_COLLECTION, versionKey: false, strict: "throw" },
);

export const createVercelPublishModels = (connection: Connection) => ({
  operations:
    (connection.models.SitesPublishOperation as Model<PublishOperationRecord> | undefined) ??
    connection.model<PublishOperationRecord>("SitesPublishOperation", operationSchema),
  publications:
    (connection.models.SitesSitePublication as Model<SitePublicationRecord> | undefined) ??
    connection.model<SitePublicationRecord>("SitesSitePublication", publicationSchema),
});

const isDuplicateKey = (error: unknown) => (error as { code?: unknown })?.code === 11000;

export class MongoVercelPublishRepository implements VercelPublishRepository {
  readonly #models: ReturnType<typeof createVercelPublishModels>;
  constructor(connection: Connection) {
    this.#models = createVercelPublishModels(connection);
  }
  async ready(): Promise<void> {
    await Promise.all([this.#models.operations.createIndexes(), this.#models.publications.createIndexes()]);
  }
  async insertActive(record: PublishOperationRecord) {
    try {
      await this.#models.operations.create(record);
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }
  async findActive(siteId: string) {
    return (await this.#models.operations.findOne({ siteId, active: true }).lean().exec()) ?? undefined;
  }
  async findLatest(ownerId: string, siteId: string) {
    return (await this.#models.operations.findOne({ ownerId, siteId }).sort({ createdAt: -1 }).lean().exec()) ?? undefined;
  }
  async claim(operationId: string, input: Parameters<VercelPublishRepository["claim"]>[1]) {
    try {
      return (
        (await this.#models.operations
          .findOneAndUpdate(
            {
              operationId,
              attempt: { $lt: input.maxAttempts },
              $or: [
                { status: "FAILED", "failure.retryable": true },
                { status: "VERIFICATION_INCONCLUSIVE" },
                { status: { $in: IN_PROGRESS_STATUSES }, leaseExpiresAt: { $lte: input.now } },
              ],
            },
            { $set: { active: true, leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now }, $inc: { attempt: 1 }, $unset: { failure: 1, completedAt: 1, reconcileLeaseToken: 1, reconcileLeaseExpiresAt: 1 } },
            { new: true },
          )
          .lean()
          .exec()) ?? undefined
      );
    } catch (error) {
      // Another operation became active for this site meanwhile.
      if (isDuplicateKey(error)) return undefined;
      throw error;
    }
  }
  async update(operationId: string, attempt: number, update: OperationUpdate, unset: readonly (keyof PublishOperationRecord)[] = []) {
    const result = await this.#models.operations
      .updateOne(
        { operationId, attempt },
        { $set: update, $unset: { reconcileLeaseToken: 1, reconcileLeaseExpiresAt: 1, ...Object.fromEntries(unset.map((key) => [key, 1])) } },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  async findPublication(siteId: string) {
    return (await this.#models.publications.findOne({ siteId }).lean().exec()) ?? undefined;
  }
  async savePublication(record: SitePublicationRecord) {
    const { siteId } = record;
    // History is append-only through $push below; the caller never replaces it.
    const fields = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "siteId" && key !== "history"));
    let replaced: boolean;
    try {
      const result = await this.#models.publications
        .updateOne(
          { siteId, $or: [{ publishedAt: { $lt: record.publishedAt } }, { operationId: record.operationId }] },
          // A new publication starts unchecked: an older drift observation never carries over.
          { $set: fields, $setOnInsert: { siteId }, $unset: { reconcileLeaseToken: 1, reconcileLeaseExpiresAt: 1, ...("checkedAt" in fields ? {} : { checkedAt: 1, observedDeploymentId: 1 }), ...("accountLabel" in fields ? {} : { accountLabel: 1 }), ...("hostingVersion" in fields ? {} : { hostingVersion: 1 }) } },
          { upsert: true },
        )
        .exec();
      replaced = result.matchedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      // A newer publication already exists: keep it.
      if (!isDuplicateKey(error)) throw error;
      replaced = false;
    }
    if (!replaced) return;
    await this.#models.publications
      .updateOne(
        { siteId, "history.operationId": { $ne: record.operationId } },
        { $push: { history: { $each: [historyEntryOf(record)], $slice: -PUBLICATION_HISTORY_LIMIT } } },
      )
      .exec();
  }
  async countActiveForOwner(ownerId: string) {
    return this.#models.operations.countDocuments({ ownerId, active: true }).exec();
  }
  async findUnresolved(siteId: string, limit: number) {
    return this.#models.operations
      .find({
        siteId,
        status: { $ne: "PUBLISHED" },
        supersededAt: { $exists: false },
        $or: [
          { deploymentId: { $exists: false }, deploymentRequestedAt: { $exists: true } },
          { deploymentId: { $exists: true }, deploymentState: { $nin: SETTLED_DEPLOYMENT_STATES } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }
  async findReconcilable(input: Parameters<VercelPublishRepository["findReconcilable"]>[0]) {
    return this.#models.operations
      .find({
        createdAt: { $gte: input.createdAfter },
        $and: [
          { $or: [{ status: "VERIFICATION_INCONCLUSIVE" }, { active: true, leaseExpiresAt: { $lte: input.now } }] },
          { $or: [{ nextReconcileAt: { $exists: false } }, { nextReconcileAt: { $lte: input.now } }] },
          { $or: [{ reconcileCount: { $exists: false } }, { reconcileCount: { $lt: input.maxCount } }] },
        ],
      })
      .sort({ nextReconcileAt: 1, createdAt: 1 })
      .limit(input.limit)
      .lean()
      .exec();
  }
  async claimReconcile(operationId: string, attempt: number, now: Date, leaseExpiresAt: Date) {
    return (
      (await this.#models.operations
        .findOneAndUpdate(
          { operationId, attempt, $and: [
            { $or: [{ status: "VERIFICATION_INCONCLUSIVE" }, { active: true, leaseExpiresAt: { $lte: now } }] },
            { $or: [{ nextReconcileAt: { $exists: false } }, { nextReconcileAt: { $lte: now } }] },
            { $or: [{ reconcileLeaseExpiresAt: { $exists: false } }, { reconcileLeaseExpiresAt: { $lte: now } }] },
          ] },
          { $set: { reconcileLeaseExpiresAt: leaseExpiresAt, reconcileLeaseToken: randomUUID() } },
          { new: true },
        )
        .lean()
        .exec()) ?? undefined
    );
  }
  async renewReconcile(operationId: string, attempt: number, token: string, now: Date, expires: Date) {
    const result = await this.#models.operations.updateOne({ operationId, attempt, reconcileLeaseToken: token, reconcileLeaseExpiresAt: { $gt: now } }, { $set: { reconcileLeaseExpiresAt: expires } }).exec();
    return result.matchedCount === 1;
  }
  async updateReconcile(operationId: string, attempt: number, token: string, now: Date, update: OperationUpdate, unset: readonly (keyof PublishOperationRecord)[] = []) {
    const result = await this.#models.operations.updateOne({ operationId, attempt, reconcileLeaseToken: token, reconcileLeaseExpiresAt: { $gt: now } },
      { $set: update, ...(unset.length ? { $unset: Object.fromEntries(unset.map(key => [key, 1])) } : {}) }).exec();
    return result.matchedCount === 1;
  }
  async releaseReconcile(operationId: string, attempt: number, token: string) {
    await this.#models.operations.updateOne({ operationId, attempt, reconcileLeaseToken: token }, { $unset: { reconcileLeaseToken: 1, reconcileLeaseExpiresAt: 1 } }).exec();
  }
  async findPublicationsToCheck(checkedBefore: Date, limit: number) {
    return this.#models.publications
      .find({ $or: [{ checkedAt: { $exists: false }, publishedAt: { $lte: checkedBefore } }, { checkedAt: { $lte: checkedBefore } }] })
      .sort({ checkedAt: 1, publishedAt: 1 })
      .limit(limit)
      .lean()
      .exec();
  }
  async claimPublicationCheck(siteId: string, operationId: string, now: Date, expires: Date, checkedBefore?: Date) {
    const token = randomUUID();
    const result = await this.#models.publications.updateOne({ siteId, operationId, $and: [
      { $or: [{ reconcileLeaseExpiresAt: { $exists: false } }, { reconcileLeaseExpiresAt: { $lte: now } }] },
      ...(checkedBefore ? [{ $or: [{ checkedAt: { $exists: false } }, { checkedAt: { $lte: checkedBefore } }] }] : []),
    ] }, { $set: { reconcileLeaseToken: token, reconcileLeaseExpiresAt: expires } }).exec();
    return result.matchedCount === 1 ? token : undefined;
  }
  async renewPublicationCheck(siteId: string, operationId: string, token: string, now: Date, expires: Date) {
    const result = await this.#models.publications.updateOne({ siteId, operationId, reconcileLeaseToken: token, reconcileLeaseExpiresAt: { $gt: now } }, { $set: { reconcileLeaseExpiresAt: expires } }).exec();
    return result.matchedCount === 1;
  }
  async recordPublicationCheck(siteId: string, operationId: string, check: { readonly checkedAt: Date; readonly observedDeploymentId: string | null }, lease: { readonly token: string; readonly now: Date }) {
    const result = await this.#models.publications.updateOne({ siteId, operationId, reconcileLeaseToken: lease.token, reconcileLeaseExpiresAt: { $gt: lease.now } }, { $set: check }).exec();
    return result.matchedCount === 1;
  }
  async releasePublicationCheck(siteId: string, operationId: string, token: string) {
    await this.#models.publications.updateOne({ siteId, operationId, reconcileLeaseToken: token }, { $unset: { reconcileLeaseToken: 1, reconcileLeaseExpiresAt: 1 } }).exec();
  }
}
