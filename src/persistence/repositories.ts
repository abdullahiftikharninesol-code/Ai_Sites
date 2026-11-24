import type {
  SiteDeployment,
  SiteJob,
  SiteProject,
  SiteVersion,
} from "../sites/domain/entities.js";
import type { DeploymentId, JobId, Page, SiteId, VersionId } from "../shared/types.js";
/** The durable record of what a job will be charged, written before any debit. */
export type SiteJobChargeIntent = Pick<SiteJob,
  "billingAttemptId" | "billingClaimedAt" | "model" | "billableInputTokens" | "billableOutputTokens" | "billableTokens" |
  "creditsPer500Tokens" | "creditsCalculated">;
export interface SiteProjectRepository {
  getById(id: SiteId): Promise<SiteProject | undefined>;
  getBySlug(slug: string): Promise<SiteProject | undefined>;
  save(project: SiteProject): Promise<void>;
  listByOwner(ownerId: string, cursor?: string): Promise<Page<SiteProject>>;
}
export interface SitePublicationRepository {
  setPublication(
    siteId: SiteId,
    publication?: {
      readonly versionId: VersionId;
      readonly deploymentId: DeploymentId;
    },
  ): Promise<void>;
}
export interface SiteVersionRepository {
  getById(id: VersionId): Promise<SiteVersion | undefined>;
  save(version: SiteVersion): Promise<void>;
  listBySite(siteId: SiteId, cursor?: string): Promise<Page<SiteVersion>>;
}
export interface SiteJobRepository {
  getById(id: JobId): Promise<SiteJob | undefined>;
  save(job: SiteJob): Promise<void>;
  /**
   * Atomically moves a NOT_CHARGED job to PENDING, recording the charge intent
   * when supplied. A PENDING job is recoverable: it is settled exactly once.
   */
  claimBilling(id: JobId, intent?: SiteJobChargeIntent): Promise<boolean>;
  /** PENDING jobs last touched before the cutoff, for billing recovery. */
  listPendingBilling?(updatedBefore: Date, limit: number): Promise<readonly SiteJob[]>;
  /** The user's delivered-but-unsettled charges, counted against new reservations. */
  listPendingBillingForUser?(userId: string): Promise<readonly SiteJob[]>;
  /**
   * Atomically takes a stale PENDING job for one recovery attempt by moving its
   * updatedAt to `now`; false when another worker already took it (or it settled).
   */
  leasePendingBilling?(id: JobId, staleBefore: Date, now: Date): Promise<boolean>;
  listBySite(siteId: SiteId, cursor?: string): Promise<Page<SiteJob>>;
}
export interface SiteDeploymentRepository {
  getById(id: DeploymentId): Promise<SiteDeployment | undefined>;
  save(deployment: SiteDeployment): Promise<void>;
  listBySite(siteId: SiteId, cursor?: string): Promise<Page<SiteDeployment>>;
}
