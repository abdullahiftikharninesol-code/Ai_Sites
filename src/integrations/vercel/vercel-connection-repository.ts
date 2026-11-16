import { Schema, type Connection, type Model } from "mongoose";
import type { VercelConnectionProblem, VercelVerificationState } from "./vercel-account-verifier.js";

export interface VercelOAuthStateRecord {
  /** SHA-256 of the state value; the raw state is never stored. */
  readonly stateHash: string;
  readonly ownerId: string;
  /** Site whose editor the user returns to; ownership is checked when issued and on return. */
  readonly siteId?: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

export interface ConsumedVercelState {
  readonly ownerId: string;
  readonly siteId?: string;
}

export interface VercelConnectionRecord {
  readonly ownerId: string;
  readonly configurationId: string;
  readonly vercelUserId: string;
  readonly teamId: string | null;
  readonly tokenType: string;
  /** AES-256-GCM envelope; removed on disconnect. */
  readonly encryptedAccessToken?: string;
  readonly status: "active" | "disconnected";
  readonly connectedAt: Date;
  readonly updatedAt: Date;
  readonly disconnectedAt?: Date;
  /** Last verification against Vercel (cached; status reads don't call Vercel every time). */
  readonly verification?: {
    readonly state: VercelVerificationState;
    readonly problem?: VercelConnectionProblem;
    readonly accountType: "personal" | "team";
    readonly displayName?: string;
    readonly checkedAt: Date;
  };
}

export type ActiveVercelConnection = VercelConnectionRecord & {
  readonly status: "active";
  readonly encryptedAccessToken: string;
};

export class VercelConfigurationConflictError extends Error {
  constructor() {
    super("Vercel configuration is linked to another account");
    this.name = "VercelConfigurationConflictError";
  }
}

export interface VercelIntegrationRepository {
  createState(record: VercelOAuthStateRecord): Promise<void>;
  /**
   * Atomically marks an unexpired, unused state as consumed and returns its
   * owner. Returns undefined for unknown, expired or already-consumed states.
   */
  consumeState(stateHash: string, now: Date): Promise<ConsumedVercelState | undefined>;
  /** Invalidates the owner's unused states so only the newest authorization can complete. */
  expireOpenStates(ownerId: string, now: Date): Promise<void>;
  findActiveConnection(ownerId: string): Promise<ActiveVercelConnection | undefined>;
  findConnectionByConfiguration(
    configurationId: string,
  ): Promise<VercelConnectionRecord | undefined>;
  /** Creates or replaces the owner's single Vercel connection. */
  saveConnection(record: ActiveVercelConnection): Promise<void>;
  /** Marks the connection disconnected and erases the stored token. */
  markDisconnected(ownerId: string, configurationId: string, now: Date): Promise<boolean>;
  /** Records a verification for this exact active connection (no-op if it was replaced or disconnected). */
  saveVerification(ownerId: string, configurationId: string, verification: NonNullable<VercelConnectionRecord["verification"]>): Promise<void>;
}

const isActive = (
  record: VercelConnectionRecord | undefined | null,
): record is ActiveVercelConnection =>
  record?.status === "active" && typeof record.encryptedAccessToken === "string";

const stateSchema = new Schema<VercelOAuthStateRecord>(
  {
    stateHash: { type: String, required: true, unique: true },
    ownerId: { type: String, required: true, index: true },
    siteId: String,
    createdAt: { type: Date, required: true },
    // MongoDB removes expired documents; consumeState also checks expiry.
    expiresAt: { type: Date, required: true, expires: 0 },
    consumedAt: Date,
  },
  { collection: "sites_vercel_oauth_states", versionKey: false, strict: "throw" },
);

const connectionSchema = new Schema<VercelConnectionRecord>(
  {
    ownerId: { type: String, required: true, unique: true },
    configurationId: { type: String, required: true, unique: true },
    vercelUserId: { type: String, required: true },
    teamId: { type: String, default: null },
    tokenType: { type: String, required: true },
    encryptedAccessToken: String,
    status: { type: String, required: true, enum: ["active", "disconnected"] },
    connectedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    disconnectedAt: Date,
    verification: {
      type: new Schema(
        {
          state: { type: String, required: true, enum: ["OK", "REAUTHORIZATION_REQUIRED", "UNAVAILABLE"] },
          problem: String,
          accountType: { type: String, required: true, enum: ["personal", "team"] },
          displayName: String,
          checkedAt: { type: Date, required: true },
        },
        { _id: false, strict: "throw" },
      ),
      required: false,
    },
  },
  { collection: "sites_vercel_connections", versionKey: false, strict: "throw" },
);

export const createVercelIntegrationModels = (connection: Connection) => ({
  states:
    (connection.models.SitesVercelOAuthState as Model<VercelOAuthStateRecord> | undefined) ??
    connection.model<VercelOAuthStateRecord>("SitesVercelOAuthState", stateSchema),
  connections:
    (connection.models.SitesVercelConnection as Model<VercelConnectionRecord> | undefined) ??
    connection.model<VercelConnectionRecord>("SitesVercelConnection", connectionSchema),
});

const isDuplicateKey = (error: unknown) => (error as { code?: unknown })?.code === 11000;

export class MongoVercelIntegrationRepository implements VercelIntegrationRepository {
  readonly #models: ReturnType<typeof createVercelIntegrationModels>;
  constructor(connection: Connection) {
    this.#models = createVercelIntegrationModels(connection);
  }
  async createState(record: VercelOAuthStateRecord) {
    await this.#models.states.create(record);
  }
  async consumeState(stateHash: string, now: Date) {
    const record = await this.#models.states
      .findOneAndUpdate(
        { stateHash, consumedAt: { $exists: false }, expiresAt: { $gt: now } },
        { $set: { consumedAt: now } },
        { new: true },
      )
      .lean()
      .exec();
    if (!record) return undefined;
    return record.siteId
      ? { ownerId: record.ownerId, siteId: record.siteId }
      : { ownerId: record.ownerId };
  }
  async expireOpenStates(ownerId: string, now: Date) {
    await this.#models.states
      .updateMany({ ownerId, consumedAt: { $exists: false } }, { $set: { consumedAt: now } })
      .exec();
  }
  async findActiveConnection(ownerId: string) {
    const record = await this.#models.connections
      .findOne({ ownerId, status: "active" })
      .lean()
      .exec();
    return isActive(record) ? record : undefined;
  }
  async findConnectionByConfiguration(configurationId: string) {
    return (await this.#models.connections.findOne({ configurationId }).lean().exec()) ?? undefined;
  }
  async saveConnection(record: ActiveVercelConnection) {
    try {
      await this.#models.connections
        .updateOne(
          { ownerId: record.ownerId },
          // A new or renewed authorization starts unverified.
          { $set: record, $unset: { disconnectedAt: 1, ...("verification" in record ? {} : { verification: 1 }) } },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if (isDuplicateKey(error)) throw new VercelConfigurationConflictError();
      throw error;
    }
  }
  async markDisconnected(ownerId: string, configurationId: string, now: Date) {
    const result = await this.#models.connections
      .updateOne(
        { ownerId, configurationId, status: "active" },
        {
          $set: { status: "disconnected", disconnectedAt: now, updatedAt: now },
          $unset: { encryptedAccessToken: 1 },
        },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  async saveVerification(ownerId: string, configurationId: string, verification: NonNullable<VercelConnectionRecord["verification"]>) {
    await this.#models.connections.updateOne({ ownerId, configurationId, status: "active" }, { $set: { verification } }).exec();
  }
}
