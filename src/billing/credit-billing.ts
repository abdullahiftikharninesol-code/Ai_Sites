import { randomUUID } from "node:crypto";
import { ApplicationError } from "../app/errors/application-error.js";
import type { InferenceRunSummary } from "../agents/budget/inference-run-context.js";
import { DEFAULT_INFERENCE_BUDGET_LIMITS } from "../agents/budget/agent-run-budget.js";
import type { SiteJob } from "../sites/domain/entities.js";
import type { SiteJobChargeIntent, SiteJobRepository } from "../persistence/repositories.js";
import type { JobId } from "../shared/types.js";
import type { QuotaChangeNotifier } from "./getchatly-quota-notification.js";

export const SITES_MODEL_CREDIT_TYPE = "ai_chat";
export const SITES_SUBSCRIBER_QUOTA_TYPE = "image";

export interface ModelCreditRate {
  readonly creditsPer500Tokens: number;
  readonly model: string;
  readonly platform: string | null;
  readonly type: string;
}

export interface SubscriberQuota {
  readonly id: unknown;
  readonly user: unknown;
  readonly userId: string;
  readonly type: string;
  readonly count: number;
  readonly limit: number;
  readonly tokenCredit: number;
  readonly tokenCreditUsed: number;
  readonly isCreditImplemented: boolean;
  readonly chatRequestTokens: number;
  readonly chatResponseTokens: number;
  readonly modelCreditList: readonly unknown[];
}

export interface CreditDeduction {
  readonly actualCharge: number;
  readonly tokenCreditUsed: number;
  readonly tokenCredit: number;
}

export interface ModelCreditRateRepository {
  resolve(input: { readonly provider: string; readonly model: string }): Promise<ModelCreditRate>;
}

export interface SubscriberQuotaRepository {
  findForUser(userId: string): Promise<SubscriberQuota | undefined>;
  deduct(input: {
    readonly userId: string;
    readonly calculatedCredits: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }): Promise<CreditDeduction>;
}

export interface BillingAuthorization {
  readonly userId: string;
  readonly provider: string;
  readonly modelRate: ModelCreditRate;
  /** Present when credits were reserved for a specific job. */
  readonly jobId?: string;
  readonly reservedCredits?: number;
  /** Most tokens the reserved credits can pay for at the authorized rate. */
  readonly maxTotalTokens?: number;
}

/** A hold is released on settlement or failure; this bounds a hold left by a crash. */
export const CREDIT_RESERVATION_TTL_MS = 60 * 60 * 1000;
/** PENDING jobs untouched for this long are treated as interrupted and settled by recovery. */
export const BILLING_RECOVERY_GRACE_MS = 5 * 60 * 1000;

export interface CreditReservation {
  readonly reservedCredits: number;
  readonly availableCredits: number;
}

