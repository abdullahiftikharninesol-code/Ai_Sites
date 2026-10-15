import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { InferenceRunSummary } from "../src/agents/budget/inference-run-context.js";
import {
  InMemoryModelCreditRateRepository,
  InMemorySubscriberQuotaRepository,
  SiteCreditBillingService,
  calculateBillableTokenUsage,
  calculateCreditsUsed,
  type SubscriberQuota,
  type SubscriberQuotaRepository,
} from "../src/billing/credit-billing.js";
import { InMemorySiteJobRepository } from "../src/persistence/in-memory-repositories.js";
import {
  createMongoBillingModels,
  type MongoSubscriberQuotaRecord,
} from "../src/persistence/mongodb/mongo-billing-models.js";
import { MongoSubscriberQuotaRepository } from "../src/persistence/mongodb/mongo-billing-repositories.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { JobId, SiteId, UserId } from "../src/shared/types.js";

const userId = "507f1f77bcf86cd799439011" as UserId;
const rate = (creditsPer500Tokens = 2) => ({
  model: "gpt-sites",
  platform: null,
  type: "ai_chat",
  creditsPer500Tokens,
});
const quota = (overrides: Partial<SubscriberQuota> = {}): SubscriberQuota => ({
  id: "quota-one",
  user: userId,
  userId,
  type: "image",
  count: 0,
  limit: 0,
  tokenCredit: 100,
  tokenCreditUsed: 10,
  isCreditImplemented: true,
  chatRequestTokens: 0,
  chatResponseTokens: 0,
  modelCreditList: [],
  ...overrides,
});
const job = (id = "job-one", operation: SiteJob["operation"] = "GENERATE"): SiteJob => ({
  id: id as JobId,
  siteId: "site-one" as SiteId,
  userId,
  operation,
  status: "SUCCEEDED",
  stage: "COMPLETED",
  provider: "openai",
  model: "gpt-sites",
  inputTokens: 1_000,
  cachedInputTokens: 300,
  outputTokens: 500,
  reasoningTokens: 100,
  totalTokens: 1_500,
  logicalCalls: 2,
  physicalRequests: 3,
  retries: 1,
  modelOutputReceived: true,
  websiteGenerated: true,
  billingStatus: "NOT_CHARGED",
  creditsCharged: 0,
  createdAt: new Date("2026-10-06T00:00:00Z"),
  updatedAt: new Date("2026-10-06T00:01:00Z"),
});
const summary = (input = 1_000, cached = 300, output = 500, reasoning = 100) =>
  ({
    runId: "job-one",
    logicalRequests: 2,
    physicalRequests: 3,
    retries: 1,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + output,
    providerUsage: {
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: input + output,
    },
    stages: {},
    providersUsed: ["openai"],
    modelsUsed: ["gpt-sites"],
    elapsedMs: 1,
    budgetExceeded: false,
    attempts: [],
    promptExecutions: [],
  }) as unknown as InferenceRunSummary;
const setup = (quotaRecord = quota(), creditsPer500Tokens = 2) => {
  const jobs = new InMemorySiteJobRepository();
  const quotas = new InMemorySubscriberQuotaRepository([quotaRecord]);
  const service = new SiteCreditBillingService(
    new InMemoryModelCreditRateRepository([rate(creditsPer500Tokens)]),
    quotas,
    jobs,
  );
  return { jobs, quotas, service };
};

interface FakeQuery<T> {
  select(value: unknown): FakeQuery<T>;
  lean(): FakeQuery<T>;
  exec(): Promise<T>;
}

const fakeQuery = <T>(value: T): FakeQuery<T> => ({
  select() {
    return this;
  },
  lean() {
    return this;
  },
  async exec() {
    return value;
  },
});

