import { Types } from "mongoose";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  SITES_MODEL_CREDIT_TYPE,
  SITES_SUBSCRIBER_QUOTA_TYPE,
  modelRateNotFound,
  type ModelCreditRateRepository,
  type SubscriberQuotaRepository,
} from "../../billing/credit-billing.js";
import type { MongoBillingModels, MongoSubscriberQuotaRecord } from "./mongo-billing-models.js";

const finiteNonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const userCandidates = (userId: string): readonly (string | Types.ObjectId)[] =>
  Types.ObjectId.isValid(userId) ? [userId, new Types.ObjectId(userId)] : [userId];

export const SITES_SUBSCRIBER_QUOTA_PROJECTION = Object.freeze({
  _id: 1,
  user: 1,
  type: 1,
  count: 1,
  limit: 1,
  chat_request_tokens: 1,
  chat_response_tokens: 1,
  is_credit_implemented: 1,
  token_credit: 1,
  token_credit_used: 1,
  model_credit_list: 1,
});

const SITES_QUOTA_DIAGNOSTIC_PROJECTION = Object.freeze({
  _id: 0,
  is_credit_implemented: 1,
  token_credit: 1,
  token_credit_used: 1,
});

type DeductionFailureReason =
  | "quota_not_found"
  | "modern_credit_flag_mismatch"
  | "invalid_numeric_data"
  | "exhausted_quota"
  | "conditional_update_matched_no_document"
  | "atomic_update_error"
  | "diagnostic_read_failed";

export class MongoModelCreditRateRepository implements ModelCreditRateRepository {
  constructor(private readonly models: MongoBillingModels) {}

  async resolve(input: { readonly provider: string; readonly model: string }) {
    const records = await this.models.imageModelCredits
      .find({ name: input.model, type: SITES_MODEL_CREDIT_TYPE })
      .lean()
      .exec();
    const provider = input.provider.trim().toLowerCase();
    const valid = records.filter(
      (record) => Number.isFinite(record.creditsPer500Tokens) && record.creditsPer500Tokens > 0,
    );
    const platformMatches = valid.filter(
      (record) => record.platform?.trim().toLowerCase() === provider,
    );
    const platformless = valid.filter((record) => !record.platform?.trim());
    const selected =
      platformMatches.length === 1
        ? platformMatches[0]
        : platformMatches.length === 0 && platformless.length === 1
          ? platformless[0]
          : undefined;
    if (!selected) throw modelRateNotFound(input.provider, input.model);
    return {
      creditsPer500Tokens: selected.creditsPer500Tokens,
      model: selected.name,
      platform: selected.platform?.trim() || null,
      type: selected.type,
    };
  }
}

export class MongoSubscriberQuotaRepository implements SubscriberQuotaRepository {
  constructor(private readonly models: MongoBillingModels) {}

  async findForUser(userId: string) {
    const record = await this.models.subscriberQuotas
      .findOne({ user: { $in: userCandidates(userId) }, type: SITES_SUBSCRIBER_QUOTA_TYPE })
      .select(SITES_SUBSCRIBER_QUOTA_PROJECTION)
      .lean()
      .exec();
    return record ? quotaFrom(record, userId) : undefined;
  }