export interface SettleChargeInput {
  readonly jobId: JobId;
  readonly attemptId: string | undefined;
  readonly userId: string;
  readonly calculatedCredits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type SettleChargeResult =
  | { readonly kind: "CHARGED"; readonly job: SiteJob; readonly deduction: CreditDeduction; readonly persisted: boolean }
  | { readonly kind: "NOT_PENDING"; readonly job: SiteJob | undefined };

/**
 * Exactly-once settlement of a PENDING job against the shared GetChatly balance,
 * plus short-lived reservations so concurrent jobs cannot collectively spend
 * more than the balance can pay for. Not a wallet: the GetChatly subscriber
 * quota stays the only balance; holds only subtract from what a new job may use.
 */
export interface SiteBillingLedger {
  reserve(input: { readonly userId: string; readonly jobId: string; readonly credits: number; readonly expiresAt: Date }): Promise<CreditReservation>;
  release(input: { readonly userId: string; readonly jobId: string }): Promise<void>;
  settle(input: SettleChargeInput): Promise<SettleChargeResult>;
}

export interface BillingRecoveryReport {
  readonly examined: number;
  readonly charged: number;
  readonly failed: number;
  readonly stillPending: number;
  /** Stale jobs another worker leased first in this pass. */
  readonly leasedElsewhere?: number;
}

/** Periodic recovery cadence and per-pass bound. */
export const BILLING_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
export const BILLING_RECOVERY_BATCH_LIMIT = 100;

export interface CreditHold { readonly jobId: string; readonly credits: number; readonly expiresAt: Date }
export interface PendingCharge { readonly jobId: string; readonly creditsCalculated?: number }

/**
 * What a new reservation may use, shared by every ledger. Each Sites job counts
 * once: while it runs, through its (expiring) hold; once its site is delivered and
 * the charge is PENDING, through that recorded charge, which never expires, so an
 * unsettled debt stays protected after its hold lapses. Expired holds of
 * abandoned work drop out, so nothing is held indefinitely.
 */
export function creditsAvailableForReservation(input: {
  readonly tokenCredit: number;
  readonly tokenCreditUsed: number;
  readonly holds: readonly CreditHold[];
  readonly pendingCharges: readonly PendingCharge[];
  readonly jobId: string;
  readonly now: Date;
}): { readonly availableCredits: number; readonly liveHolds: readonly CreditHold[] } {
  const pending = input.pendingCharges.filter((charge) => charge.jobId !== input.jobId);
  const pendingIds = new Set(pending.map((charge) => charge.jobId));
  // Holds of PENDING jobs are kept (released at settlement) but not double counted.
  const liveHolds = input.holds.filter((hold) => hold.jobId !== input.jobId && new Date(hold.expiresAt).getTime() > input.now.getTime());
  const held = liveHolds.filter((hold) => !pendingIds.has(hold.jobId)).reduce((sum, hold) => sum + nonNegativeFinite(hold.credits), 0);
  const owed = pending.reduce((sum, charge) => sum + nonNegativeFinite(charge.creditsCalculated), 0);
  return {
    availableCredits: Math.max(0, nonNegativeFinite(input.tokenCredit) - nonNegativeFinite(input.tokenCreditUsed) - held - owed),
    liveHolds,
  };
}

/** The CHARGED state written together with the debit. Shared by every ledger. */
export function chargedJobState(job: SiteJob, deduction: CreditDeduction, calculatedCredits: number, now = new Date()): SiteJob {
  const { billingErrorCode: _previous, ...rest } = job;
  void _previous;
  return {
    ...rest,
    billingStatus: "CHARGED",
    creditsCharged: deduction.actualCharge,
    creditsCalculated: calculatedCredits,
    // The balance ran out between reservation and settlement (e.g. GetChatly
    // usage elsewhere): GetChatly's clamp-to-limit rule applies, and is visible.
    ...(deduction.actualCharge < calculatedCredits ? { billingErrorCode: "CREDIT_LIMIT_REACHED" } : {}),
    chargedAt: now,
    updatedAt: now,
  };
}

/** Errors proving the debit did not happen, so the job may be recorded as FAILED. */
const NO_DEBIT_CODES = new Set(["CREDIT_QUOTA_NOT_FOUND", "CREDIT_BILLING_NOT_ENABLED", "MODEL_CREDIT_RATE_NOT_FOUND", "BILLING_SETTLEMENT_CONFLICT"]);
const NO_DEBIT_REASONS = new Set(["quota_not_found", "modern_credit_flag_mismatch", "invalid_numeric_data", "exhausted_quota"]);
function provesNoDebit(cause: unknown): boolean {
  if (!(cause instanceof ApplicationError)) return false;
  if (NO_DEBIT_CODES.has(cause.code)) return true;
  const reason = cause.metadata?.reason;
  return cause.code === "CREDIT_DEDUCTION_FAILED" && typeof reason === "string" && NO_DEBIT_REASONS.has(reason);
}

export interface BillableTokenUsage {
  readonly billableInputTokens: number;
  readonly billableOutputTokens: number;
  readonly billableTokens: number;
}

export interface CreditBillingDiagnosticLogger {
  warn(message: string, details: Readonly<Record<string, unknown>>): void;
}

const nonNegativeFinite = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function calculateBillableTokenUsage(input: {
  readonly provider: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}): BillableTokenUsage {
  const provider = input.provider.trim().toLowerCase();
  const inputTokens = nonNegativeFinite(input.inputTokens);
  const cachedInputTokens = nonNegativeFinite(input.cachedInputTokens);
  const billableInputTokens =
    provider === "anthropic" ? inputTokens : Math.max(0, inputTokens - cachedInputTokens);
  const billableOutputTokens = nonNegativeFinite(input.outputTokens);
  return {
    billableInputTokens,
    billableOutputTokens,
    billableTokens: billableInputTokens + billableOutputTokens,
  };
}

export function calculateCreditsUsed(input: {
  readonly billableTokens: number;
  readonly creditsPer500Tokens: number;
}): number {
  const billableTokens = nonNegativeFinite(input.billableTokens);
  if (!Number.isFinite(input.creditsPer500Tokens) || input.creditsPer500Tokens <= 0)
    throw new ApplicationError(
      "MODEL_CREDIT_RATE_NOT_FOUND",
      "The selected model does not have a valid credit rate",
    );
  return (input.creditsPer500Tokens * billableTokens) / 500;
}

export class SiteCreditBillingService {
  readonly #ledger: SiteBillingLedger;

