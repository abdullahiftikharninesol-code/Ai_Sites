import { Types, type ClientSession, type Connection } from "mongoose";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  SITES_SUBSCRIBER_QUOTA_TYPE,
  creditsAvailableForReservation,
  type CreditDeduction,
  type CreditReservation,
  type SettleChargeInput,
  type SettleChargeResult,
  type SiteBillingLedger,
} from "../../billing/credit-billing.js";
import type { SiteJobRepository } from "../repositories.js";
import type { MongoBillingModels } from "./mongo-billing-models.js";
import type { MongoSubscriberQuotaRepository } from "./mongo-billing-repositories.js";
import type { MongoModels } from "./mongo-models.js";

/** Snapshot reads, majority commit, primary only: a settled charge is durable once acknowledged. */
const TRANSACTION_OPTIONS = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" } as const;
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const userCandidates = (userId: string): readonly (string | Types.ObjectId)[] =>
  Types.ObjectId.isValid(userId) ? [userId, new Types.ObjectId(userId)] : [userId];

/**
 * Settles Sites charges with MongoDB multi-document transactions: the GetChatly
 * `subscriberquotas` debit, the `sites_jobs` PENDING -> CHARGED transition and the
 * hold release commit together or not at all. The job record is therefore the
 * truth about whether a debit happened, which makes PENDING jobs safe to retry
 * after any crash. Requires a replica set or sharded cluster (GetChatly's own
 * backend already relies on transactions); a standalone server makes settlement
 * fail closed, leaving the job PENDING and uncharged.
 */
export class MongoSiteBillingLedger implements SiteBillingLedger {
  constructor(
    private readonly connection: Pick<Connection, "startSession">,
    private readonly models: Pick<MongoModels, "jobs" | "creditHolds">,
    private readonly billingModels: Pick<MongoBillingModels, "subscriberQuotas">,
    private readonly quotas: Pick<MongoSubscriberQuotaRepository, "deduct">,
    private readonly jobs: Pick<SiteJobRepository, "getById">,
  ) {}

  async #transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T | undefined;
      // withTransaction retries transient conflicts (e.g. two settlements or
      // reservations racing on the same quota or hold document) from scratch.
      await session.withTransaction(async () => { result = await work(session); }, TRANSACTION_OPTIONS);
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  async reserve(input: { readonly userId: string; readonly jobId: string; readonly credits: number; readonly expiresAt: Date }): Promise<CreditReservation> {
    return this.#transaction(async (session) => {
      const quota = await this.billingModels.subscriberQuotas
        .findOne({ user: { $in: userCandidates(input.userId) }, type: SITES_SUBSCRIBER_QUOTA_TYPE })
        .select({ token_credit: 1, token_credit_used: 1, is_credit_implemented: 1 })
        .session(session)
        .lean()
        .exec();
      if (!quota || quota.is_credit_implemented !== true)
        throw new ApplicationError("CREDIT_QUOTA_NOT_FOUND", "Credit quota is unavailable");
      const now = new Date();
      const record = await this.models.creditHolds.findOne({ _id: input.userId }).session(session).lean().exec();
      // Delivered-but-unsettled charges, from the job records themselves.
      const pendingCharges = await this.models.jobs
        .find({ ownerId: input.userId, billingStatus: "PENDING" })
        .select({ jobId: 1, creditsCalculated: 1 })
        .session(session)
        .lean()
        .exec();
      const { availableCredits, liveHolds: active } = creditsAvailableForReservation({
        tokenCredit: finite(quota.token_credit), tokenCreditUsed: finite(quota.token_credit_used),
        holds: record?.holds ?? [], pendingCharges, jobId: input.jobId, now,
      });
      if (availableCredits <= 0)
        throw new ApplicationError("CREDIT_LIMIT_REACHED", "GetChatly credits are fully reserved by running Sites jobs", {
          metadata: { reason: "reserved_by_running_jobs" },
        });
      const reservedCredits = Math.min(finite(input.credits), availableCredits);
      // Rewriting the user's single hold document makes concurrent reservations
      // conflict, so the second one re-reads and sees the first one's hold.
      await this.models.creditHolds
        .updateOne(
          { _id: input.userId },
          { $set: { holds: [...active, { jobId: input.jobId, credits: reservedCredits, expiresAt: input.expiresAt }], updatedAt: now } },
          { upsert: true, session },
        )
        .exec();
      return { reservedCredits, availableCredits };
    });
  }

  async release(input: { readonly userId: string; readonly jobId: string }): Promise<void> {
    await this.models.creditHolds
      .updateOne({ _id: input.userId }, { $pull: { holds: { jobId: input.jobId } }, $set: { updatedAt: new Date() } })
      .exec();
  }

  async settle(input: SettleChargeInput): Promise<SettleChargeResult> {
    const settled = await this.#transaction(async (session) => {
      const filter = { jobId: input.jobId, billingStatus: "PENDING" as const, ...(input.attemptId ? { billingAttemptId: input.attemptId } : {}) };
      const pending = await this.models.jobs.findOne(filter).session(session).lean().exec();
      if (!pending) return undefined;
      const deduction: CreditDeduction = await this.quotas.deduct({
        userId: input.userId,
        calculatedCredits: input.calculatedCredits,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      }, { session });
      const now = new Date();
      // Same CHARGED fields every ledger writes (see chargedJobState).
      const clamped = deduction.actualCharge < input.calculatedCredits;
      const result = await this.models.jobs
        .updateOne(filter, {
          $set: {
            billingStatus: "CHARGED",
            creditsCharged: deduction.actualCharge,
            creditsCalculated: input.calculatedCredits,
            chargedAt: now,
            updatedAt: now,
            ...(clamped ? { billingErrorCode: "CREDIT_LIMIT_REACHED" } : {}),
          },
          ...(clamped ? {} : { $unset: { billingErrorCode: 1 } }),
        }, { session })
        .exec();
      // Aborts the whole transaction, including the debit above.
      if (result.modifiedCount !== 1)
        throw new ApplicationError("BILLING_SETTLEMENT_CONFLICT", "The site job left PENDING during settlement");
      await this.models.creditHolds
        .updateOne({ _id: input.userId }, { $pull: { holds: { jobId: input.jobId } }, $set: { updatedAt: now } }, { session })
        .exec();
      return deduction;
    });
    const job = await this.jobs.getById(input.jobId);
    if (!settled) return { kind: "NOT_PENDING", job };
    // Committed (debit included) but not readable: never report this as "no debit".
    if (!job) throw new ApplicationError("BILLING_STATE_READ_FAILED", "The settled site job could not be read back");
    return { kind: "CHARGED", job, deduction: settled, persisted: true };
  }
}
