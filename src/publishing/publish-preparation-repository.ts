import { Schema, type Connection, type Model } from "mongoose";
import type { SiteRoutingMode, StaticArtifactSummary } from "./static-artifact.js";

/**
 * Non-public publishing preparation state. A READY_TO_DEPLOY record is a
 * validated production build bound to one exact saved version; it never
 * means the site is live and never carries a public URL or access token.
 */
export type PublishPreparationStatus = "PREPARING" | "READY_TO_DEPLOY" | "PREPARATION_FAILED";

export interface PublishPreparationArtifact {
  readonly ref: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly routing: SiteRoutingMode;
  readonly indexSha256: string;
  readonly summary: StaticArtifactSummary;
}

export interface PublishPreparationProject {
  readonly status: "NOT_LINKED" | "LINKED";
  readonly projectId?: string;
  readonly projectName?: string;
  readonly accountId?: string;
}

export interface PublishPreparationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface PublishPreparationRecord {
  readonly preparationId: string;
  /** sha256(provider, owner, site, version, source digest, configuration): one preparation per exact input. */
  readonly idempotencyKey: string;
  readonly provider: "vercel";
  readonly ownerId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly sourceArtifactRef: string;
  readonly sourceSha256: string;
  /** Vercel identity only; tokens stay encrypted on the connection record. */
  readonly connection: { readonly configurationId: string; readonly teamId: string | null; readonly vercelUserId: string };
  readonly status: PublishPreparationStatus;
  readonly attempt: number;
  readonly leaseExpiresAt?: Date;
  readonly artifact?: PublishPreparationArtifact;
  readonly project?: PublishPreparationProject;
  readonly failure?: PublishPreparationFailure;
  readonly metrics?: { readonly installMs: number; readonly buildMs: number; readonly totalMs: number };
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
  /** After this the artifact is not consumed for deployment; a new request prepares again. */
  readonly expiresAt?: Date;
}

export interface PublishPreparationCompletion {
  readonly status: Exclude<PublishPreparationStatus, "PREPARING">;
  readonly project?: PublishPreparationProject;
  readonly failure?: PublishPreparationFailure;
  readonly completedAt: Date;
  readonly expiresAt?: Date;
}

export interface PublishPreparationRepository {
  /** Inserts a new PREPARING record; false when the idempotency key already exists. */
  insert(record: PublishPreparationRecord): Promise<boolean>;
  findByKey(idempotencyKey: string): Promise<PublishPreparationRecord | undefined>;
  findOwned(ownerId: string, preparationId: string): Promise<PublishPreparationRecord | undefined>;
  findLatestForSite(ownerId: string, siteId: string): Promise<PublishPreparationRecord | undefined>;
  /**
   * Atomically takes over a retryable failure, an abandoned (lease-expired)
   * attempt or an expired READY record: increments `attempt`, which fences out
   * any previous worker. Failures stop being claimable after `maxAttempts`.
   */
  claim(idempotencyKey: string, input: { readonly now: Date; readonly leaseExpiresAt: Date; readonly maxAttempts: number; readonly connection: PublishPreparationRecord["connection"] }): Promise<PublishPreparationRecord | undefined>;
  /** Records the validated artifact for the current attempt (lets a retry skip the build). */
  saveArtifact(preparationId: string, attempt: number, artifact: PublishPreparationArtifact, metrics: NonNullable<PublishPreparationRecord["metrics"]>, now: Date): Promise<boolean>;
  /** Finishes the attempt; ignored (false) when another attempt has taken over. */
  complete(preparationId: string, attempt: number, completion: PublishPreparationCompletion): Promise<boolean>;
}

const artifactSchema = new Schema<PublishPreparationArtifact>(
  {
    ref: { type: String, required: true },
    sha256: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    fileCount: { type: Number, required: true },
    totalBytes: { type: Number, required: true },
    routing: { type: String, required: true, enum: ["history", "hash", "none"] },
    indexSha256: { type: String, required: true },
    summary: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false, strict: "throw" },
);

