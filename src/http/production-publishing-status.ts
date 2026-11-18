import type { Connection } from "mongoose";
import type { PublishPreparationRecord } from "../publishing/publish-preparation-repository.js";
import type { PublishOperationRecord, SitePublicationRecord, PublicationHistoryEntry } from "../publishing/vercel-publish-repository.js";
import { preparationStatusView, publicationStatusView, IN_PROGRESS_STATUSES, type PreparationStatusRecord, type OperationStatusRecord } from "../publishing/publishing-status-views.js";
import { isPublishingErrorCode } from "../publishing/publishing-errors.js";
import { HOSTING_CONFIG_VERSION } from "../publishing/static-artifact.js";
import type { ProductionRoute } from "./production-http-routes.js";
import { validSiteId } from "./production-website-reads.js";
import type { VersionId } from "../shared/types.js";

/** Only native reads. No service/repository constructors or repair methods. */
export interface PublishingStatusReads {
  site(ownerId: string, siteId: string): Promise<unknown>;
  preparation(ownerId: string, siteId: string): Promise<unknown>;
  operation(ownerId: string, siteId: string): Promise<unknown>;
  publication(ownerId: string, siteId: string): Promise<unknown>;
  account(ownerId: string): Promise<unknown>;
}
export const PREPARATION_STATUS_PROJECTION = Object.freeze({ _id: 0, ownerId: 1, siteId: 1, provider: 1, preparationId: 1, versionId: 1, versionNumber: 1,
  connection: 1, status: 1, attempt: 1, leaseExpiresAt: 1, "artifact.fileCount": 1, "artifact.totalBytes": 1, "artifact.routing": 1, "artifact.sha256": 1,
  project: 1, "failure.code": 1, "failure.retryable": 1, createdAt: 1, updatedAt: 1, completedAt: 1, expiresAt: 1 });
export const OPERATION_STATUS_PROJECTION = Object.freeze({ _id: 0, ownerId: 1, siteId: 1, provider: 1, operationId: 1, versionId: 1, versionNumber: 1,
  status: 1, active: 1, attempt: 1, leaseExpiresAt: 1, configurationId: 1, accountId: 1, projectId: 1, deploymentId: 1, deploymentState: 1,
  sourceSha256: 1, artifactSha256: 1, progress: 1, deploymentRequestedAt: 1, productionDeploymentId: 1, productionCheckedAt: 1,
  rollbackRequestedAt: 1, "failure.code": 1, "failure.retryable": 1, createdAt: 1, updatedAt: 1 });
export const PUBLICATION_STATUS_PROJECTION = Object.freeze({ _id: 0, ownerId: 1, siteId: 1, provider: 1, operationId: 1, versionId: 1, versionNumber: 1,
  configurationId: 1, accountId: 1, accountLabel: 1, projectId: 1, deploymentId: 1, publicUrl: 1, publishedAt: 1, sourceSha256: 1, artifactSha256: 1,
  hostingVersion: 1, checkedAt: 1, observedDeploymentId: 1, history: { $slice: -2 } });
