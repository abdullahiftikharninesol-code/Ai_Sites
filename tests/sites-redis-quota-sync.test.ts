import { describe, expect, it, vi } from "vitest";
import type { InferenceRunSummary } from "../src/agents/budget/inference-run-context.js";
import {
  InMemoryModelCreditRateRepository,
  InMemorySubscriberQuotaRepository,
  SiteCreditBillingService,
  type BillingAuthorization,
  type SubscriberQuota,
  type SubscriberQuotaRepository,
} from "../src/billing/credit-billing.js";
import {
  GETCHATLY_QUOTA_EVENT,
  GETCHATLY_SOCKET_NAMESPACE,
  GetChatlyQuotaNotificationService,
  buildUserCreditQuotaPayload,
  getGetChatlyInitialDataCacheKeys,
  resolveGetChatlyCacheEnvironment,
  type GetChatlyQuotaUserRepository,
  type QuotaChangeNotifier,
} from "../src/billing/getchatly-quota-notification.js";
import { loadConfig } from "../src/app/config/environment.js";
import { InMemorySiteJobRepository } from "../src/persistence/in-memory-repositories.js";
import type { SiteJobRepository } from "../src/persistence/repositories.js";
import { SITES_QUOTA_USER_PROJECTION } from "../src/auth/identity-repository.js";
import { SITES_SUBSCRIBER_QUOTA_PROJECTION } from "../src/persistence/mongodb/mongo-billing-repositories.js";
import {
  SharedRedisConnection,
  type GetChatlyRedisGateway,
  type RedisCommandClient,
  type RedisWarningLogger,
} from "../src/redis/shared-redis.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { JobId, SiteId, UserId } from "../src/shared/types.js";

const userId = "507f1f77bcf86cd799439011" as UserId;
const quota = (overrides: Partial<SubscriberQuota> = {}): SubscriberQuota => ({
  id: "quota-one",
  user: userId,
  userId,
  type: "image",
  count: 3,
  limit: 25,
  chatRequestTokens: 1_000,
  chatResponseTokens: 500,
  isCreditImplemented: true,
  tokenCredit: 100,
  tokenCreditUsed: 10,
  modelCreditList: [{ model: "gpt-sites", credits: 20 }],
  ...overrides,
});
const job = (id = "phase-b-job", operation: SiteJob["operation"] = "GENERATE"): SiteJob => ({
  id: id as JobId,
  siteId: "phase-b-site" as SiteId,
  userId,
  operation,
  status: "SUCCEEDED",
  stage: "COMPLETED",
  provider: "openai",
  model: "gpt-sites",
  logicalCalls: 1,
  physicalRequests: 1,
  retries: 0,
  modelOutputReceived: true,
  websiteGenerated: true,
  billingStatus: "NOT_CHARGED",
  creditsCharged: 0,
  createdAt: new Date("2026-10-07T00:00:00Z"),
  updatedAt: new Date("2026-10-07T00:01:00Z"),
});
const summary = (modelsUsed: readonly string[] = ["gpt-sites"]): InferenceRunSummary =>
  ({
    runId: "phase-b-job",
    logicalRequests: 1,
    physicalRequests: 1,
    retries: 0,
    inputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
    providerUsage: {
      inputTokens: 1_000,
      cachedInputTokens: 300,
      outputTokens: 500,
      totalTokens: 1_500,
    },
    stages: {},
    providersUsed: ["openai"],
    modelsUsed,
    elapsedMs: 1,
    budgetExceeded: false,
    attempts: [],
    promptExecutions: [],
  }) as unknown as InferenceRunSummary;
const authorization: BillingAuthorization = {
  userId,
  provider: "openai",
  modelRate: {
    model: "gpt-sites",
    platform: "openai",
    type: "ai_chat",
    creditsPer500Tokens: 2,
  },
};

class FakeRedisGateway implements GetChatlyRedisGateway {
  readonly deleted: string[][] = [];
  readonly emitted: Array<{
    namespace: string;
    room: string;
    event: string;
    payload: Readonly<Record<string, unknown>>;
  }> = [];
  failDelete = false;
  failEmit = false;
  readonly order: string[] | undefined;

  constructor(order?: string[]) {
    this.order = order;
  }

  async deleteExactKeys(keys: readonly string[]) {
    this.order?.push("cache");
    if (this.failDelete) throw new Error("cache unavailable");
    this.deleted.push([...keys]);
    return { attempted: true, deletedKeys: keys.length };
  }