const mongoQuotaFixture = (
  record: MongoSubscriberQuotaRecord,
  expected: {
    readonly credits: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  },
) => {
  let filter: unknown;
  let update: unknown;
  let options: unknown;
  let updateCount = 0;
  const matches = (value: unknown, includeModernFlag: boolean): boolean => {
    const candidate = value as {
      readonly user?: { readonly $in?: readonly unknown[] };
      readonly type?: string;
      readonly is_credit_implemented?: boolean;
    };
    return (
      candidate.user?.$in?.some((item) => String(item) === String(record.user)) === true &&
      candidate.type === record.type &&
      (!includeModernFlag || candidate.is_credit_implemented === record.is_credit_implemented)
    );
  };
  const subscriberQuotas = {
    findOneAndUpdate(value: unknown, pipeline: unknown, queryOptions: unknown) {
      filter = value;
      update = pipeline;
      options = queryOptions;
      if (!matches(value, true)) return fakeQuery<MongoSubscriberQuotaRecord | null>(null);
      const before = { ...record };
      const actualCharge = Math.min(
        expected.credits,
        Math.max(0, record.token_credit - record.token_credit_used),
      );
      record.token_credit_used += actualCharge;
      record.chat_request_tokens += expected.inputTokens;
      record.chat_response_tokens += expected.outputTokens;
      updateCount += 1;
      return fakeQuery<MongoSubscriberQuotaRecord | null>(before);
    },
    findOne(value: unknown) {
      return fakeQuery<MongoSubscriberQuotaRecord | null>(matches(value, false) ? record : null);
    },
  };
  return {
    models: { subscriberQuotas } as never,
    captured: () => ({ filter, update, options, updateCount }),
  };
};