  constructor(
    private readonly rates: ModelCreditRateRepository,
    private readonly quotas: SubscriberQuotaRepository,
    private readonly jobs: SiteJobRepository,
    private readonly quotaNotifier?: QuotaChangeNotifier,
    private readonly diagnosticLogger: CreditBillingDiagnosticLogger = console,
    ledger?: SiteBillingLedger,
  ) {
    this.#ledger = ledger ?? new RepositoryBillingLedger(quotas, jobs);
  }

  /**
   * Rejects before any provider call when the rate or balance is missing. With a
   * jobId, also reserves credits for that job against the shared balance (minus
   * other running jobs' holds) and returns the token ceiling those credits can
   * pay for at the existing rate, so a nearly empty balance cannot fund an
   * unbounded run and concurrent jobs cannot spend the same credits.
   */
  async preflight(input: {
    readonly userId: string;
    readonly provider: string;
    readonly model: string;
    readonly jobId?: string;
    readonly maxTotalTokens?: number;
  }): Promise<BillingAuthorization> {
    const modelRate = await this.rates.resolve({ provider: input.provider, model: input.model });
    const quota = await this.quotas.findForUser(input.userId);
    if (!quota)
      throw new ApplicationError(
        "CREDIT_QUOTA_NOT_FOUND",
        "No GetChatly credit quota exists for the authenticated user",
      );
    if (!quota.isCreditImplemented)
      throw new ApplicationError(
        "CREDIT_BILLING_NOT_ENABLED",
        "The authenticated user's modern credit quota is not enabled",
      );
    const available = nonNegativeFinite(quota.tokenCredit);
    const used = nonNegativeFinite(quota.tokenCreditUsed);
    if (used >= available)
      throw new ApplicationError("CREDIT_LIMIT_REACHED", "GetChatly credit limit reached");
    if (!input.jobId) return { userId: input.userId, provider: input.provider, modelRate };

    const budgetTokens = nonNegativeFinite(input.maxTotalTokens ?? DEFAULT_INFERENCE_BUDGET_LIMITS.maxTotalTokens);
    const wanted = calculateCreditsUsed({ billableTokens: budgetTokens, creditsPer500Tokens: modelRate.creditsPer500Tokens });
    const reservation = await this.#ledger.reserve({
      userId: input.userId, jobId: input.jobId, credits: wanted, expiresAt: new Date(Date.now() + CREDIT_RESERVATION_TTL_MS),
    });
    const maxTotalTokens = Math.floor((reservation.reservedCredits * 500) / modelRate.creditsPer500Tokens);
    if (maxTotalTokens <= 0) {
      await this.#ledger.release({ userId: input.userId, jobId: input.jobId }).catch(() => undefined);
      throw new ApplicationError("CREDIT_LIMIT_REACHED", "Remaining GetChatly credits cannot pay for any model tokens", {
        metadata: { reason: "insufficient_for_any_tokens", availableCredits: reservation.availableCredits },
      });
    }
    return { userId: input.userId, provider: input.provider, modelRate, jobId: input.jobId,
      reservedCredits: reservation.reservedCredits, maxTotalTokens };
  }

  /** Releases a job's credit hold (failed, unchanged or abandoned jobs). Idempotent. */
  async releaseReservation(authorization: BillingAuthorization | undefined): Promise<void> {
    if (!authorization?.jobId) return;
    try { await this.#ledger.release({ userId: authorization.userId, jobId: authorization.jobId }); }
    catch { this.diagnosticLogger.warn("[sites][billing] credit reservation release failed", { errorCode: "CREDIT_RESERVATION_RELEASE_FAILED" }); }
  }

  /**
   * The durable charge intent, computed without any debit. Callers persist it in
   * the same write that marks the job SUCCEEDED, so a crash at any later point
   * leaves a PENDING job that recovery settles exactly once.
   */
  prepareCharge(job: SiteJob, summary: InferenceRunSummary, authorization: BillingAuthorization): SiteJob {
    if (job.status !== "SUCCEEDED" || job.websiteGenerated !== true || job.billingStatus !== "NOT_CHARGED") return job;
    const actualProviders = new Set(summary.providersUsed);
    const actualModels = new Set(summary.modelsUsed);
    if (
      actualProviders.size !== 1 ||
      !actualProviders.has(authorization.provider) ||
      actualModels.size !== 1 ||
      !actualModels.has(authorization.modelRate.model)
    )
      return { ...job, billingStatus: "FAILED", billingErrorCode: "BILLING_MODEL_MISMATCH", creditsCharged: 0, updatedAt: new Date() };
    const usage = summary.providerUsage;
    const billable = calculateBillableTokenUsage({
      provider: authorization.provider,
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    });
    const now = new Date();
    const { creditsCharged: _unsettled, billingErrorCode: _previous, ...rest } = job;
    void _unsettled; void _previous;
    return {
      ...rest,
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      model: authorization.modelRate.model,
      billingStatus: "PENDING",
      billingAttemptId: randomUUID(),
      billingClaimedAt: now,
      billableInputTokens: billable.billableInputTokens,
      billableOutputTokens: billable.billableOutputTokens,
      billableTokens: billable.billableTokens,
      creditsPer500Tokens: authorization.modelRate.creditsPer500Tokens,
      creditsCalculated: calculateCreditsUsed({
        billableTokens: billable.billableTokens,
        creditsPer500Tokens: authorization.modelRate.creditsPer500Tokens,
      }),
      updatedAt: now,
    };
  }

  /**
   * Settles a successful job exactly once. Accepts a NOT_CHARGED job (claims it
   * atomically first) or a PENDING job already persisted by prepareCharge.
   * Repeating the call, or racing recovery, never debits twice.
   */
  async finalizeSuccessfulJob(
    job: SiteJob,
    summary: InferenceRunSummary,
    authorization: BillingAuthorization,
  ): Promise<SiteJob> {
    if (job.status !== "SUCCEEDED" || job.websiteGenerated !== true) {
      await this.releaseReservation(authorization);
      return job;
    }
    let pending = job;
    if (job.billingStatus === "NOT_CHARGED") {
      const prepared = this.prepareCharge(job, summary, authorization);
      let claimed: boolean;
      try {
        claimed = await this.jobs.claimBilling(job.id, prepared.billingStatus === "PENDING" ? chargeIntent(prepared) : undefined);
      } catch (cause) {
        // The claim did not happen, so nothing can have been debited.
        await this.releaseReservation(authorization);
        return this.#recordNoDebit(job, "BILLING_CLAIM_FAILED", cause);
      }
      if (!claimed) return (await this.jobs.getById(job.id)) ?? job;
      if (prepared.billingStatus === "FAILED") {
        await this.releaseReservation(authorization);
        return this.#recordNoDebit(prepared, "BILLING_MODEL_MISMATCH");
      }
      pending = prepared;
    } else if (job.billingStatus !== "PENDING") {
      return job;
    } else if (job.creditsCalculated === undefined) {
      // A PENDING job without a recorded intent cannot be priced safely here.
      return job;
    }
    return this.#settle(pending, authorization.userId);
  }

  /**
   * Settles PENDING jobs left by an interrupted process (crash or failed write
   * after the intent was recorded). Safe to run at every start and repeatedly:
   * settlement is exactly-once per job.
   */
  async recoverPendingJobs(options: { readonly olderThanMs?: number; readonly limit?: number; readonly now?: Date } = {}): Promise<BillingRecoveryReport> {
    if (!this.jobs.listPendingBilling) return { examined: 0, charged: 0, failed: 0, stillPending: 0, leasedElsewhere: 0 };
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - (options.olderThanMs ?? BILLING_RECOVERY_GRACE_MS));
    const pending = await this.jobs.listPendingBilling(cutoff, options.limit ?? BILLING_RECOVERY_BATCH_LIMIT);
    let charged = 0, failed = 0, stillPending = 0, leasedElsewhere = 0;
    for (const job of pending) {
      // One worker per stale job per grace period. The lease limits duplicate work;
      // exactly-once debiting itself is guaranteed by the ledger's settlement.
      if (this.jobs.leasePendingBilling && !(await this.jobs.leasePendingBilling(job.id, cutoff, now))) {
        leasedElsewhere += 1;
        continue;
      }
      const result = job.creditsCalculated === undefined || job.status !== "SUCCEEDED" || job.websiteGenerated !== true
        ? job
        : await this.#settle(job, String(job.userId));
      if (result.billingStatus === "CHARGED") charged += 1;
      else if (result.billingStatus === "FAILED") failed += 1;
      else stillPending += 1;
    }
    return { examined: pending.length, charged, failed, stillPending, leasedElsewhere };
  }

  /**
   * Runs recovery now and then every intervalMs, one bounded batch at a time and
   * never overlapping itself. Safe on every worker. Returns a stop function.
   */
  startRecoveryLoop(options: {
    readonly intervalMs?: number;
    readonly limit?: number;
    readonly olderThanMs?: number;
    readonly onReport?: (report: BillingRecoveryReport) => void;
    readonly onError?: (cause: unknown) => void;
  } = {}): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const intervalMs = Math.max(1_000, options.intervalMs ?? BILLING_RECOVERY_INTERVAL_MS);
    const pass = async () => {
      try {
        const report = await this.recoverPendingJobs({
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.olderThanMs !== undefined ? { olderThanMs: options.olderThanMs } : {}),
        });
        options.onReport?.(report);
      } catch (cause) {
        options.onError?.(cause);
      } finally {
        if (!stopped) {
          timer = setTimeout(() => { void pass(); }, intervalMs);
          // Never keeps the process alive on its own.
          timer.unref?.();
        }
      }
    };
    void pass();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  async #settle(pending: SiteJob, userId: string): Promise<SiteJob> {
    let result: SettleChargeResult;
    try {
      result = await this.#ledger.settle({
        jobId: pending.id,
        attemptId: pending.billingAttemptId,
        userId,
        calculatedCredits: nonNegativeFinite(pending.creditsCalculated),
        inputTokens: nonNegativeFinite(pending.inputTokens),
        outputTokens: nonNegativeFinite(pending.outputTokens),
      });
    } catch (cause) {
      this.diagnosticLogger.warn("[sites][billing] credit finalization failed", safeBillingFailureDiagnostic(cause));
      // The job record is the source of truth: a settlement may have committed
      // even though its acknowledgement was lost.
      const current = await this.jobs.getById(pending.id).catch(() => undefined);
      if (current && current.billingStatus !== "PENDING") return current;
      if (provesNoDebit(cause)) {
        await this.#ledger.release({ userId, jobId: pending.id }).catch(() => undefined);
        return this.#recordNoDebit(pending, billingErrorCode(cause), cause);
      }
      // Outcome unknown: stay PENDING (never "0 credits charged") for recovery or review.
      const { creditsCharged: _unknown, ...rest } = pending;
      void _unknown;
      return { ...rest, billingStatus: "PENDING", billingErrorCode: "CREDIT_DEDUCTION_OUTCOME_UNKNOWN" };
    }
    if (result.kind === "NOT_PENDING") return result.job ?? pending;
    if (this.quotaNotifier) {
      try {
        await this.quotaNotifier.notifyGetChatlyQuotaChanged(userId);
      } catch {
        // Notification is deliberately outside the durable billing catch path.
        console.warn("[sites][billing] GetChatly quota synchronization failed");
      }
    }
    // Debited but the CHARGED record could not be written: report the real charge.
    return result.persisted ? result.job : { ...result.job, billingErrorCode: "BILLING_STATE_PERSISTENCE_FAILED" };
  }

  /** Only for outcomes where no debit happened: FAILED with zero credits is then true. */
  async #recordNoDebit(job: SiteJob, code: string, cause?: unknown): Promise<SiteJob> {
    const failed: SiteJob = { ...job, billingStatus: "FAILED", billingErrorCode: code, creditsCharged: 0, updatedAt: new Date() };
    try {
      await this.jobs.save(failed);
    } catch {
      // The generated site remains committed. The original error is retained
      // in the returned object even when the billing-state write also fails.
    }
    void cause;
    return failed;
  }
}

