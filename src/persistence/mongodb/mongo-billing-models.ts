import { Schema, type Connection, type Model, type Types } from "mongoose";

export interface MongoSubscriberQuotaRecord {
  user: Types.ObjectId | string;
  type: string;
  count: number;
  limit: number;
  token_credit: number;
  token_credit_used: number;
  is_credit_implemented: boolean;
  chat_request_tokens: number;
  chat_response_tokens: number;
  model_credit_list: unknown[];
}

export interface MongoImageModelCreditRecord {
  name: string;
  type: string;
  platform?: string | null;
  creditsPer500Tokens: number;
}

export interface MongoBillingModels {
  readonly subscriberQuotas: Model<MongoSubscriberQuotaRecord>;
  readonly imageModelCredits: Model<MongoImageModelCreditRecord>;
}

const subscriberQuotaSchema = new Schema<MongoSubscriberQuotaRecord>(
  {
    user: { type: Schema.Types.Mixed, required: true },
    type: { type: String, required: true },
    count: { type: Number, default: 0 },
    limit: { type: Number, default: 0 },
    token_credit: { type: Number, required: true },
    token_credit_used: { type: Number, required: true },
    is_credit_implemented: { type: Boolean, required: true },
    chat_request_tokens: { type: Number, default: 0 },
    chat_response_tokens: { type: Number, default: 0 },
    model_credit_list: { type: [Schema.Types.Mixed], default: [] },
  },
  {
    collection: "subscriberquotas",
    versionKey: false,
    strict: true,
    autoCreate: false,
    autoIndex: false,
  },
);

const imageModelCreditSchema = new Schema<MongoImageModelCreditRecord>(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    platform: { type: String, default: null },
    creditsPer500Tokens: { type: Number, required: true },
  },
  {
    collection: "imagemodelcredits",
    versionKey: false,
    strict: true,
    autoCreate: false,
    autoIndex: false,
  },
);

export function createMongoBillingModels(connection: Connection): MongoBillingModels {
  return {
    subscriberQuotas:
      (connection.models.GetChatlySubscriberQuota as
        Model<MongoSubscriberQuotaRecord> | undefined) ??
      connection.model<MongoSubscriberQuotaRecord>(
        "GetChatlySubscriberQuota",
        subscriberQuotaSchema,
      ),
    imageModelCredits:
      (connection.models.GetChatlyImageModelCredit as
        Model<MongoImageModelCreditRecord> | undefined) ??
      connection.model<MongoImageModelCreditRecord>(
        "GetChatlyImageModelCredit",
        imageModelCreditSchema,
      ),
  };
}