export const ACCOUNT_STATUS_PROJECTION = Object.freeze({ _id: 0, ownerId: 1, status: 1, configurationId: 1, teamId: 1, vercelUserId: 1 });
export function mongoPublishingStatusReads(connection: Pick<Connection, "db">): PublishingStatusReads {
  const collection = (name: string) => {
    if (!connection.db) throw unavailable();
    return connection.db.collection<{ _id: string; [key: string]: unknown }>(name);
  };
  return {
    site: (ownerId, siteId) => collection("sites_projects").findOne({ _id: siteId, ownerId }, { projection: { _id: 1, ownerId: 1, versionNumber: 1 }, maxTimeMS: 5_000 }),
    preparation: (ownerId, siteId) => collection("sites_publish_preparations").findOne({ ownerId, siteId }, { projection: PREPARATION_STATUS_PROJECTION, sort: { createdAt: -1, preparationId: -1 }, maxTimeMS: 5_000 }),
    operation: (ownerId, siteId) => collection("sites_publish_operations").findOne({ ownerId, siteId }, { projection: OPERATION_STATUS_PROJECTION, sort: { createdAt: -1, operationId: -1 }, maxTimeMS: 5_000 }),
    publication: (ownerId, siteId) => collection("sites_site_publications").findOne({ ownerId, siteId }, { projection: PUBLICATION_STATUS_PROJECTION, maxTimeMS: 5_000 }),
    account: ownerId => collection("sites_vercel_connections").findOne({ ownerId, status: "active" }, { projection: ACCOUNT_STATUS_PROJECTION, maxTimeMS: 5_000 }),
  };
}
const unavailable = () => Object.assign(new Error("Publishing status is unavailable"), { code: "PUBLISH_STATUS_UNAVAILABLE" });
const notFound = () => Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/.test(value)) throw unavailable();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw unavailable();
  return value;
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw unavailable();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw unavailable();
  return value;
}
function publicUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || /\s/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw unavailable();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)) throw unavailable();
    return value;
  } catch { throw unavailable(); }
}
function scoped(value: unknown, ownerId: string, siteId: string) {
  const row = object(value);
  if (row.ownerId !== ownerId || row.siteId !== siteId) throw notFound();
  if (row.provider !== "vercel") throw unavailable();
  return row;
}
function version(row: Record<string, unknown>, siteId: string, required = true) {
  const value = id(row.versionId), match = new RegExp(`^${siteId}:v([1-9][0-9]*)$`).exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])) || (required || row.versionNumber !== undefined) && integer(row.versionNumber, 1) !== Number(match[1])) throw unavailable();
  return { versionId: value, ...(row.versionNumber !== undefined ? { versionNumber: integer(row.versionNumber, 1) } : {}) };
}
function failure(value: unknown, preparation: boolean) {
  const row = object(value);
  const code = typeof row.code === "string" && isPublishingErrorCode(row.code) ? row.code : preparation ? "PUBLISH_PREPARATION_FAILED" : "PUBLISH_VERIFICATION_FAILED";
  return { code, message: preparation ? "Publishing preparation could not complete. Check the connection and try again." : "Publishing could not be confirmed. Check the connection and try again.", retryable: row.retryable === true };
}
function base(row: Record<string, unknown>, ownerId: string, siteId: string) {
  const createdAt = date(row.createdAt), updatedAt = date(row.updatedAt);
  if (updatedAt < createdAt) throw unavailable();
  return { ownerId, siteId, provider: "vercel" as const, ...version(row, siteId, false), attempt: integer(row.attempt, 1), createdAt, updatedAt };
}
function account(value: unknown, ownerId: string) {
  if (value == null) return undefined;
  const row = object(value);
  if (row.ownerId !== ownerId) throw notFound();
  if (row.status !== "active") return undefined;
  // Invalid identity means unknown, never a positive account-match claim.
  try { return { configurationId: id(row.configurationId), accountId: row.teamId == null ? id(row.vercelUserId) : id(row.teamId) }; }
  catch { return undefined; }
}
function publication(value: unknown, ownerId: string, siteId: string): SitePublicationRecord | undefined {
  if (value == null) return undefined;
  const row = scoped(value, ownerId, siteId), v = version(row, siteId);
  const result = { ownerId, siteId, provider: "vercel" as const, ...v, versionNumber: integer(row.versionNumber, 1), operationId: id(row.operationId),
    configurationId: id(row.configurationId), accountId: id(row.accountId), projectId: id(row.projectId), deploymentId: id(row.deploymentId), publicUrl: publicUrl(row.publicUrl),
    sourceSha256: hash(row.sourceSha256), artifactSha256: hash(row.artifactSha256), publishedAt: date(row.publishedAt),
    ...(row.hostingVersion !== undefined ? { hostingVersion: integer(row.hostingVersion, 1) } : {}),
    ...(typeof row.accountLabel === "string" && row.accountLabel.length <= 120 && !/[\r\n\t]/.test(row.accountLabel) ? { accountLabel: row.accountLabel } : {}),
  };
  let observation: Pick<SitePublicationRecord, "checkedAt" | "observedDeploymentId"> = {};
  // A missing/invalid observation is not evidence of drift or a disappeared website.
  if (row.checkedAt instanceof Date && Number.isFinite(row.checkedAt.getTime()) && row.checkedAt >= result.publishedAt && (row.observedDeploymentId === null || typeof row.observedDeploymentId === "string")) {
    try { observation = { checkedAt: row.checkedAt, observedDeploymentId: row.observedDeploymentId === null ? null : id(row.observedDeploymentId) }; }
    catch { /* An invalid observation leaves the last verified publication intact. */ }
  }
  let history: PublicationHistoryEntry[] | undefined;
  if (row.history !== undefined) {
    if (!Array.isArray(row.history) || row.history.length > 2) throw unavailable();
    history = (row.history as unknown[]).map(value => {
      const entry = object(value);
      return { operationId: id(entry.operationId), ...version(entry, siteId), versionNumber: integer(entry.versionNumber, 1), deploymentId: id(entry.deploymentId), publicUrl: publicUrl(entry.publicUrl), publishedAt: date(entry.publishedAt) };
    });
  }
  return { ...result, ...observation, ...(history ? { history } : {}) };
}
function preparation(value: unknown, ownerId: string, siteId: string, pinned: SitePublicationRecord | undefined, connected: ReturnType<typeof account>): PreparationStatusRecord | undefined {
  if (value == null) return undefined;
  const row = scoped(value, ownerId, siteId), connection = object(row.connection);
  const conn = { configurationId: id(connection.configurationId), teamId: connection.teamId == null ? null : id(connection.teamId), vercelUserId: id(connection.vercelUserId) };
  if (!["PREPARING", "READY_TO_DEPLOY", "PREPARATION_FAILED"].includes(String(row.status))) throw unavailable();
  const result = { ...base(row, ownerId, siteId), ...version(row, siteId), versionNumber: integer(row.versionNumber, 1), preparationId: id(row.preparationId), connection: conn,
    status: row.status as PublishPreparationRecord["status"], ...(row.leaseExpiresAt !== undefined ? { leaseExpiresAt: date(row.leaseExpiresAt) } : {}),
    ...(row.completedAt !== undefined ? { completedAt: date(row.completedAt) } : {}), ...(row.expiresAt !== undefined ? { expiresAt: date(row.expiresAt) } : {}),
    ...(row.failure !== undefined ? { failure: failure(row.failure, true) } : {}),
  };
  let artifact: PreparationStatusRecord["artifact"], project: PublishPreparationRecord["project"] = { status: "NOT_LINKED" };
  if (row.artifact !== undefined) {
    const item = object(row.artifact);
    if (!["history", "hash", "none"].includes(String(item.routing))) throw unavailable();
    // The shared view reads only this explicitly projected summary; no artifact path is loaded or fabricated.
    artifact = { fileCount: integer(item.fileCount, 1), totalBytes: integer(item.totalBytes, 1), routing: item.routing as "history" | "hash" | "none", sha256: hash(item.sha256) };
  }
  const accountId = conn.teamId ?? conn.vercelUserId;
  let mismatch = !!pinned && pinned.accountId !== accountId || !!connected && (connected.accountId !== accountId || connected.configurationId !== conn.configurationId);
  if (row.project !== undefined) {
    const item = object(row.project);
    if (item.status === "LINKED") {
      const projectId = id(item.projectId), projectAccount = id(item.accountId);
      mismatch ||= projectAccount !== accountId || !!pinned && pinned.projectId !== projectId;
      project = { status: "LINKED", projectId, ...(item.projectName !== undefined ? { projectName: id(item.projectName) } : {}) };
    } else if (item.status !== "NOT_LINKED") throw unavailable();
  }
  if (mismatch) return { ...result, status: "PREPARATION_FAILED", project: { status: "NOT_LINKED" }, failure: { code: "VERCEL_ACCOUNT_MISMATCH", message: "This preparation requires its original Vercel account and project.", retryable: false } };
  if (result.status === "READY_TO_DEPLOY" && (!artifact || !result.expiresAt || !result.completedAt || result.completedAt < result.createdAt || result.expiresAt <= result.completedAt)) throw unavailable();
  return { ...result, ...(artifact ? { artifact } : {}), project,
    ...(result.status === "PREPARING" && !result.leaseExpiresAt ? { leaseExpiresAt: new Date(0) } : {}),
  };
}
function operation(value: unknown, ownerId: string, siteId: string, pinned: SitePublicationRecord | undefined): OperationStatusRecord | undefined {
  if (value == null) return undefined;
  const row = scoped(value, ownerId, siteId);
  if (![...IN_PROGRESS_STATUSES, "PUBLISHED", "FAILED", "VERIFICATION_INCONCLUSIVE"].includes(String(row.status)) || typeof row.active !== "boolean") throw unavailable();
  const result = { ...base(row, ownerId, siteId), operationId: id(row.operationId), status: row.status as PublishOperationRecord["status"], active: row.active,
    ...(row.leaseExpiresAt !== undefined ? { leaseExpiresAt: date(row.leaseExpiresAt) } : {}), ...(row.failure !== undefined ? { failure: failure(row.failure, false) } : {}),
  };
  const extra: Record<string, unknown> = {};
  for (const field of ["accountId", "configurationId", "projectId", "deploymentId", "deploymentState"] as const) if (row[field] !== undefined) extra[field] = id(row[field]);
  for (const field of ["deploymentRequestedAt", "productionCheckedAt", "rollbackRequestedAt"] as const) if (row[field] !== undefined) extra[field] = date(row[field]);
  if (row.productionDeploymentId !== undefined) extra.productionDeploymentId = row.productionDeploymentId === null ? null : id(row.productionDeploymentId);
  if (!(extra.productionCheckedAt instanceof Date) || extra.productionCheckedAt < result.createdAt) extra.productionDeploymentId = null;
  if (row.progress !== undefined) {
    const progress = object(row.progress), filesTotal = integer(progress.filesTotal), filesUploaded = integer(progress.filesUploaded);
    if (filesUploaded > filesTotal) throw unavailable();
    extra.progress = { filesTotal, filesUploaded, bytesTotal: integer(progress.bytesTotal) };
  }
  let op: OperationStatusRecord = { ...result, ...extra };
  const mismatched = !!pinned && (!!op.accountId && op.accountId !== pinned.accountId || !!op.projectId && op.projectId !== pinned.projectId);
  const missingDeploymentIdentity = !!(op.deploymentId || op.deploymentRequestedAt) && (!op.accountId || !op.projectId || !op.configurationId);
  const confirmed = !!pinned && pinned.operationId === op.operationId && pinned.versionId === op.versionId && pinned.deploymentId === op.deploymentId &&
    pinned.accountId === op.accountId && pinned.projectId === op.projectId && pinned.configurationId === op.configurationId &&
    row.sourceSha256 === pinned.sourceSha256 && row.artifactSha256 === pinned.artifactSha256;
  if (mismatched || missingDeploymentIdentity || op.status === "PUBLISHED" && !confirmed || op.status === "DEPLOYING" && (!op.accountId || !op.projectId) || !op.active && IN_PROGRESS_STATUSES.includes(op.status)) {
    op = { ...op, status: "VERIFICATION_INCONCLUSIVE", active: false, productionDeploymentId: null,
      failure: { code: mismatched ? "VERCEL_ACCOUNT_MISMATCH" : "PUBLISH_VERIFICATION_FAILED", message: "This publishing outcome needs verification using its original account and project.", retryable: true } };
  }
  if (op.active && IN_PROGRESS_STATUSES.includes(op.status) && !op.leaseExpiresAt) op = { ...op, leaseExpiresAt: new Date(0) };
  // Expose a URL on an operation only when it is the authoritative verified publication.
  return confirmed && op.status === "PUBLISHED" ? { ...op, publicUrl: pinned.publicUrl } : op;
}

