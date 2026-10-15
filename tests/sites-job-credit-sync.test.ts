import { describe, expect, it, vi } from "vitest";
import {
  readUserCreditQuotaPayload,
  type GetChatlyQuotaUserRepository,
  type UserCreditQuotaPayload,
} from "../src/billing/getchatly-quota-notification.js";
import type { SubscriberQuota, SubscriberQuotaRepository } from "../src/billing/credit-billing.js";
import { DevJobManager } from "../src/dev-server/dev-job-manager.js";
import { resolveTerminalJobBillingFields } from "../src/dev-server/job-billing-result.js";
import { InMemoryProgressBus } from "../src/sites/application/progress.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { JobId, SiteId, UserId } from "../src/shared/types.js";

const ownerId = "6ac38bf52aa6520eeb657ea4";
const jobId = "workflow-job" as JobId;

const quotaRecord = (tokenCreditUsed: number): SubscriberQuota => ({
  id: "quota-1",
  user: ownerId,
  userId: ownerId,
  type: "image",
  count: 4,
  limit: 50_000,
  tokenCredit: 50_000,
  tokenCreditUsed,
  isCreditImplemented: true,
  chatRequestTokens: 29_563,
  chatResponseTokens: 39_101,
  modelCreditList: [{ model: "safe-model" }],
});

const durableJob = (billingStatus: SiteJob["billingStatus"]): SiteJob => ({
  id: jobId,
  siteId: "site-1" as SiteId,
  userId: ownerId as UserId,
  operation: "GENERATE",
  status: "SUCCEEDED",
  stage: "COMPLETED",
  provider: "openai",
  creditsCharged: billingStatus === "CHARGED" ? 88.032 : 0,
  billingStatus,
  logicalCalls: 1,
  physicalRequests: 1,
  retries: 0,
  modelOutputReceived: true,
  websiteGenerated: true,
  createdAt: new Date("2026-10-14T00:00:00.000Z"),
  updatedAt: new Date("2026-10-14T00:01:00.000Z"),
});

describe("terminal Sites job credit contract", () => {
  it("reads the exact post-deduction canonical quota once for a durable CHARGED job", async () => {
    let storedQuota = quotaRecord(735.936);
    const deduct = vi.fn(async () => {
      storedQuota = quotaRecord(823.968);
    });
    const quotas: SubscriberQuotaRepository = {
      findForUser: vi.fn(async () => storedQuota),
      deduct: vi.fn(async () => ({
        actualCharge: 88.032,
        tokenCreditUsed: 823.968,
        tokenCredit: 50_000,
      })),
    };
    const users: GetChatlyQuotaUserRepository = {
      findForQuotaNotification: vi.fn(async () => ({
        subscription: { isActive: true },
        chatCount: 7,
      })),
    };
    await deduct();
    const readCanonicalQuota = vi.fn((userId: string) =>
      readUserCreditQuotaPayload(quotas, users, userId),
    );

    const result = await resolveTerminalJobBillingFields({
      jobId,
      ownerId,
      jobs: { getById: vi.fn(async () => durableJob("CHARGED")) },
      readCanonicalQuota,
    });

    expect(deduct).toHaveBeenCalledOnce();
    expect(readCanonicalQuota).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      billingStatus: "CHARGED",
      creditsCharged: 88.032,
      subscriberQuota: {
        type: "image",
        token_credit: 50_000,
        token_credit_used: 823.968,
        chat_request_tokens: 29_563,
        chat_response_tokens: 39_101,
        chat_count: 7,
      },
    });
  });

  it("does not read or claim a quota for FAILED billing or a foreign owner", async () => {
    const readCanonicalQuota = vi.fn<() => Promise<UserCreditQuotaPayload | undefined>>();
    const jobs = { getById: vi.fn(async () => durableJob("FAILED")) };
    await expect(
      resolveTerminalJobBillingFields({ jobId, ownerId, jobs, readCanonicalQuota }),
    ).resolves.toEqual({ billingStatus: "FAILED", creditsCharged: 0 });
    await expect(
      resolveTerminalJobBillingFields({
        jobId,
        ownerId: "another-user",
        jobs,
        readCanonicalQuota,
      }),
    ).resolves.toBeUndefined();
    expect(readCanonicalQuota).not.toHaveBeenCalled();
  });

  it("preserves website success when the post-charge quota read is unavailable", async () => {
    await expect(
      resolveTerminalJobBillingFields({
        jobId,
        ownerId,
        jobs: { getById: vi.fn(async () => durableJob("CHARGED")) },
        readCanonicalQuota: vi.fn(async () => {
          throw new Error("quota read unavailable");
        }),
      }),
    ).resolves.toEqual({ billingStatus: "CHARGED", creditsCharged: 88.032 });
  });

  it.each(["GENERATE", "EDIT"] as const)(
    "copies the additive canonical fields into a successful %s polling record",
    async (operation) => {
      const manager = new DevJobManager(new InMemoryProgressBus());
      const subscriberQuota = await readUserCreditQuotaPayload(
        {
          findForUser: async () => quotaRecord(823.968),
          deduct: vi.fn(),
        },
        {
          findForQuotaNotification: async () => ({
            subscription: { isActive: true },
            chatCount: 7,
          }),
        },
        ownerId,
      );
      const job = manager.start(
        operation,
        async () => ({
          projectId: "site-1",
          versionId: "version-1",
          billingStatus: "CHARGED",
          creditsCharged: 88.032,
          subscriberQuota: subscriberQuota!,
        }),
        ownerId,
      );
      await vi.waitFor(() => expect(job.status).toBe("SUCCEEDED"));
      expect(job).toMatchObject({
        status: "SUCCEEDED",
        currentStage: "COMPLETED",
        billingStatus: "CHARGED",
        creditsCharged: 88.032,
        subscriberQuota: { token_credit_used: 823.968, token_credit: 50_000 },
      });
      expect(manager.getOwned(job.id, ownerId)).toBe(job);
      expect(manager.getOwned(job.id, "another-user")).toBeUndefined();
      expect(JSON.stringify(job)).not.toMatch(/JWT|REDIS_URL|MONGO_URI|credentials/i);
    },
  );

  it("keeps the legacy job response shape valid when billing fields are absent", async () => {
    const manager = new DevJobManager(new InMemoryProgressBus());
    const job = manager.start("GENERATE", async () => ({
      projectId: "site-1",
      versionId: "version-1",
    }));
    await vi.waitFor(() => expect(job.status).toBe("SUCCEEDED"));
    expect(job).toMatchObject({
      operation: "GENERATE",
      projectId: "site-1",
      versionId: "version-1",
      status: "SUCCEEDED",
      currentStage: "COMPLETED",
    });
    expect(job).not.toHaveProperty("billingStatus");
    expect(job).not.toHaveProperty("subscriberQuota");
  });
});
