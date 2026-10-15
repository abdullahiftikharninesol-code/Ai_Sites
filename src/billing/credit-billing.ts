import { ApplicationError } from "../app/errors/application-error.js";
import type { InferenceRunSummary } from "../agents/budget/inference-run-context.js";
import type { SiteJob } from "../sites/domain/entities.js";
import type { SiteJobRepository } from "../persistence/repositories.js";
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
  constructor(
    private readonly rates: ModelCreditRateRepository,
    private readonly quotas: SubscriberQuotaRepository,
    private readonly jobs: SiteJobRepository,
    private readonly quotaNotifier?: QuotaChangeNotifier,
    private readonly diagnosticLogger: CreditBillingDiagnosticLogger = console,
  ) {}

  async preflight(input: {
    readonly userId: string;
    readonly provider: string;
    readonly model: string;
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
    return { userId: input.userId, provider: input.provider, modelRate };
  }

  async finalizeSuccessfulJob(
    job: SiteJob,
    summary: InferenceRunSummary,
    authorization: BillingAuthorization,
  ): Promise<SiteJob> {
    if (job.status !== "SUCCEEDED" || job.websiteGenerated !== true) return job;
    let claimed = false;
    try {
      claimed = await this.jobs.claimBilling(job.id);
    } catch (cause) {
      return this.#billingFailure(job, "BILLING_CLAIM_FAILED", cause);
    }
    if (!claimed) return (await this.jobs.getById(job.id)) ?? job;

    const actualProviders = new Set(summary.providersUsed);
    const actualModels = new Set(summary.modelsUsed);
    if (
      actualProviders.size !== 1 ||
      !actualProviders.has(authorization.provider) ||
      actualModels.size !== 1 ||
      !actualModels.has(authorization.modelRate.model)
    )
      return this.#billingFailure(
        job,
        "BILLING_MODEL_MISMATCH",
        new ApplicationError(
          "BILLING_MODEL_MISMATCH",
          "Actual provider/model usage does not match the authorized billing rate",
        ),
      );

    const usage = summary.providerUsage;
    const billable = calculateBillableTokenUsage({
      provider: authorization.provider,
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      ...(usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: usage.cachedInputTokens }
        : {}),
      ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    });
    let charged: SiteJob;
    try {
      const calculatedCredits = calculateCreditsUsed({
        billableTokens: billable.billableTokens,
        creditsPer500Tokens: authorization.modelRate.creditsPer500Tokens,
      });
      const deduction = await this.quotas.deduct({
        userId: authorization.userId,
        calculatedCredits,
        inputTokens: nonNegativeFinite(usage?.inputTokens),
        outputTokens: nonNegativeFinite(usage?.outputTokens),
      });
      charged = {
        ...job,
        model: authorization.modelRate.model,
        billingStatus: "CHARGED",
        billableInputTokens: billable.billableInputTokens,
        billableOutputTokens: billable.billableOutputTokens,
        billableTokens: billable.billableTokens,
        creditsPer500Tokens: authorization.modelRate.creditsPer500Tokens,
        creditsCharged: deduction.actualCharge,
        chargedAt: new Date(),
        updatedAt: new Date(),
      };
      await this.jobs.save(charged);
    } catch (cause) {
      this.diagnosticLogger.warn(
        "[sites][billing] credit finalization failed",
        safeBillingFailureDiagnostic(cause),
      );
      return this.#billingFailure(job, billingErrorCode(cause), cause, {
        ...billable,
        creditsPer500Tokens: authorization.modelRate.creditsPer500Tokens,
      });
    }
    if (this.quotaNotifier) {
      try {
        await this.quotaNotifier.notifyGetChatlyQuotaChanged(authorization.userId);
      } catch {
        // Notification is deliberately outside the durable billing catch path.
        console.warn("[sites][billing] GetChatly quota synchronization failed");
      }
    }
    return charged;
  }

  async #billingFailure(
    job: SiteJob,
    code: string,
    cause: unknown,
    details: Partial<BillableTokenUsage> & { readonly creditsPer500Tokens?: number } = {},
  ): Promise<SiteJob> {
    const failed: SiteJob = {
      ...job,
      ...details,
      billingStatus: "FAILED",
      billingErrorCode: code,
      creditsCharged: 0,
      updatedAt: new Date(),
    };
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
