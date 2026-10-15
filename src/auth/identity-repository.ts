import {
  Schema,
  isValidObjectId,
  type Connection,
  type HydratedDocument,
  type Model,
} from "mongoose";
import type {
  GetChatlyQuotaUser,
  GetChatlyQuotaUserRepository,
} from "../billing/getchatly-quota-notification.js";

/**
 * Read-only view of the GetChatly identity collections. Only fields needed for
 * authentication and quota UI synchronization are modelled; Sites never
 * writes these collections and does not own the GetChatly User domain.
 */
export interface GetChatlyUserRecord {
  is_deleted?: boolean;
  status?: string;
  subscription?: GetChatlySubscriptionRecord;
  chat_count?: number;
}
export interface GetChatlySubscriptionRecord {
  plan_type?: string;
  payment_status?: string;
  is_active?: boolean;
}
export type GetChatlyAdminRecord = object;

export interface AuthenticatedIdentityFields {
  readonly _id?: { toString(): string };
  readonly id?: string;
  readonly status?: string;
  readonly subscription?: GetChatlySubscriptionRecord;
  readonly chat_count?: number;
}

export type AuthenticatedUser =
  | (HydratedDocument<GetChatlyUserRecord> & AuthenticatedIdentityFields)
  | (HydratedDocument<GetChatlyAdminRecord> & AuthenticatedIdentityFields)
  | AuthenticatedIdentityFields;

export interface IdentityRepository {
  /** GetChatly `adminUserService.getOne(_id)`: `findOne({ _id })`. */
  findAdmin(userId: string): Promise<AuthenticatedUser | null>;
  /** GetChatly `userService.getOne(_id)`: `findOne({ _id, is_deleted: false })`. */
  findActiveUser(
    userId: string,
  ): Promise<(AuthenticatedUser & { readonly status?: string }) | null>;
}

// Collection names follow mongoose pluralisation of GetChatly's
// `mongoose.model("User")` and `mongoose.model("AdminUser")`.
const userSchema = new Schema<GetChatlyUserRecord>(
  {
    is_deleted: { type: Boolean, default: false },
    status: String,
    subscription: {
      plan_type: String,
      payment_status: String,
      is_active: Boolean,
    },
    chat_count: Number,
  },
  { collection: "users", strict: true, versionKey: false, autoCreate: false, autoIndex: false },
);
const adminSchema = new Schema<GetChatlyAdminRecord>(
  {},
  {
    collection: "adminusers",
    strict: true,
    versionKey: false,
    autoCreate: false,
    autoIndex: false,
  },
);

export const SITES_USER_IDENTITY_PROJECTION = Object.freeze({
  _id: 1,
  is_deleted: 1,
  status: 1,
  "subscription.plan_type": 1,
  "subscription.payment_status": 1,
  "subscription.is_active": 1,
  chat_count: 1,
});

export const SITES_ADMIN_IDENTITY_PROJECTION = Object.freeze({ _id: 1 });
export const SITES_QUOTA_USER_PROJECTION = Object.freeze({
  _id: 0,
  "subscription.is_active": 1,
  chat_count: 1,
});

const getUserModel = (connection: Connection): Model<GetChatlyUserRecord> =>
  (connection.models.GetChatlyUser as Model<GetChatlyUserRecord> | undefined) ??
  connection.model<GetChatlyUserRecord>("GetChatlyUser", userSchema);

export class MongoIdentityRepository implements IdentityRepository {
  readonly #users: Model<GetChatlyUserRecord>;
  readonly #admins: Model<GetChatlyAdminRecord>;
  constructor(connection: Connection) {
    this.#users = getUserModel(connection);
    this.#admins =
      (connection.models.GetChatlyAdminUser as Model<GetChatlyAdminRecord> | undefined) ??
      connection.model<GetChatlyAdminRecord>("GetChatlyAdminUser", adminSchema);
  }
  async findAdmin(userId: string) {
    // A non-ObjectId identifier cannot match a GetChatly account.
    if (!isValidObjectId(userId)) return null;
    return (await this.#admins
      .findOne({ _id: userId })
      .select(SITES_ADMIN_IDENTITY_PROJECTION)
      .exec()) as AuthenticatedUser | null;
  }
  async findActiveUser(userId: string) {
    if (!isValidObjectId(userId)) return null;
    return (await this.#users
      .findOne({ _id: userId, is_deleted: false })
      .select(SITES_USER_IDENTITY_PROJECTION)
      .exec()) as (AuthenticatedUser & { readonly status?: string }) | null;
  }
}

/** Narrow read-only projection used only to reproduce GetChatly's quota event. */
export class MongoGetChatlyQuotaUserRepository implements GetChatlyQuotaUserRepository {
  readonly #users: Model<GetChatlyUserRecord>;

  constructor(connection: Connection) {
    this.#users = getUserModel(connection);
  }

  async findForQuotaNotification(userId: string): Promise<GetChatlyQuotaUser | undefined> {
    if (!isValidObjectId(userId)) return undefined;
    const record = await this.#users
      .findOne({ _id: userId })
      .select(SITES_QUOTA_USER_PROJECTION)
      .lean()
      .exec();
    if (!record) return undefined;
    return {
      ...(record.subscription
        ? { subscription: { isActive: record.subscription.is_active === true } }
        : {}),
      chatCount:
        typeof record.chat_count === "number" && Number.isFinite(record.chat_count)
          ? record.chat_count
          : 0,
    };
  }
}