  async emit(
    namespace: string,
    room: string,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ) {
    this.order?.push("event");
    if (this.failEmit) throw new Error("publish unavailable");
    this.emitted.push({ namespace, room, event, payload });
    return { attempted: true };
  }
}

const logger = (): RedisWarningLogger & { messages: string[] } => ({
  messages: [],
  warn(message: string) {
    this.messages.push(message);
  },
});

const userRepository = (
  isActive = true,
  chatCount = 9,
  order?: string[],
): GetChatlyQuotaUserRepository => ({
  findForQuotaNotification: async () => {
    order?.push("user-read");
    return { subscription: { isActive }, chatCount };
  },
});

const rateRepository = () =>
  new InMemoryModelCreditRateRepository([
    { model: "gpt-sites", platform: "openai", type: "ai_chat", creditsPer500Tokens: 2 },
  ]);

describe("Phase B GetChatly cache key contract", () => {
  it("deletes the production-scoped and legacy keys only", () => {
    expect(getGetChatlyInitialDataCacheKeys("abc", "production")).toEqual([
      "cache:production:initial_data:abc",
      "cache:initial_data:abc",
    ]);
  });

  it("uses NODE_ENV and then development when REDIS_CACHE_ENV is absent", () => {
    expect(resolveGetChatlyCacheEnvironment({ NODE_ENV: "test" })).toBe("test");
    expect(resolveGetChatlyCacheEnvironment({})).toBe("development");
    expect(loadConfig({ NODE_ENV: "test" }).redisCacheEnvironment).toBe("test");
    expect(loadConfig({ NODE_ENV: "test", REDIS_CACHE_ENV: "production" })).toMatchObject({
      redisCacheEnvironment: "production",
    });
  });
});