  async deduct(input: {
    readonly userId: string;
    readonly calculatedCredits: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }) {
    if (!Number.isFinite(input.calculatedCredits) || input.calculatedCredits < 0)
      throw new ApplicationError("CREDIT_DEDUCTION_FAILED", "Calculated credits are invalid", {
        metadata: { reason: "invalid_numeric_data" },
      });
    let before: MongoSubscriberQuotaRecord | null;
    try {
      before = await this.models.subscriberQuotas
        .findOneAndUpdate(
          {
            user: { $in: userCandidates(input.userId) },
            type: SITES_SUBSCRIBER_QUOTA_TYPE,
            is_credit_implemented: true,
          },
          [
            {
              $set: {
                token_credit_used: {
                  $min: [
                    { $max: [0, { $ifNull: ["$token_credit", 0] }] },
                    {
                      $add: [
                        { $max: [0, { $ifNull: ["$token_credit_used", 0] }] },
                        input.calculatedCredits,
                      ],
                    },
                  ],
                },
                chat_request_tokens: {
                  $add: [
                    { $max: [0, { $ifNull: ["$chat_request_tokens", 0] }] },
                    finiteNonNegative(input.inputTokens),
                  ],
                },
                chat_response_tokens: {
                  $add: [
                    { $max: [0, { $ifNull: ["$chat_response_tokens", 0] }] },
                    finiteNonNegative(input.outputTokens),
                  ],
                },
              },
            },
          ],
          {
            // Mongoose 9 rejects array updates unless this opt-in is explicit.
            updatePipeline: true,
            // The pre-update values are required to report the exact clamped
            // charge while the returned repository state is calculated below.
            returnDocument: "before",
          },
        )
        .lean()
        .exec();
    } catch (cause) {
      throw await this.#operationFailure(input.userId, cause);
    }
    if (!before) {
      const reason = await this.#diagnoseNoMatch(input.userId);
      throw new ApplicationError(
        "CREDIT_QUOTA_NOT_FOUND",
        "The enabled GetChatly credit quota could not be updated",
        { metadata: { reason } },
      );
    }
    const tokenCredit = finiteNonNegative(before.token_credit);
    const tokenCreditUsed = finiteNonNegative(before.token_credit_used);
    const actualCharge = Math.min(
      input.calculatedCredits,
      Math.max(0, tokenCredit - tokenCreditUsed),
    );
    return {
      actualCharge,
      tokenCreditUsed: tokenCreditUsed + actualCharge,
      tokenCredit,
    };
  }

  async #operationFailure(userId: string, cause: unknown): Promise<ApplicationError> {
    const diagnosed = await this.#diagnoseNoMatch(userId);
    const reason: DeductionFailureReason =
      diagnosed === "conditional_update_matched_no_document" ? "atomic_update_error" : diagnosed;
    const errorType = cause instanceof Error ? cause.name : typeof cause;
    const rawCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { readonly code?: unknown }).code
        : undefined;
    const metadata: Record<string, unknown> = { reason, errorType };
    if (typeof rawCode === "string" || typeof rawCode === "number") metadata.mongoCode = rawCode;
    return new ApplicationError(
      "CREDIT_DEDUCTION_FAILED",
      "The atomic GetChatly credit deduction failed",
      { cause, metadata },
    );
  }

  async #diagnoseNoMatch(userId: string): Promise<DeductionFailureReason> {
    try {
      const record = await this.models.subscriberQuotas
        .findOne({
          user: { $in: userCandidates(userId) },
          type: SITES_SUBSCRIBER_QUOTA_TYPE,
        })
        .select(SITES_QUOTA_DIAGNOSTIC_PROJECTION)
        .lean()
        .exec();
      if (!record) return "quota_not_found";
      if (record.is_credit_implemented !== true) return "modern_credit_flag_mismatch";
      if (
        !isFiniteNonNegative(record.token_credit) ||
        !isFiniteNonNegative(record.token_credit_used)
      )
        return "invalid_numeric_data";
      if (record.token_credit_used >= record.token_credit) return "exhausted_quota";
      return "conditional_update_matched_no_document";
    } catch {
      return "diagnostic_read_failed";
    }
  }
}

const quotaFrom = (
  record: MongoSubscriberQuotaRecord & { readonly _id?: unknown },
  userId: string,
) => ({
  id: record._id,
  user: record.user,
  userId,
  type: record.type,
  count: finiteNonNegative(record.count),
  limit: finiteNonNegative(record.limit),
  tokenCredit: finiteNonNegative(record.token_credit),
  tokenCreditUsed: finiteNonNegative(record.token_credit_used),
  isCreditImplemented: record.is_credit_implemented === true,
  chatRequestTokens: finiteNonNegative(record.chat_request_tokens),
  chatResponseTokens: finiteNonNegative(record.chat_response_tokens),
  modelCreditList: Array.isArray(record.model_credit_list) ? record.model_credit_list : [],
});