export function productionPublishingStatusRoutes(reads: PublishingStatusReads, now = () => new Date(), liveEnabled = false): readonly ProductionRoute[] {
  const owned = async (ownerId: string, siteId: string) => {
    if (!validSiteId(siteId)) throw notFound();
    const row = await reads.site(ownerId, siteId);
    if (row == null) throw notFound();
    const site = object(row);
    if (site._id !== siteId || site.ownerId !== ownerId) throw notFound();
    const versionNumber = integer(site.versionNumber);
    return { versionNumber, ...(versionNumber ? { latestVersionId: `${siteId}:v${versionNumber}` as VersionId } : {}) };
  };
  return (["preparation", "vercel"] as const).map((kind): ProductionRoute => ({ access: "authenticated", method: "GET", path: `/api/dev/sites/:siteId/publish/${kind}`,
    handle: async ({ ownerId, params, response }) => {
      const siteId = params.siteId!, site = await owned(ownerId, siteId);
      const [raw, pinnedRow, connection] = await Promise.all([kind === "preparation" ? reads.preparation(ownerId, siteId) : reads.operation(ownerId, siteId), reads.publication(ownerId, siteId), reads.account(ownerId)]);
      const pinned = publication(pinnedRow, ownerId, siteId), connected = account(connection, ownerId);
      let result: unknown;
      if (kind === "preparation") {
        const record = preparation(raw, ownerId, siteId, pinned, connected);
        result = { preparation: record ? preparationStatusView(record, site, { now: now() }) : null };
      } else {
        const op = operation(raw, ownerId, siteId, pinned);
        const publish = publicationStatusView(site, op, pinned, connected, { now: now(), liveEnabled, hostingConfigVersion: HOSTING_CONFIG_VERSION });
        // READY alone does not prove alias assignment has settled; production status never assumes that.
        result = { publish: op?.deploymentId && op.deploymentState === "READY" && op.status !== "PUBLISHED" && publish.operation
          ? { ...publish, operation: { ...publish.operation, pendingDeployment: true } } : publish };
      }
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > 64_000 || (await owned(ownerId, siteId)).versionNumber !== site.versionNumber) throw unavailable();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(serialized);
    },
  }));
}
