import type { UserCreditQuotaPayload } from "../billing/getchatly-quota-notification.js";
import type { SiteJob, SiteJobBillingStatus } from "../sites/domain/entities.js";
import type { JobId } from "../shared/types.js";

export interface TerminalJobBillingFields {
  readonly billingStatus: SiteJobBillingStatus;
  readonly creditsCharged?: number;
  readonly subscriberQuota?: UserCreditQuotaPayload;
}

interface SiteJobLookup {
  getById(jobId: JobId): Promise<SiteJob | undefined>;
}

/**
 * Build the additive terminal HTTP fields from durable billing state. The quota
 * reader is invoked only after a CHARGED job has been loaded and owner-checked.
 */
export async function resolveTerminalJobBillingFields(input: {
  readonly jobId: JobId;
  readonly ownerId: string;
  readonly jobs: SiteJobLookup;
  readonly readCanonicalQuota: (userId: string) => Promise<UserCreditQuotaPayload | undefined>;
}): Promise<TerminalJobBillingFields | undefined> {
  const job = await input.jobs.getById(input.jobId);
  if (!job || String(job.userId) !== input.ownerId) return undefined;

  const result: TerminalJobBillingFields = {
    billingStatus: job.billingStatus,
    ...(job.creditsCharged !== undefined ? { creditsCharged: job.creditsCharged } : {}),
  };
  if (job.billingStatus !== "CHARGED") return result;

  try {
    const subscriberQuota = await input.readCanonicalQuota(input.ownerId);
    return subscriberQuota ? { ...result, subscriberQuota } : result;
  } catch {
    // Credit synchronization is a deterministic fallback, not a reason to
    // turn an already committed and charged website into a failed dev job.
    return result;
  }
}
