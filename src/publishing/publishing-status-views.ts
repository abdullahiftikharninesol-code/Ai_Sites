import type { SiteProject } from "../sites/domain/entities.js";
import type { PublishPreparationRecord, PublishPreparationArtifact } from "./publish-preparation-repository.js";
import type { PublishPreparationView } from "./publish-preparation-service.js";
import type { PublishOperationRecord, SitePublicationRecord, PublishOperationStatus } from "./vercel-publish-repository.js";
import type { LiveImpact, PublishStatus, VercelPublishView } from "./vercel-publish-service.js";

// Shared pure display mapping: no repositories, providers, filesystem or model initialization.
export const IN_PROGRESS_STATUSES: readonly PublishOperationStatus[] = ["PREPARING", "UPLOADING", "DEPLOYING"];
export const SETTLED_DEPLOYMENT_STATES: readonly string[] = ["READY", "ERROR", "CANCELED", "DELETED", "BLOCKED"];
export const deploymentMayStillGoLive = (op: Pick<PublishOperationRecord, "deploymentRequestedAt" | "deploymentId" | "deploymentState">) =>
  !!(op.deploymentRequestedAt || op.deploymentId) && (!op.deploymentId || !SETTLED_DEPLOYMENT_STATES.includes(op.deploymentState ?? ""));
const publicationChanged = (publication: SitePublicationRecord) =>
  !!publication.checkedAt && publication.observedDeploymentId !== publication.deploymentId;

/** Exact view inputs: a metadata projection is not an executable/prepared artifact. */
export type PreparationStatusRecord = Omit<PublishPreparationRecord, "idempotencyKey" | "sourceArtifactRef" | "sourceSha256" | "connection" | "artifact"> & {
  readonly artifact?: Pick<PublishPreparationArtifact, "fileCount" | "totalBytes" | "routing" | "sha256">;
};
export type OperationStatusRecord = Omit<PublishOperationRecord, "preparationId">;

export function preparationStatusView(record: PreparationStatusRecord, project: Pick<SiteProject, "latestVersionId">, options: { now: Date; maxAttempts?: number; isRunning?: (id: string) => boolean }): PublishPreparationView {
    const now = options.now;
    const expired = record.status === "READY_TO_DEPLOY" && !!record.expiresAt && record.expiresAt <= now;
    // A crashed server's attempt: its lease lapsed and nothing here is building it.
    const abandoned = record.status === "PREPARING" && !!record.leaseExpiresAt && record.leaseExpiresAt <= now && !options.isRunning?.(record.preparationId);
    if (abandoned)
      record = {
        ...record,
        status: "PREPARATION_FAILED",
        failure: { code: "PUBLISH_PREPARATION_FAILED", message: "Publishing preparation was interrupted. Try again.", retryable: record.attempt < (options.maxAttempts ?? 5) },
      };
    return {
      preparationId: record.preparationId,
      siteId: record.siteId,
      versionId: record.versionId,
      versionNumber: record.versionNumber,
      status: expired ? "EXPIRED" : record.status,
      published: false,
      isCurrentVersion: project.latestVersionId === record.versionId,
      attempt: record.attempt,
      ...(record.artifact && record.status === "READY_TO_DEPLOY"
        ? { artifact: { fileCount: record.artifact.fileCount, totalBytes: record.artifact.totalBytes, routing: record.artifact.routing, sha256: record.artifact.sha256 } }
        : {}),
      project: record.project
        ? { status: record.project.status, ...(record.project.projectId ? { projectId: record.project.projectId } : {}), ...(record.project.projectName ? { projectName: record.project.projectName } : {}) }
        : { status: "NOT_LINKED" },
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.metrics ? { metrics: record.metrics } : {}),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      ...(record.completedAt ? { completedAt: record.completedAt.toISOString() } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
    };
  }

