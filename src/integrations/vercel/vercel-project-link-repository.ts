import { Schema, type Connection, type Model } from "mongoose";

/**
 * Which Vercel project an AI Sites site publishes to. One record per site.
 * CREATING is a short lease that serializes project creation across requests
 * and server processes; STALE marks a linked project that no longer exists.
 */
export interface VercelProjectLinkRecord {
  readonly siteId: string;
  readonly ownerId: string;
  readonly configurationId: string;
  /** Vercel account that owns the project: the team ID, or the user ID for personal installs. */
  readonly accountId: string;
  readonly teamId: string | null;
  readonly projectName: string;
  readonly projectId?: string;
  readonly status: "CREATING" | "LINKED" | "STALE";
  readonly leaseId?: string;
  readonly leaseExpiresAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly linkedAt?: Date;
}

export interface ProjectLinkClaim {
  readonly siteId: string;
  readonly ownerId: string;
  readonly configurationId: string;
  readonly accountId: string;
  readonly teamId: string | null;
  readonly projectName: string;
  readonly leaseId: string;
  readonly now: Date;
  readonly leaseExpiresAt: Date;
}

export interface VercelProjectLinkRepository {
  find(siteId: string): Promise<VercelProjectLinkRecord | undefined>;
  /**
   * Takes the creation lease when no link exists, the previous lease expired,
   * the link is STALE, or it points at a different installation/account.
   * False when another request holds the lease or a matching link exists.
   */
  claimCreation(claim: ProjectLinkClaim): Promise<boolean>;
  completeLink(siteId: string, leaseId: string, project: { readonly projectId: string; readonly projectName: string; readonly accountId: string; readonly now: Date }): Promise<boolean>;
  /** Ends a failed attempt's lease early so an explicit retry can proceed. */
  releaseLease(siteId: string, leaseId: string, now: Date): Promise<void>;
  markStale(siteId: string, projectId: string, now: Date): Promise<void>;
}

const schema = new Schema<VercelProjectLinkRecord>(
  {
    siteId: { type: String, required: true, unique: true, immutable: true },
    ownerId: { type: String, required: true, index: true },
    configurationId: { type: String, required: true },
    accountId: { type: String, required: true },
    teamId: { type: String, default: null },
    projectName: { type: String, required: true },
    projectId: String,
    status: { type: String, required: true, enum: ["CREATING", "LINKED", "STALE"] },
    leaseId: String,
    leaseExpiresAt: Date,
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    linkedAt: Date,
  },
  { collection: "sites_vercel_project_links", versionKey: false, strict: "throw" },
);

export const createVercelProjectLinkModel = (connection: Connection): Model<VercelProjectLinkRecord> =>
  (connection.models.SitesVercelProjectLink as Model<VercelProjectLinkRecord> | undefined) ??
  connection.model<VercelProjectLinkRecord>("SitesVercelProjectLink", schema);

export class MongoVercelProjectLinkRepository implements VercelProjectLinkRepository {
  readonly #model: Model<VercelProjectLinkRecord>;
  constructor(connection: Connection) {
    this.#model = createVercelProjectLinkModel(connection);
  }
  ready(): Promise<void> { return this.#model.createIndexes(); }
  async find(siteId: string) {
    return (await this.#model.findOne({ siteId }).lean().exec()) ?? undefined;
  }
  async claimCreation(claim: ProjectLinkClaim) {
    try {
      // Upsert: inserts when no record exists; the unique siteId index turns a
      // concurrent insert, or a record that does not match, into a duplicate key.
      await this.#model
        .updateOne(
          {
            siteId: claim.siteId,
            ownerId: claim.ownerId,
            $or: [
              { status: "CREATING", leaseExpiresAt: { $lte: claim.now } },
              { status: "STALE" },
              { status: "LINKED", configurationId: { $ne: claim.configurationId } },
              { status: "LINKED", accountId: { $ne: claim.accountId } },
            ],
          },
          {
            $set: {
              configurationId: claim.configurationId,
              accountId: claim.accountId,
              teamId: claim.teamId,
              projectName: claim.projectName,
              status: "CREATING",
              leaseId: claim.leaseId,
              leaseExpiresAt: claim.leaseExpiresAt,
              updatedAt: claim.now,
            },
            $unset: { projectId: 1, linkedAt: 1 },
            $setOnInsert: { createdAt: claim.now },
          },
          { upsert: true },
        )
        .exec();
      return true;
    } catch (error) {
      if ((error as { code?: unknown })?.code === 11000) return false;
      throw error;
    }
  }
  async completeLink(siteId: string, leaseId: string, project: Parameters<VercelProjectLinkRepository["completeLink"]>[2]) {
    const result = await this.#model
      .updateOne(
        { siteId, leaseId, status: "CREATING" },
        {
          $set: { status: "LINKED", projectId: project.projectId, projectName: project.projectName, accountId: project.accountId, linkedAt: project.now, updatedAt: project.now },
          $unset: { leaseId: 1, leaseExpiresAt: 1 },
        },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  async releaseLease(siteId: string, leaseId: string, now: Date) {
    await this.#model.updateOne({ siteId, leaseId, status: "CREATING" }, { $set: { leaseExpiresAt: now, updatedAt: now } }).exec();
  }
  async markStale(siteId: string, projectId: string, now: Date) {
    await this.#model.updateOne({ siteId, projectId, status: "LINKED" }, { $set: { status: "STALE", updatedAt: now } }).exec();
  }
}