const schema = new Schema<PublishPreparationRecord>(
  {
    preparationId: { type: String, required: true, unique: true, immutable: true },
    idempotencyKey: { type: String, required: true, unique: true, immutable: true },
    provider: { type: String, required: true, enum: ["vercel"] },
    ownerId: { type: String, required: true },
    siteId: { type: String, required: true },
    versionId: { type: String, required: true },
    versionNumber: { type: Number, required: true },
    sourceArtifactRef: { type: String, required: true },
    sourceSha256: { type: String, required: true },
    connection: {
      type: new Schema(
        { configurationId: { type: String, required: true }, teamId: { type: String, default: null }, vercelUserId: { type: String, required: true } },
        { _id: false, strict: "throw" },
      ),
      required: true,
    },
    status: { type: String, required: true, enum: ["PREPARING", "READY_TO_DEPLOY", "PREPARATION_FAILED"] },
    attempt: { type: Number, required: true, min: 1 },
    leaseExpiresAt: Date,
    artifact: { type: artifactSchema, required: false },
    project: {
      type: new Schema(
        { status: { type: String, required: true, enum: ["NOT_LINKED", "LINKED"] }, projectId: String, projectName: String, accountId: String },
        { _id: false, strict: "throw" },
      ),
      required: false,
    },
    failure: {
      type: new Schema(
        { code: { type: String, required: true }, message: { type: String, required: true }, retryable: { type: Boolean, required: true }, metadata: Schema.Types.Mixed },
        { _id: false, strict: "throw" },
      ),
      required: false,
    },
    metrics: {
      type: new Schema({ installMs: Number, buildMs: Number, totalMs: Number }, { _id: false, strict: "throw" }),
      required: false,
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    completedAt: Date,
    expiresAt: Date,
  },
  { collection: "sites_publish_preparations", versionKey: false, strict: "throw" },
);
schema.index({ ownerId: 1, siteId: 1, createdAt: -1 });

export const createPublishPreparationModel = (connection: Connection): Model<PublishPreparationRecord> =>
  (connection.models.SitesPublishPreparation as Model<PublishPreparationRecord> | undefined) ??
  connection.model<PublishPreparationRecord>("SitesPublishPreparation", schema);

const isDuplicateKey = (error: unknown) => (error as { code?: unknown })?.code === 11000;

export class MongoPublishPreparationRepository implements PublishPreparationRepository {
  readonly #model: Model<PublishPreparationRecord>;
  constructor(connection: Connection) {
    this.#model = createPublishPreparationModel(connection);
  }
  async insert(record: PublishPreparationRecord) {
    try {
      await this.#model.create(record);
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }
  async findByKey(idempotencyKey: string) {
    return (await this.#model.findOne({ idempotencyKey }).lean().exec()) ?? undefined;
  }
  async findOwned(ownerId: string, preparationId: string) {
    return (await this.#model.findOne({ preparationId, ownerId }).lean().exec()) ?? undefined;
  }
  async findLatestForSite(ownerId: string, siteId: string) {
    return (await this.#model.findOne({ ownerId, siteId }).sort({ createdAt: -1 }).lean().exec()) ?? undefined;
  }
  async claim(idempotencyKey: string, input: Parameters<PublishPreparationRepository["claim"]>[1]) {
    const record = await this.#model
      .findOneAndUpdate(
        {
          idempotencyKey,
          $or: [
            { status: "PREPARATION_FAILED", "failure.retryable": true, attempt: { $lt: input.maxAttempts } },
            { status: "PREPARING", leaseExpiresAt: { $lte: input.now }, attempt: { $lt: input.maxAttempts } },
            { status: "READY_TO_DEPLOY", expiresAt: { $lte: input.now } },
          ],
        },
        {
          $set: { status: "PREPARING", leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now, connection: input.connection },
          $inc: { attempt: 1 },
          $unset: { failure: 1, completedAt: 1, expiresAt: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();
    return record ?? undefined;
  }
  async saveArtifact(preparationId: string, attempt: number, artifact: PublishPreparationArtifact, metrics: NonNullable<PublishPreparationRecord["metrics"]>, now: Date) {
    const result = await this.#model
      .updateOne({ preparationId, attempt, status: "PREPARING" }, { $set: { artifact, metrics, updatedAt: now } })
      .exec();
    return result.modifiedCount === 1;
  }
  async complete(preparationId: string, attempt: number, completion: PublishPreparationCompletion) {
    const set: Record<string, unknown> = { status: completion.status, completedAt: completion.completedAt, updatedAt: completion.completedAt };
    const unset: Record<string, 1> = { leaseExpiresAt: 1 };
    if (completion.project) set.project = completion.project;
    if (completion.failure) set.failure = completion.failure;
    else unset.failure = 1;
    if (completion.expiresAt) set.expiresAt = completion.expiresAt;
    const result = await this.#model
      .updateOne({ preparationId, attempt, status: "PREPARING" }, { $set: set, $unset: unset })
      .exec();
    return result.modifiedCount === 1;
  }
}