describe("Phase B userCreditQuota payload", () => {
  it("keeps the Mongo reads narrowed to the exact payload fields", () => {
    expect(SITES_SUBSCRIBER_QUOTA_PROJECTION).toEqual({
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
    expect(SITES_QUOTA_USER_PROJECTION).toEqual({
      _id: 0,
      "subscription.is_active": 1,
      chat_count: 1,
    });
  });

  it("uses the full fresh quota and user fields", () => {
    expect(
      buildUserCreditQuotaPayload(quota({ tokenCredit: 100, tokenCreditUsed: 20 }), {
        subscription: { isActive: true },
        chatCount: 17,
      }),
    ).toEqual({
      _id: "quota-one",
      user: userId,
      type: "image",
      count: 3,
      limit: 25,
      chat_request_tokens: 1_000,
      chat_response_tokens: 500,
      is_credit_implemented: true,
      token_credit: 100,
      token_credit_used: 20,
      model_credit_list: [{ model: "gpt-sites", credits: 20 }],
      is_premium: true,
      chat_count: 17,
    });
  });

  it("derives is_premium only from subscription.is_active", () => {
    expect(
      buildUserCreditQuotaPayload(quota(), {
        subscription: { isActive: false },
        chatCount: 0,
      }).is_premium,
    ).toBe(false);
    expect(
      buildUserCreditQuotaPayload(quota(), {
        subscription: { isActive: true },
        chatCount: 0,
      }).is_premium,
    ).toBe(true);
  });
});

describe("Phase B post-billing notification", () => {
  it("runs after CHARGED, reads the post-deduction quota, invalidates both keys and emits", async () => {
    const order: string[] = [];
    const storedQuotas = new InMemorySubscriberQuotaRepository([quota()]);
    const quotas: SubscriberQuotaRepository = {
      findForUser: async (id) => {
        order.push("quota-read");
        return storedQuotas.findForUser(id);
      },
      deduct: (input) => storedQuotas.deduct(input),
    };
    const redis = new FakeRedisGateway(order);
    const warnings = logger();
    const notification = new GetChatlyQuotaNotificationService(
      quotas,
      userRepository(true, 12, order),
      redis,
      "production",
      warnings,
    );
    const storedJobs = new InMemorySiteJobRepository();
    const jobs: SiteJobRepository = {
      getById: (id) => storedJobs.getById(id),
      claimBilling: (id) => storedJobs.claimBilling(id),
      listBySite: (id) => storedJobs.listBySite(id),
      save: async (value) => {
        await storedJobs.save(value);
        if (value.billingStatus === "CHARGED") order.push("charged");
      },
    };
    const service = new SiteCreditBillingService(rateRepository(), quotas, jobs, notification);
    const value = job();
    await jobs.save(value);
    await service.preflight({ userId, provider: "openai", model: "gpt-sites" });
    order.length = 0;

    const result = await service.finalizeSuccessfulJob(value, summary(), authorization);

    expect(result.billingStatus).toBe("CHARGED");
    expect(order).toEqual(["charged", "quota-read", "user-read", "cache", "event"]);
    expect(redis.deleted).toEqual([
      [`cache:production:initial_data:${userId}`, `cache:initial_data:${userId}`],
    ]);
    expect(redis.emitted).toHaveLength(1);
    expect(redis.emitted[0]).toMatchObject({
      namespace: GETCHATLY_SOCKET_NAMESPACE,
      room: String(userId),
      event: GETCHATLY_QUOTA_EVENT,
      payload: {
        token_credit: 100,
        token_credit_used: 14.8,
        chat_request_tokens: 2_000,
        chat_response_tokens: 1_000,
        chat_count: 12,
      },
    });
    expect(warnings.messages).toEqual([]);
  });

  it("keeps CHARGED and still emits when cache invalidation fails", async () => {
    const quotas = new InMemorySubscriberQuotaRepository([quota()]);
    const redis = new FakeRedisGateway();
    redis.failDelete = true;
    const warnings = logger();
    const notification = new GetChatlyQuotaNotificationService(
      quotas,
      userRepository(),
      redis,
      "test",
      warnings,
    );
    const jobs = new InMemorySiteJobRepository();
    const service = new SiteCreditBillingService(rateRepository(), quotas, jobs, notification);
    const value = job("cache-failure");
    await jobs.save(value);

    await expect(
      service.finalizeSuccessfulJob(value, summary(), authorization),
    ).resolves.toMatchObject({
      billingStatus: "CHARGED",
    });
    expect(redis.emitted).toHaveLength(1);
    expect(warnings.messages).toContain(
      "[sites][billing] GetChatly initial-data cache invalidation failed",
    );
  });

  it("keeps CHARGED when event emission fails", async () => {
    const quotas = new InMemorySubscriberQuotaRepository([quota()]);
    const redis = new FakeRedisGateway();
    redis.failEmit = true;
    const warnings = logger();
    const notification = new GetChatlyQuotaNotificationService(
      quotas,
      userRepository(),
      redis,
      "test",
      warnings,
    );
    const jobs = new InMemorySiteJobRepository();
    const service = new SiteCreditBillingService(rateRepository(), quotas, jobs, notification);
    const value = job("event-failure");
    await jobs.save(value);

    await expect(
      service.finalizeSuccessfulJob(value, summary(), authorization),
    ).resolves.toMatchObject({
      billingStatus: "CHARGED",
    });
    expect(await jobs.getById(value.id)).toMatchObject({ billingStatus: "CHARGED" });
    expect(warnings.messages).toContain(
      "[sites][billing] GetChatly userCreditQuota emission failed",
    );
  });

  it("invalidates cache, skips the event and keeps CHARGED when the payload read fails", async () => {
    const stored = new InMemorySubscriberQuotaRepository([quota()]);
    let reads = 0;
    const quotas: SubscriberQuotaRepository = {
      findForUser: async (id) => {
        reads += 1;
        if (reads > 1) throw new Error("read failed");
        return stored.findForUser(id);
      },
      deduct: (input) => stored.deduct(input),
    };
    const redis = new FakeRedisGateway();
    const warnings = logger();
    const notification = new GetChatlyQuotaNotificationService(
      quotas,
      userRepository(),
      redis,
      "test",
      warnings,
    );
    const jobs = new InMemorySiteJobRepository();
    const service = new SiteCreditBillingService(rateRepository(), quotas, jobs, notification);
    const value = job("read-failure");
    await jobs.save(value);
    await service.preflight({ userId, provider: "openai", model: "gpt-sites" });

    await expect(
      service.finalizeSuccessfulJob(value, summary(), authorization),
    ).resolves.toMatchObject({
      billingStatus: "CHARGED",
    });
    expect(redis.deleted).toHaveLength(1);
    expect(redis.emitted).toHaveLength(0);
    expect(warnings.messages[0]).toContain("unable to load fresh GetChatly quota payload");
  });

  it("does not notify failed generation or failed edit jobs", async () => {
    const notifyGetChatlyQuotaChanged = vi.fn();
    const notifier = { notifyGetChatlyQuotaChanged } as unknown as QuotaChangeNotifier;
    const jobs = new InMemorySiteJobRepository();
    const service = new SiteCreditBillingService(
      rateRepository(),
      new InMemorySubscriberQuotaRepository([quota()]),
      jobs,
      notifier,
    );
    for (const value of [job("failed-generation"), job("failed-edit", "EDIT")]) {
      const failed = { ...value, status: "FAILED" as const, websiteGenerated: false };
      await jobs.save(failed);
      await expect(service.finalizeSuccessfulJob(failed, summary(), authorization)).resolves.toBe(
        failed,
      );
    }
    expect(notifyGetChatlyQuotaChanged).not.toHaveBeenCalled();
  });

  it("does not notify model mismatch, deduction failure, or duplicate finalization", async () => {
    const notifyGetChatlyQuotaChanged = vi.fn(async () => ({
      payloadLoaded: true,
      cache: { attempted: true, deletedKeys: 2 },
      event: { attempted: true },
    }));
    const notifier = { notifyGetChatlyQuotaChanged };
    const jobs = new InMemorySiteJobRepository();
    const quotas = new InMemorySubscriberQuotaRepository([quota()]);
    const service = new SiteCreditBillingService(rateRepository(), quotas, jobs, notifier);
    const mismatch = job("mismatch");
    await jobs.save(mismatch);
    await service.finalizeSuccessfulJob(mismatch, summary(["other-model"]), authorization);
    expect(notifyGetChatlyQuotaChanged).not.toHaveBeenCalled();

    const deductionJobs = new InMemorySiteJobRepository();
    const failingQuotas: SubscriberQuotaRepository = {
      findForUser: async () => quota(),
      deduct: async () => {
        throw new Error("deduction failed");
      },
    };
    const deductionService = new SiteCreditBillingService(
      rateRepository(),
      failingQuotas,
      deductionJobs,
      notifier,
    );
    const deduction = job("deduction");
    await deductionJobs.save(deduction);
    await deductionService.finalizeSuccessfulJob(deduction, summary(), authorization);
    expect(notifyGetChatlyQuotaChanged).not.toHaveBeenCalled();

    const successful = job("duplicate");
    await jobs.save(successful);
    await service.finalizeSuccessfulJob(successful, summary(), authorization);
    await service.finalizeSuccessfulJob(successful, summary(), authorization);
    expect(notifyGetChatlyQuotaChanged).toHaveBeenCalledTimes(1);
  });
});

describe("Phase B shared Redis gateway", () => {
  it("uses the official socket.io prefix, namespace and room channel", async () => {
    let open = false;
    const publish = vi.fn(async (_channel: string, _message: string | Buffer) => 1);
    const client: RedisCommandClient = {
      get isOpen() {
        return open;
      },
      connect: async () => {
        open = true;
      },
      del: async () => 0,
      publish,
      close: async () => {
        open = false;
      },
      on: () => undefined,
    };
    const redis = new SharedRedisConnection(
      { url: "redis://shared.example:6379" },
      logger(),
      () => client,
    );
    await redis.emit("/", "abc", "userCreditQuota", { token_credit_used: 20 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe("socket.io#/#abc#");
    expect(Buffer.isBuffer(publish.mock.calls[0]?.[1])).toBe(true);
    await redis.close();
  });

  it("keeps billing successful when Redis is unconfigured and warns once", async () => {
    const warnings = logger();
    const clientFactory = vi.fn(() => {
      throw new Error("must not create a client");
    });
    const redis = new SharedRedisConnection({}, warnings, clientFactory);
    const quotas = new InMemorySubscriberQuotaRepository([quota()]);
    const notification = new GetChatlyQuotaNotificationService(
      quotas,
      userRepository(),
      redis,
      "test",
      warnings,
    );
    const jobs = new InMemorySiteJobRepository();
    const service = new SiteCreditBillingService(rateRepository(), quotas, jobs, notification);
    const value = job("no-redis");
    await jobs.save(value);

    await expect(
      service.finalizeSuccessfulJob(value, summary(), authorization),
    ).resolves.toMatchObject({
      billingStatus: "CHARGED",
    });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(warnings.messages.filter((message) => message.includes("REDIS_URL"))).toHaveLength(1);
    await redis.close();
  });
});