const CHARGE_INTENT_KEYS = ["billingAttemptId", "billingClaimedAt", "model", "billableInputTokens", "billableOutputTokens",
  "billableTokens", "creditsPer500Tokens", "creditsCalculated"] as const;
const chargeIntent = (job: SiteJob): SiteJobChargeIntent =>
  Object.fromEntries(CHARGE_INTENT_KEYS.filter((key) => job[key] !== undefined).map((key) => [key, job[key]]));

/**
 * Ledger over the generic repositories. Exactly-once within this process (per-job
 * and per-user locks, plus remembered outcomes when a CHARGED write fails), which
 * is complete for the in-memory stores. Durable stores that can commit the debit
 * and job record together use their own ledger (see MongoSiteBillingLedger).
 */
export class RepositoryBillingLedger implements SiteBillingLedger {
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #holds = new Map<string, Map<string, { credits: number; expiresAt: number }>>();
  readonly #settled = new Map<string, { job: SiteJob; deduction: CreditDeduction }>();

  constructor(
    private readonly quotas: SubscriberQuotaRepository,
    private readonly jobs: SiteJobRepository,
  ) {}

  async #locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#locks.set(key, next);
    try { return await next; } finally { if (this.#locks.get(key) === next) this.#locks.delete(key); }
  }

  async reserve(input: { readonly userId: string; readonly jobId: string; readonly credits: number; readonly expiresAt: Date }): Promise<CreditReservation> {
    return this.#locked(`user:${input.userId}`, async () => {
      const quota = await this.quotas.findForUser(input.userId);
      if (!quota || !quota.isCreditImplemented)
        throw new ApplicationError("CREDIT_QUOTA_NOT_FOUND", "Credit quota is unavailable");
      const now = new Date();
      const holds = this.#holds.get(input.userId) ?? new Map<string, { credits: number; expiresAt: number }>();
      const pendingCharges = (await this.jobs.listPendingBillingForUser?.(input.userId) ?? [])
        .map((job) => ({ jobId: String(job.id), ...(job.creditsCalculated !== undefined ? { creditsCalculated: job.creditsCalculated } : {}) }));
      const { availableCredits, liveHolds } = creditsAvailableForReservation({
        tokenCredit: quota.tokenCredit, tokenCreditUsed: quota.tokenCreditUsed, pendingCharges, jobId: input.jobId, now,
        holds: [...holds].map(([jobId, hold]) => ({ jobId, credits: hold.credits, expiresAt: new Date(hold.expiresAt) })),
      });
      // Drop expired holds of abandoned work.
      for (const jobId of [...holds.keys()]) if (!liveHolds.some((hold) => hold.jobId === jobId)) holds.delete(jobId);
      if (availableCredits <= 0)
        throw new ApplicationError("CREDIT_LIMIT_REACHED", "GetChatly credits are fully reserved by running Sites jobs", {
          metadata: { reason: "reserved_by_running_jobs" },
        });
      const reservedCredits = Math.min(nonNegativeFinite(input.credits), availableCredits);
      holds.set(input.jobId, { credits: reservedCredits, expiresAt: input.expiresAt.getTime() });
      this.#holds.set(input.userId, holds);
      return { reservedCredits, availableCredits };
    });
  }

  async release(input: { readonly userId: string; readonly jobId: string }): Promise<void> {
    await this.#locked(`user:${input.userId}`, () => { this.#holds.get(input.userId)?.delete(input.jobId); return Promise.resolve(); });
  }

  async settle(input: SettleChargeInput): Promise<SettleChargeResult> {
    return this.#locked(`job:${input.jobId}`, async () => {
      const known = this.#settled.get(input.jobId);
      if (known) {
        // Already debited by this process: only the record may still be missing.
        const current = await this.jobs.getById(input.jobId);
        if (current?.billingStatus === "CHARGED") return { kind: "NOT_PENDING" as const, job: current };
        try { await this.jobs.save(known.job); return { kind: "CHARGED" as const, ...known, persisted: true }; }
        catch { return { kind: "CHARGED" as const, ...known, persisted: false }; }
      }
      const current = await this.jobs.getById(input.jobId);
      if (!current || current.billingStatus !== "PENDING" ||
        (current.billingAttemptId !== undefined && input.attemptId !== undefined && current.billingAttemptId !== input.attemptId))
        return { kind: "NOT_PENDING" as const, job: current };
      const deduction = await this.quotas.deduct({
        userId: input.userId,
        calculatedCredits: input.calculatedCredits,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      });
      const job = chargedJobState({ ...current, ...(current.creditsCalculated === undefined ? { creditsCalculated: input.calculatedCredits } : {}) },
        deduction, input.calculatedCredits);
      this.#settled.set(input.jobId, { job, deduction });
      this.#holds.get(input.userId)?.delete(input.jobId);
      try { await this.jobs.save(job); return { kind: "CHARGED" as const, job, deduction, persisted: true }; }
      catch { return { kind: "CHARGED" as const, job, deduction, persisted: false }; }
    });
  }
}

