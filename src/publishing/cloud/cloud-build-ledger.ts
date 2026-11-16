import { Schema, type Connection, type Model } from "mongoose";

/**
 * Coordinator-only bookkeeping for cloud builds (the worker never touches
 * MongoDB). One record per submitted build: quotas, interrupted-build
 * reconciliation and reference-aware cleanup of transfer objects use it.
 * Transfer objects are never the canonical artifact (that is stored through
 * the Stage 2 ArtifactStore), so a terminal build's objects become deletable
 * after `transferDeletableAfter`; nothing is deleted automatically yet.
 */
export type CloudBuildStatus = "SUBMITTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "REJECTED";

export interface CloudBuildRecord {
  readonly buildId: string;
  readonly ownerId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly sourceSha256: string;
  readonly requestSha256: string;
  readonly requestObject: string;
  readonly resultObject: string;
  readonly status: CloudBuildStatus;
  readonly executionId?: string;
  readonly failureCode?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
  readonly transferDeletableAfter?: Date;
}

/** Evidence from a probe execution of the pinned worker image (no tenant data). */
export interface CloudIsolationAttestation {
  readonly attestationId: string;
  /** Hash of the verified job configuration the probe ran under. */
  readonly configHash: string;
  readonly image: string;
  readonly executionId: string;
  readonly passed: boolean;
  readonly violations: readonly string[];
  readonly createdAt: Date;
}

export interface CloudBuildLedger {
  insertBuild(record: CloudBuildRecord): Promise<void>;
  updateBuild(buildId: string, update: Partial<Omit<CloudBuildRecord, "buildId" | "ownerId" | "createdAt">>): Promise<void>;
  countOwnerBuildsSince(ownerId: string, since: Date): Promise<number>;
  /** Submitted or running builds of this exact source (interrupted attempts to reconcile). */
  findUnfinished(siteId: string, sourceSha256: string): Promise<readonly CloudBuildRecord[]>;
  saveAttestation(attestation: CloudIsolationAttestation): Promise<void>;
  latestAttestation(configHash: string): Promise<CloudIsolationAttestation | undefined>;
}

const buildSchema = new Schema<CloudBuildRecord>(
  {
    buildId: { type: String, required: true, unique: true, immutable: true },
    ownerId: { type: String, required: true },
    siteId: { type: String, required: true },
    versionId: { type: String, required: true },
    sourceSha256: { type: String, required: true },
    requestSha256: { type: String, required: true },
    requestObject: { type: String, required: true },
    resultObject: { type: String, required: true },
    status: { type: String, required: true, enum: ["SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "REJECTED"] },
    executionId: String,
    failureCode: String,
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    completedAt: Date,
    transferDeletableAfter: Date,
  },
  { collection: "sites_cloud_builds", versionKey: false, strict: "throw" },
);
buildSchema.index({ ownerId: 1, createdAt: -1 });
buildSchema.index({ siteId: 1, sourceSha256: 1, status: 1 });
buildSchema.index({ transferDeletableAfter: 1 }, { sparse: true });

const attestationSchema = new Schema<CloudIsolationAttestation>(
  {
    attestationId: { type: String, required: true, unique: true, immutable: true },
    configHash: { type: String, required: true },
    image: { type: String, required: true },
    executionId: { type: String, required: true },
    passed: { type: Boolean, required: true },
    violations: { type: [String], required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: "sites_cloud_build_attestations", versionKey: false, strict: "throw" },
);
attestationSchema.index({ configHash: 1, createdAt: -1 });

export const createCloudBuildModels = (connection: Connection) => ({
  builds:
    (connection.models.SitesCloudBuild as Model<CloudBuildRecord> | undefined) ??
    connection.model<CloudBuildRecord>("SitesCloudBuild", buildSchema),
  attestations:
    (connection.models.SitesCloudBuildAttestation as Model<CloudIsolationAttestation> | undefined) ??
    connection.model<CloudIsolationAttestation>("SitesCloudBuildAttestation", attestationSchema),
});

export class MongoCloudBuildLedger implements CloudBuildLedger {
  readonly #models: ReturnType<typeof createCloudBuildModels>;
  constructor(connection: Connection) {
    this.#models = createCloudBuildModels(connection);
  }
  async insertBuild(record: CloudBuildRecord) {
    await this.#models.builds.create(record);
  }
  async updateBuild(buildId: string, update: Parameters<CloudBuildLedger["updateBuild"]>[1]) {
    await this.#models.builds.updateOne({ buildId }, { $set: update }).exec();
  }
  async countOwnerBuildsSince(ownerId: string, since: Date) {
    return this.#models.builds.countDocuments({ ownerId, createdAt: { $gte: since }, status: { $ne: "REJECTED" } }).exec();
  }
  async findUnfinished(siteId: string, sourceSha256: string) {
    return this.#models.builds.find({ siteId, sourceSha256, status: { $in: ["SUBMITTED", "RUNNING"] } }).limit(10).lean().exec();
  }
  async saveAttestation(attestation: CloudIsolationAttestation) {
    await this.#models.attestations.create(attestation);
  }
  async latestAttestation(configHash: string) {
    return (await this.#models.attestations.findOne({ configHash }).sort({ createdAt: -1 }).lean().exec()) ?? undefined;
  }
}
