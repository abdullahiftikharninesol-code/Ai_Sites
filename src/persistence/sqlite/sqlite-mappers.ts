import type {
  SiteDeployment,
  SiteJob,
  SiteProject,
  SiteVersion,
} from "../../sites/domain/entities.js";
import type { DeploymentId, JobId, SiteId, UserId, VersionId } from "../../shared/types.js";
type Row = Record<string, unknown>;
const text = (row: Row, key: string) => {
  const value = row[key];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    throw new Error(`SQLite column '${key}' is not scalar`);
  return String(value);
};
const optional = (row: Row, key: string) =>
  row[key] === null || row[key] === undefined ? undefined : text(row, key);
const json = <T>(value: unknown): T | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("SQLite JSON column is not text");
  return JSON.parse(value) as T;
};
export const SqliteMappers = {
  project(row: Row): SiteProject {
    return {
      id: text(row, "id") as SiteId,
      ownerId: text(row, "owner_id") as UserId,
      name: text(row, "name"),
      slug: text(row, "slug"),
      status: text(row, "status") as SiteProject["status"],
      ...(optional(row, "latest_version_id")
        ? { latestVersionId: optional(row, "latest_version_id") as VersionId }
        : {}),
      ...(optional(row, "published_version_id")
        ? { publishedVersionId: optional(row, "published_version_id") as VersionId }
        : {}),
      ...(optional(row, "published_deployment_id")
        ? { publishedDeploymentId: optional(row, "published_deployment_id") as DeploymentId }
        : {}),
      createdAt: new Date(text(row, "created_at")),
      updatedAt: new Date(text(row, "updated_at")),
    };
  },
  version(row: Row): SiteVersion {
    const siteSpec = json<SiteVersion["siteSpec"]>(row.site_spec_json);
    const changeSummary = json<readonly string[]>(row.change_summary_json);
    const screenshots = json<readonly string[]>(row.final_screenshot_refs_json);
    const browserQaScreenshots = json<readonly string[]>(row.browser_qa_screenshot_refs_json);
    const visualReviewScreenshots = json<readonly string[]>(row.visual_review_screenshot_refs_json);
    const usage = json<Readonly<Record<string, unknown>>>(row.usage_summary_json);
    return {
      id: text(row, "id") as VersionId,
      siteId: text(row, "site_id") as SiteId,
      versionNumber: Number(row.version_number),
      ...(optional(row, "parent_version_id")
        ? { parentVersionId: optional(row, "parent_version_id") as VersionId }
        : {}),
      sourceArtifactRef: text(row, "source_artifact_ref"),
      ...(optional(row, "source_manifest_ref")
        ? { sourceManifestRef: optional(row, "source_manifest_ref")! }
        : {}),
      ...(optional(row, "asset_manifest_artifact_ref")
        ? { assetManifestArtifactRef: optional(row, "asset_manifest_artifact_ref")! }
        : {}),
      ...(optional(row, "build_artifact_ref")
        ? { buildArtifactRef: optional(row, "build_artifact_ref")! }
        : {}),
      buildStatus: text(row, "build_status") as SiteVersion["buildStatus"],
      ...(siteSpec ? { siteSpec } : {}),
      ...(optional(row, "technical_profile_id")
        ? { technicalProfileId: optional(row, "technical_profile_id")! }
        : {}),
      ...(optional(row, "template_id") ? { templateId: optional(row, "template_id")! } : {}),
      ...(row.template_version !== null && row.template_version !== undefined
        ? { templateVersion: Number(row.template_version) }
        : {}),
      ...(changeSummary ? { changeSummary } : {}),
      ...(optional(row, "visual_qa_status")
        ? {
            visualQAStatus: optional(row, "visual_qa_status") as NonNullable<
              SiteVersion["visualQAStatus"]
            >,
          }
        : {}),
      ...(row.visual_qa_score !== null && row.visual_qa_score !== undefined
        ? { visualQAScore: Number(row.visual_qa_score) }
        : {}),
      ...(optional(row, "visual_qa_artifact_ref")
        ? { visualQAArtifactRef: optional(row, "visual_qa_artifact_ref")! }
        : {}),
      ...(screenshots ? { finalScreenshotRefs: screenshots } : {}),
      ...(optional(row, "browser_qa_status")
        ? { browserQAStatus: optional(row, "browser_qa_status") as NonNullable<SiteVersion["browserQAStatus"]> }
        : {}),
      ...(optional(row, "browser_qa_artifact_ref")
        ? { browserQAArtifactRef: optional(row, "browser_qa_artifact_ref")! }
        : {}),
      ...(browserQaScreenshots ? { browserQAScreenshotRefs: browserQaScreenshots } : {}),
      ...(optional(row, "visual_review_status")
        ? { visualReviewStatus: optional(row, "visual_review_status") as NonNullable<SiteVersion["visualReviewStatus"]> }
        : {}),
      ...(optional(row, "visual_review_id") ? { visualReviewId: optional(row, "visual_review_id")! } : {}),
      ...(optional(row, "visual_review_artifact_ref")
        ? { visualReviewArtifactRef: optional(row, "visual_review_artifact_ref")! }
        : {}),
      ...(visualReviewScreenshots ? { visualReviewScreenshotRefs: visualReviewScreenshots } : {}),
      ...(optional(row, "visual_repair_attempt_id") ? { visualRepairAttemptId: optional(row, "visual_repair_attempt_id")! } : {}),
      ...(optional(row, "visual_repair_attempt_status")
        ? { visualRepairAttemptStatus: optional(row, "visual_repair_attempt_status")! }
        : {}),
      ...(optional(row, "visual_repair_attempt_artifact_ref")
        ? { visualRepairAttemptArtifactRef: optional(row, "visual_repair_attempt_artifact_ref")! }
        : {}),
      ...(usage ? { usageSummary: usage } : {}),
      ...(row.runtime_schema_version !== null && row.runtime_schema_version !== undefined
        ? { runtimeSchemaVersion: Number(row.runtime_schema_version) }
        : {}),
      createdAt: new Date(text(row, "created_at")),
    };
  },
  job(row: Row): SiteJob {
    const error = json<SiteJob["error"]>(row.error_json);
    return {
      id: text(row, "id") as JobId,
      siteId: text(row, "site_id") as SiteId,
      userId: text(row, "user_id") as UserId,
      type: text(row, "type") as SiteJob["type"],
      status: text(row, "status") as SiteJob["status"],
      progress: Number(row.progress),
      ...(error ? { error } : {}),
      createdAt: new Date(text(row, "created_at")),
      ...(optional(row, "started_at") ? { startedAt: new Date(optional(row, "started_at")!) } : {}),
      ...(optional(row, "completed_at")
        ? { completedAt: new Date(optional(row, "completed_at")!) }
        : {}),
    };
  },
  deployment(row: Row): SiteDeployment {
    return {
      id: text(row, "id") as DeploymentId,
      siteId: text(row, "site_id") as SiteId,
      versionId: text(row, "version_id") as VersionId,
      hostname: text(row, "hostname"),
      status: text(row, "status") as SiteDeployment["status"],
      ...(optional(row, "hosting_provider")
        ? { hostingProvider: optional(row, "hosting_provider")! }
        : {}),
      ...(optional(row, "deployment_artifact_ref")
        ? { deploymentArtifactRef: optional(row, "deployment_artifact_ref")! }
        : {}),
      ...(optional(row, "deployment_manifest_ref")
        ? { deploymentManifestRef: optional(row, "deployment_manifest_ref")! }
        : {}),
      ...(optional(row, "completed_at")
        ? { completedAt: new Date(optional(row, "completed_at")!) }
        : {}),
      ...(optional(row, "published_at")
        ? { publishedAt: new Date(optional(row, "published_at")!) }
        : {}),
      ...(optional(row, "failure") ? { failure: optional(row, "failure")! } : {}),
      ...(json<Readonly<Record<string, number>>>(row.metrics_json)
        ? { metrics: json<Readonly<Record<string, number>>>(row.metrics_json)! }
        : {}),
      createdAt: new Date(text(row, "created_at")),
    };
  },
  json(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
  },
};