const billingErrorCode = (cause: unknown): string =>
  cause instanceof ApplicationError ? cause.code : "CREDIT_DEDUCTION_FAILED";

const safeBillingFailureDiagnostic = (cause: unknown): Readonly<Record<string, unknown>> => {
  if (cause instanceof ApplicationError) {
    const reason = cause.metadata?.reason;
    return {
      errorCode: cause.code,
      reason: typeof reason === "string" ? reason : "domain_error",
      errorType: cause.name,
    };
  }
  return {
    errorCode: "CREDIT_DEDUCTION_FAILED",
    reason: "unexpected_error",
    errorType: cause instanceof Error ? cause.name : typeof cause,
  };
};

export class InMemoryModelCreditRateRepository implements ModelCreditRateRepository {
  constructor(private readonly records: readonly ModelCreditRate[] = []) {}

  async resolve(input: { readonly provider: string; readonly model: string }) {
    const candidates = this.records.filter(
      (record) => record.model === input.model && record.type === SITES_MODEL_CREDIT_TYPE,
    );
    const provider = input.provider.toLowerCase();
    const platformMatch = candidates.find((record) => record.platform?.toLowerCase() === provider);
    const platformless = candidates.filter((record) => !record.platform);
    const selected = platformMatch ?? (platformless.length === 1 ? platformless[0] : undefined);
    if (
      !selected ||
      !Number.isFinite(selected.creditsPer500Tokens) ||
      selected.creditsPer500Tokens <= 0
    )
      throw modelRateNotFound(input.provider, input.model);
    return selected;
  }
}