export function publicationStatusView(project: Pick<SiteProject, "latestVersionId">, latest: OperationStatusRecord | undefined, publication: SitePublicationRecord | undefined, connected: { readonly accountId: string } | undefined, options: { now: Date; liveEnabled: boolean; hostingConfigVersion: number; isRunning?: (id: string) => boolean }): VercelPublishView {
    const now = options.now;
    let operation = latest;
    // A crashed server's attempt: its lease lapsed and nothing here is running it.
    if (operation?.active && IN_PROGRESS_STATUSES.includes(operation.status) && operation.leaseExpiresAt && operation.leaseExpiresAt <= now && !options.isRunning?.(operation.operationId))
      operation = { ...operation, status: "VERIFICATION_INCONCLUSIVE", failure: { code: "PUBLISH_INTERRUPTED", message: "Publishing was interrupted. Publish again; AI Sites checks Vercel before deploying again.", retryable: true } };
    const history = publication?.history ?? [];
    const before = history.length >= 2 && history.at(-1)?.operationId === publication?.operationId ? history.at(-2) : undefined;
    const published = publication
      ? {
          url: publication.publicUrl,
          versionId: publication.versionId,
          versionNumber: publication.versionNumber,
          deploymentId: publication.deploymentId,
          publishedAt: publication.publishedAt.toISOString(),
          isCurrentVersion: publication.versionId === project.latestVersionId,
          urlChanged: !!before && before.publicUrl !== publication.publicUrl,
          // Verified when published; CHANGED once a later check found the address serving another deployment.
          liveState: publicationChanged(publication) ? ("CHANGED" as const) : ("VERIFIED" as const),
          checkedAt: (publication.checkedAt ?? publication.publishedAt).toISOString(),
          // Which kind of account updates need; its name only when Vercel reported one. No IDs.
          account: { type: publication.accountId.startsWith("team_") ? ("team" as const) : ("personal" as const), ...(publication.accountLabel ? { label: publication.accountLabel } : {}) },
          // Republishing (even the same version) regenerates its hosting configuration.
          ...((publication.hostingVersion ?? 1) < options.hostingConfigVersion ? { hostingOutdated: true as const } : {}),
          // Known only while a connection exists: false means updates need the account this site was published with.
          ...(connected ? { connectedAccountMatches: connected.accountId === publication.accountId } : {}),
        }
      : undefined;
    // An unverified attempt started after the live publication is an update of it.
    const liveImpact = operation && publication && operation.status !== "PUBLISHED" && operation.createdAt > publication.publishedAt
      ? liveImpactOf(operation, publication, operation !== latest)
      : undefined;
    // An active attempt, or a finished one newer than the live publication, describes the site;
    // otherwise the last verified publication does. A failed attempt never hides `published`.
    const newerThanPublication = !!operation && (!publication || operation.createdAt > publication.publishedAt);
    const status: PublishStatus = operation && (operation.active || newerThanPublication)
      ? operation.status
      : published ? "PUBLISHED" : "NOT_PUBLISHED";
    return {
      liveEnabled: options.liveEnabled,
      status,
      draft: { versionId: project.latestVersionId ?? null, hasUnpublishedChanges: !!publication && publication.versionId !== project.latestVersionId },
      ...(published ? { published } : {}),
      ...(operation
        ? {
            operation: {
              operationId: operation.operationId,
              versionId: operation.versionId,
              status: operation.status,
              attempt: operation.attempt,
              ...(operation.progress ? { progress: operation.progress } : {}),
              ...(operation.status === "PUBLISHED" && operation.publicUrl ? { publicUrl: operation.publicUrl } : {}),
              ...(operation.failure ? { failure: { code: operation.failure.code, message: operation.failure.message, retryable: operation.failure.retryable } } : {}),
              ...(liveImpact ? { liveImpact } : {}),
              // Vercel may still finish this deployment and assign it to production on its own.
              ...(operation.status !== "PUBLISHED" && deploymentMayStillGoLive(operation) ? { pendingDeployment: true } : {}),
              updatedAt: operation.updatedAt.toISOString(),
            },
          }
        : {}),
    };
  }

function liveImpactOf(operation: OperationStatusRecord, publication: SitePublicationRecord, interrupted: boolean): LiveImpact {
    if (!operation.deploymentRequestedAt && !operation.deploymentId) return "UNCHANGED";
    // An interrupted attempt's last observation may be outdated.
    if (interrupted || !operation.productionDeploymentId) return "UNKNOWN";
    if (operation.productionDeploymentId === publication.deploymentId) return operation.rollbackRequestedAt ? "PREVIOUS_RESTORED" : "PREVIOUS_LIVE";
    if (operation.productionDeploymentId === operation.deploymentId) return "NEW_UNVERIFIED";
    return "UNKNOWN";
  }
