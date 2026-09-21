import type { ArtifactStore } from "../persistence/artifact-store.js";
import { ArtifactNamespace } from "../persistence/artifact-namespace.js";
import type { SiteId, VersionId } from "../shared/types.js";
import {
  serializeVisualRepairAttempt,
  serializeVisualReview,
  type VisualRepairAttempt,
  type VisualReview,
} from "./visual-review-domain.js";

export async function persistVisualReview(
  artifacts: ArtifactStore,
  siteId: SiteId,
  versionId: VersionId,
  review: VisualReview,
): Promise<string> {
  const ref = ArtifactNamespace.version(siteId, versionId, "VISUAL_REVIEW_REPORT", "visual-review.json");
  await artifacts.put(ref, Buffer.from(serializeVisualReview(review), "utf8"), {
    kind: "VISUAL_REVIEW_REPORT",
    contentType: "application/json",
  });
  return ref;
}

export async function persistVisualRepairAttempt(
  artifacts: ArtifactStore,
  siteId: SiteId,
  versionId: VersionId,
  attempt: VisualRepairAttempt,
): Promise<string> {
  const ref = ArtifactNamespace.version(siteId, versionId, "VISUAL_REPAIR_ATTEMPT", "visual-repair-attempt.json");
  await artifacts.put(ref, Buffer.from(serializeVisualRepairAttempt(attempt), "utf8"), {
    kind: "VISUAL_REPAIR_ATTEMPT",
    contentType: "application/json",
  });
  return ref;
}