export class InMemorySubscriberQuotaRepository implements SubscriberQuotaRepository {
  readonly records = new Map<string, SubscriberQuota>();

  constructor(records: readonly SubscriberQuota[] = []) {
    for (const record of records) this.records.set(record.userId, structuredClone(record));
  }

  async findForUser(userId: string) {
    const record = this.records.get(userId);
    return record ? structuredClone(record) : undefined;
  }

  async deduct(input: {
    readonly userId: string;
    readonly calculatedCredits: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }): Promise<CreditDeduction> {
    const record = this.records.get(input.userId);
    if (!record || record.type !== SITES_SUBSCRIBER_QUOTA_TYPE || !record.isCreditImplemented)
      throw new ApplicationError("CREDIT_QUOTA_NOT_FOUND", "Credit quota is unavailable");
    const remaining = Math.max(0, record.tokenCredit - record.tokenCreditUsed);
    const actualCharge = Math.min(input.calculatedCredits, remaining);
    const updated: SubscriberQuota = {
      ...record,
      tokenCreditUsed: record.tokenCreditUsed + actualCharge,
      chatRequestTokens: record.chatRequestTokens + nonNegativeFinite(input.inputTokens),
      chatResponseTokens: record.chatResponseTokens + nonNegativeFinite(input.outputTokens),
    };
    this.records.set(input.userId, updated);
    return {
      actualCharge,
      tokenCreditUsed: updated.tokenCreditUsed,
      tokenCredit: updated.tokenCredit,
    };
  }
}

export const modelRateNotFound = (provider: string, model: string) =>
  new ApplicationError(
    "MODEL_CREDIT_RATE_NOT_FOUND",
    `No valid GetChatly credit rate exists for ${provider}/${model}`,
    {
      metadata: {
        provider,
        model,
        type: SITES_MODEL_CREDIT_TYPE,
        platformRule: "exact provider or null",
      },
    },
  );
