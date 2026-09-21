import type { DeploymentId, JobId, SiteId, UserId, VersionId } from "../../shared/types.js";
import type { SiteSpec } from "./site-spec.js";

export const SITE_PROJECT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type SiteProjectStatus = (typeof SITE_PROJECT_STATUSES)[number];

export interface SiteProject {
  readonly id: SiteId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly slug: string;
  readonly status: SiteProjectStatus;
  readonly latestVersionId?: VersionId;
  readonly publishedVersionId?: VersionId;
  readonly publishedDeploymentId?: DeploymentId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const BUILD_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

export interface SiteVersion {
  readonly id: VersionId;
  readonly siteId: SiteId;
  readonly versionNumber: number;
  readonly parentVersionId?: VersionId;
  readonly sourceArtifactRef: string;
  readonly sourceManifestRef?: string;
  readonly assetManifestArtifactRef?: string;
  readonly buildArtifactRef?: string;
  readonly buildStatus: BuildStatus;
  readonly siteSpec?: SiteSpec;
  readonly technicalProfileId?: string;
  readonly templateId?: string;
  readonly templateVersion?: number;
  readonly changeSummary?: readonly string[];
  readonly visualQAStatus?: "PASSED" | "FAILED" | "MANUAL_REVIEW";
  readonly visualQAScore?: number;
  readonly visualQAArtifactRef?: string;
  readonly finalScreenshotRefs?: readonly string[];
  readonly browserQAStatus?: "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED";
  readonly browserQAArtifactRef?: string;
  readonly browserQAScreenshotRefs?: readonly string[];
  readonly visualReviewStatus?: "PASS" | "NEEDS_REPAIR" | "FAIL" | "INCONCLUSIVE";
  readonly visualReviewId?: string;
  readonly visualReviewArtifactRef?: string;
  readonly visualReviewScreenshotRefs?: readonly string[];
  readonly visualRepairAttemptId?: string;
  readonly visualRepairAttemptStatus?: string;
  readonly visualRepairAttemptArtifactRef?: string;
  readonly usageSummary?: Readonly<Record<string, unknown>>;
  readonly runtimeSchemaVersion?: number;
  readonly createdAt: Date;
}

export const SITE_JOB_TYPES = [
  "GENERATE_SITE",
  "EDIT_SITE",
  "BUILD_SITE",
  "VISUAL_QA",
  "SAVE_VERSION",
  "DEPLOY_SITE",
] as const;
export type SiteJobType = (typeof SITE_JOB_TYPES)[number];
export type SiteJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface SiteJob {
  readonly id: JobId;
  readonly siteId: SiteId;
  readonly userId: UserId;
  readonly type: SiteJobType;
  readonly status: SiteJobStatus;
  readonly progress: number;
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
}

export interface SiteDeployment {
  readonly id: DeploymentId;
  readonly siteId: SiteId;
  readonly versionId: VersionId;
  readonly hostname: string;
  readonly status: "PENDING" | "BUILDING" | "READY" | "FAILED";
  readonly hostingProvider?: string;
  readonly deploymentArtifactRef?: string;
  readonly deploymentManifestRef?: string;
  readonly completedAt?: Date;
  readonly publishedAt?: Date;
  readonly failure?: string;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly createdAt: Date;
}