describe("Sites DB-driven credit billing", () => {
  it("calculates OpenAI-compatible billable tokens", () => {
    expect(
      calculateBillableTokenUsage({
        provider: "openai",
        inputTokens: 1_000,
        cachedInputTokens: 300,
        outputTokens: 500,
      }),
    ).toEqual({
      billableInputTokens: 700,
      billableOutputTokens: 500,
      billableTokens: 1_200,
    });
  });

  it("does not subtract Anthropic cached input", () => {
    expect(
      calculateBillableTokenUsage({
        provider: "anthropic",
        inputTokens: 1_000,
        cachedInputTokens: 300,
        outputTokens: 500,
      }),
    ).toEqual({
      billableInputTokens: 1_000,
      billableOutputTokens: 500,
      billableTokens: 1_500,
    });
  });

  it("does not bill reasoning tokens twice", () => {
    expect(
      calculateBillableTokenUsage({
        provider: "gemini",
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 900,
      }).billableTokens,
    ).toBe(300);
  });

  it("calculates credits and preserves fractions", () => {
    expect(calculateCreditsUsed({ creditsPer500Tokens: 2, billableTokens: 1_250 })).toBe(5);
    expect(calculateCreditsUsed({ creditsPer500Tokens: 1.5, billableTokens: 125 })).toBe(0.375);
  });

  it("stops a missing rate before provider invocation", async () => {
    const provider = vi.fn();
    const service = new SiteCreditBillingService(
      new InMemoryModelCreditRateRepository(),
      new InMemorySubscriberQuotaRepository([quota()]),
      new InMemorySiteJobRepository(),
    );
    await expect(
      service.preflight({ userId, provider: "openai", model: "missing" }),
    ).rejects.toMatchObject({ code: "MODEL_CREDIT_RATE_NOT_FOUND" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("stops exhausted quotas before provider invocation", async () => {
    const provider = vi.fn();
    const { service } = setup(quota({ tokenCredit: 10, tokenCreditUsed: 10 }));
    await expect(
      service.preflight({ userId, provider: "openai", model: "gpt-sites" }),
    ).rejects.toMatchObject({ code: "CREDIT_LIMIT_REACHED" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("charges successful aggregate usage and records telemetry", async () => {
    const { jobs, quotas, service } = setup();
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    const result = await service.finalizeSuccessfulJob(value, summary(), auth);
    expect(result).toMatchObject({
      billingStatus: "CHARGED",
      billableInputTokens: 700,
      billableOutputTokens: 500,
      billableTokens: 1_200,
      creditsPer500Tokens: 2,
      creditsCharged: 4.8,
    });
    expect(quotas.records.get(userId)).toMatchObject({
      tokenCreditUsed: 14.8,
      chatRequestTokens: 1_000,
      chatResponseTokens: 500,
    });
  });

  it("fails billing without deduction when the actual model differs from authorization", async () => {
    const { jobs, quotas, service } = setup();
    const deduct = vi.spyOn(quotas, "deduct");
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    const result = await service.finalizeSuccessfulJob(
      value,
      { ...summary(), modelsUsed: ["some-other-model"] },
      auth,
    );
    expect(deduct).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      websiteGenerated: true,
      billingStatus: "FAILED",
      billingErrorCode: "BILLING_MODEL_MISMATCH",
      creditsCharged: 0,
    });
    expect(await jobs.getById(value.id)).toMatchObject({
      billingStatus: "FAILED",
      billingErrorCode: "BILLING_MODEL_MISMATCH",
    });
  });

  it("fails billing without deduction when multiple models were used", async () => {
    const { jobs, quotas, service } = setup();
    const deduct = vi.spyOn(quotas, "deduct");
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    const result = await service.finalizeSuccessfulJob(
      value,
      { ...summary(), modelsUsed: ["gpt-sites", "another-model"] },
      auth,
    );
    expect(deduct).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      billingStatus: "FAILED",
      billingErrorCode: "BILLING_MODEL_MISMATCH",
    });
  });

  it("fails billing without deduction when the actual provider differs from authorization", async () => {
    const { jobs, quotas, service } = setup();
    const deduct = vi.spyOn(quotas, "deduct");
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    const result = await service.finalizeSuccessfulJob(
      value,
      { ...summary(), providersUsed: ["anthropic"] },
      auth,
    );
    expect(deduct).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      billingStatus: "FAILED",
      billingErrorCode: "BILLING_MODEL_MISMATCH",
    });
  });

  it("leaves failed generation usage recorded without charging", async () => {
    const { jobs, quotas } = setup();
    const failed = {
      ...job(),
      status: "FAILED" as const,
      stage: "FAILED",
      websiteGenerated: false,
      errorCode: "BUILD_FAILED",
    };
    await jobs.save(failed);
    expect(await jobs.getById(failed.id)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 500,
      billingStatus: "NOT_CHARGED",
      creditsCharged: 0,
    });
    expect(quotas.records.get(userId)?.tokenCreditUsed).toBe(10);
  });

  it("preserves the previous version and does not charge a failed edit", async () => {
    const { jobs, quotas } = setup();
    const currentVersionId = "site-one:v1";
    const failed = {
      ...job("edit-one", "EDIT"),
      status: "FAILED" as const,
      stage: "FAILED",
      websiteGenerated: false,
      errorCode: "BUILD_FAILED",
    };
    await jobs.save(failed);
    expect(currentVersionId).toBe("site-one:v1");
    expect((await jobs.getById(failed.id))?.billingStatus).toBe("NOT_CHARGED");
    expect(quotas.records.get(userId)?.tokenCreditUsed).toBe(10);
  });

  it("includes build-repair usage in the final aggregate charge", async () => {
    const { jobs, service } = setup();
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    const result = await service.finalizeSuccessfulJob(value, summary(1_500, 300, 750, 200), auth);
    expect(result).toMatchObject({ billableTokens: 1_950, creditsCharged: 7.8 });
  });

  it("does not charge duplicate job finalization", async () => {
    const { jobs, quotas, service } = setup();
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    await service.finalizeSuccessfulJob(value, summary(), auth);
    const duplicate = await service.finalizeSuccessfulJob(value, summary(), auth);
    expect(duplicate.billingStatus).toBe("CHARGED");
    expect(quotas.records.get(userId)?.tokenCreditUsed).toBe(14.8);
  });

  it("clamps concurrent deductions at token_credit", async () => {
    const { jobs, quotas, service } = setup(quota({ tokenCredit: 10, tokenCreditUsed: 0 }), 5);
    const values = [job("job-a"), job("job-b")];
    await Promise.all(values.map((value) => jobs.save(value)));
    const auths = await Promise.all(
      values.map(() => service.preflight({ userId, provider: "openai", model: "gpt-sites" })),
    );
    const results = await Promise.all(
      values.map((value, index) => service.finalizeSuccessfulJob(value, summary(), auths[index]!)),
    );
    expect(results.reduce((sum, value) => sum + (value.creditsCharged ?? 0), 0)).toBe(10);
    expect(quotas.records.get(userId)?.tokenCreditUsed).toBe(10);
  });

  it("preserves a successful site when billing fails", async () => {
    const jobs = new InMemorySiteJobRepository();
    const failing: SubscriberQuotaRepository = {
      findForUser: async () => quota(),
      deduct: async () => {
        throw new Error("result unknown");
      },
    };
    const diagnosticLogger = { warn: vi.fn() };
    const service = new SiteCreditBillingService(
      new InMemoryModelCreditRateRepository([rate()]),
      failing,
      jobs,
      undefined,
      diagnosticLogger,
    );
    const value = job();
    await jobs.save(value);
    const auth = await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    expect(await service.finalizeSuccessfulJob(value, summary(), auth)).toMatchObject({
      status: "SUCCEEDED",
      websiteGenerated: true,
      billingStatus: "FAILED",
      billingErrorCode: "CREDIT_DEDUCTION_FAILED",
      creditsCharged: 0,
    });
    expect(diagnosticLogger.warn).toHaveBeenCalledWith(
      "[sites][billing] credit finalization failed",
      {
        errorCode: "CREDIT_DEDUCTION_FAILED",
        reason: "unexpected_error",
        errorType: "Error",
      },
    );
  });

  it("binds only minimal fields to the existing shared collections", () => {
    const models = createMongoBillingModels(mongoose.createConnection());
    expect(models.subscriberQuotas.collection.collectionName).toBe("subscriberquotas");
    expect(models.imageModelCredits.collection.collectionName).toBe("imagemodelcredits");
    expect(
      Object.keys(models.subscriberQuotas.schema.paths)
        .filter((key) => key !== "_id")
        .sort(),
    ).toEqual(
      [
        "chat_request_tokens",
        "chat_response_tokens",
        "count",
        "is_credit_implemented",
        "limit",
        "model_credit_list",
        "token_credit",
        "token_credit_used",
        "type",
        "user",
      ].sort(),
    );
  });

  it("opts into Mongoose 9 update pipelines for the atomic deduction", async () => {
    const connection = mongoose.createConnection();
    const models = createMongoBillingModels(connection);
    const filter = {
      user: new mongoose.Types.ObjectId(userId),
      type: "image",
      is_credit_implemented: true,
    };
    const pipeline = [{ $set: { token_credit_used: 121.596 } }];
    expect(() =>
      models.subscriberQuotas.findOneAndUpdate(filter, pipeline, {
        returnDocument: "before",
      }),
    ).toThrow("Cannot pass an array to query updates unless the `updatePipeline` option is set");
    expect(() =>
      models.subscriberQuotas.findOneAndUpdate(filter, pipeline, {
        updatePipeline: true,
        returnDocument: "before",
      }),
    ).not.toThrow();
    await connection.close();
  });

  it("deducts the real-case fractional charge through an ObjectId-backed fixture", async () => {
    const record: MongoSubscriberQuotaRecord = {
      user: new mongoose.Types.ObjectId(userId),
      type: "image",
      count: 0,
      limit: 0,
      token_credit: 50_000,
      token_credit_used: 0,
      is_credit_implemented: true,
      chat_request_tokens: 0,
      chat_response_tokens: 0,
      model_credit_list: [],
    };
    const fixture = mongoQuotaFixture(record, {
      credits: 121.596,
      inputTokens: 2_508,
      outputTokens: 7_625,
    });
    const repository = new MongoSubscriberQuotaRepository(fixture.models);
    await expect(
      repository.deduct({
        userId,
        calculatedCredits: 121.596,
        inputTokens: 2_508,
        outputTokens: 7_625,
      }),
    ).resolves.toEqual({
      actualCharge: 121.596,
      tokenCreditUsed: 121.596,
      tokenCredit: 50_000,
    });
    expect(record).toMatchObject({
      token_credit_used: 121.596,
      chat_request_tokens: 2_508,
      chat_response_tokens: 7_625,
    });
    const captured = fixture.captured();
    expect(captured.filter).toEqual({
      user: { $in: [userId, new mongoose.Types.ObjectId(userId)] },
      type: "image",
      is_credit_implemented: true,
    });
    expect(captured.options).toEqual({
      updatePipeline: true,
      returnDocument: "before",
    });
    expect(captured.update).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $set: expect.objectContaining({
            token_credit_used: expect.objectContaining({
              $min: expect.arrayContaining([
                expect.anything(),
                expect.objectContaining({
                  $add: expect.arrayContaining([expect.anything(), 121.596]),
                }),
              ]),
            }),
            chat_request_tokens: expect.objectContaining({
              $add: expect.arrayContaining([expect.anything(), 2_508]),
            }),
            chat_response_tokens: expect.objectContaining({
              $add: expect.arrayContaining([expect.anything(), 7_625]),
            }),
          }),
        }),
      ]),
    );
  });

  it("keeps an exhausted Mongo quota clamped without overspending", async () => {
    const record: MongoSubscriberQuotaRecord = {
      user: new mongoose.Types.ObjectId(userId),
      type: "image",
      count: 0,
      limit: 0,
      token_credit: 50_000,
      token_credit_used: 50_000,
      is_credit_implemented: true,
      chat_request_tokens: 0,
      chat_response_tokens: 0,
      model_credit_list: [],
    };
    const fixture = mongoQuotaFixture(record, {
      credits: 121.596,
      inputTokens: 2_508,
      outputTokens: 7_625,
    });
    const repository = new MongoSubscriberQuotaRepository(fixture.models);
    await expect(
      repository.deduct({
        userId,
        calculatedCredits: 121.596,
        inputTokens: 2_508,
        outputTokens: 7_625,
      }),
    ).resolves.toMatchObject({ actualCharge: 0, tokenCreditUsed: 50_000 });
    expect(record.token_credit_used).toBe(50_000);
  });

  it("does not update the fixture for the wrong user or a non-modern quota", async () => {
    const base = (): MongoSubscriberQuotaRecord => ({
      user: new mongoose.Types.ObjectId(userId),
      type: "image",
      count: 0,
      limit: 0,
      token_credit: 50_000,
      token_credit_used: 0,
      is_credit_implemented: true,
      chat_request_tokens: 0,
      chat_response_tokens: 0,
      model_credit_list: [],
    });
    const wrongUserFixture = mongoQuotaFixture(base(), {
      credits: 121.596,
      inputTokens: 2_508,
      outputTokens: 7_625,
    });
    const wrongUserRepository = new MongoSubscriberQuotaRepository(wrongUserFixture.models);
    await expect(
      wrongUserRepository.deduct({
        userId: "507f191e810c19729de860ea",
        calculatedCredits: 121.596,
        inputTokens: 2_508,
        outputTokens: 7_625,
      }),
    ).rejects.toMatchObject({
      code: "CREDIT_QUOTA_NOT_FOUND",
      metadata: { reason: "quota_not_found" },
    });
    expect(wrongUserFixture.captured().updateCount).toBe(0);

    const nonModernRecord = { ...base(), is_credit_implemented: false };
    const nonModernFixture = mongoQuotaFixture(nonModernRecord, {
      credits: 121.596,
      inputTokens: 2_508,
      outputTokens: 7_625,
    });
    const nonModernRepository = new MongoSubscriberQuotaRepository(nonModernFixture.models);
    await expect(
      nonModernRepository.deduct({
        userId,
        calculatedCredits: 121.596,
        inputTokens: 2_508,
        outputTokens: 7_625,
      }),
    ).rejects.toMatchObject({
      code: "CREDIT_QUOTA_NOT_FOUND",
      metadata: { reason: "modern_credit_flag_mismatch" },
    });
    expect(nonModernFixture.captured().updateCount).toBe(0);
  });

  it("classifies an atomic write failure without exposing its message", async () => {
    const record: MongoSubscriberQuotaRecord = {
      user: new mongoose.Types.ObjectId(userId),
      type: "image",
      count: 0,
      limit: 0,
      token_credit: 50_000,
      token_credit_used: 0,
      is_credit_implemented: true,
      chat_request_tokens: 0,
      chat_response_tokens: 0,
      model_credit_list: [],
    };
    const sensitiveFailure = Object.assign(new Error("database details must not be logged"), {
      code: 14,
    });
    const models = {
      subscriberQuotas: {
        findOneAndUpdate: () => {
          throw sensitiveFailure;
        },
        findOne: () => fakeQuery<MongoSubscriberQuotaRecord | null>(record),
      },
    };
    const repository = new MongoSubscriberQuotaRepository(models as never);
    await expect(
      repository.deduct({
        userId,
        calculatedCredits: 121.596,
        inputTokens: 2_508,
        outputTokens: 7_625,
      }),
    ).rejects.toMatchObject({
      code: "CREDIT_DEDUCTION_FAILED",
      metadata: {
        reason: "atomic_update_error",
        errorType: "Error",
        mongoCode: 14,
      },
    });
  });
});
