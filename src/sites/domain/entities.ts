import type { DeploymentId, JobId, SiteId, UserId, VersionId } from "../../shared/types.js";
import type { SiteSpec } from "./site-spec.js";

export const SITE_PROJECT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type SiteProjectStatus = (typeof SITE_PROJECT_STATUSES)[number];

export interface SiteProject {
  readonly id: SiteId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly originalPrompt?: string;
  readonly versionNumber?: number;
  readonly lastOperation?: "GENERATE" | "EDIT";
  readonly lastEditPrompt?: string;
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

export type SiteJobOperation = "GENERATE" | "EDIT";
export type SiteJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface SiteJob {
  readonly id: JobId;
  readonly siteId: SiteId;
  readonly userId: UserId;
  readonly operation: SiteJobOperation;
  readonly status: SiteJobStatus;
  readonly stage: string;
  readonly provider: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly logicalCalls: number;
  readonly physicalRequests: number;
  readonly retries: number;
  readonly modelOutputReceived: boolean;
  readonly websiteGenerated: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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
