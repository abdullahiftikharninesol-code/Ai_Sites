import type { Connection } from "mongoose";
import type { MongoModels, MongoSiteJobRecord, MongoSiteProjectRecord } from "../persistence/mongodb/mongo-models.js";
import { PUBLISH_PREPARATIONS_COLLECTION } from "../publishing/publish-preparation-repository.js";
import { PUBLISH_OPERATIONS_COLLECTION, SITE_PUBLICATIONS_COLLECTION } from "../publishing/vercel-publish-repository.js";

/**
 * What persisted state still needs, loaded fresh for every plan and again
 * before any deletion. `available: false` means references could not be
 * proven: callers must fail closed (no snapshot or asset is a candidate).
 */
export interface StorageReferenceSnapshot {
  readonly available: boolean;
  readonly reason?: string;
  /** Per site: the current and the one retained previous source snapshot refs. */
  readonly retainedSourceRefs: ReadonlyMap<string, readonly string[]>;
  readonly knownSiteIds: ReadonlySet<string>;
  /** Sites with a QUEUED/RUNNING job: everything they own is protected. */
  readonly activeSiteIds: ReadonlySet<string>;
  /** Sites recorded only by the retired SQLite store: never orphaned, always protected. */
  readonly legacySiteIds?: ReadonlySet<string>;
  /** What publishing (deployment recovery, live and past publications) still needs. */
  readonly publishing: PublishingReferences;
}
export interface StorageReferenceSource {
  load(): Promise<StorageReferenceSnapshot>;
}

/**
 * Why publishing keeps a file, strongest first:
 *   UNRESOLVED_DEPLOYMENT   an operation whose outcome is still open (in progress, inconclusive, or a create Vercel never confirmed)
 *   PUBLISHED_VERSION       the live publication, its history, or any operation that was published
 *   PUBLISHING_PREPARATION  any other preparation record (expired or failed ones too: never assumed disposable)
 */
export type PublishingRetention = "UNRESOLVED_DEPLOYMENT" | "PUBLISHED_VERSION" | "PUBLISHING_PREPARATION";

export interface PublishingReferences {
  /** Source snapshot refs that preparations were built from (and recovery re-verifies), by strongest obligation. */
  readonly sourceRefs: ReadonlyMap<string, PublishingRetention>;
  /** Prepared artifact refs (sites/<site>/publishing/...), by strongest obligation. */
  readonly artifactRefs: ReadonlyMap<string, PublishingRetention>;
  /**
   * Metadata obligations that could not be resolved to files (an operation or
   * publication naming a missing operation/preparation): everything such a site
   * owns is protected.
   */
  readonly unresolvedSiteIds: ReadonlySet<string>;
}

export const emptyPublishingReferences = (): PublishingReferences => ({ sourceRefs: new Map(), artifactRefs: new Map(), unresolvedSiteIds: new Set() });

export const unavailableReferences = (reason: string): StorageReferenceSnapshot =>
  ({ available: false, reason, retainedSourceRefs: new Map(), knownSiteIds: new Set(), activeSiteIds: new Set(), publishing: emptyPublishingReferences() });

/** Raw, read-only rows of the publishing collections (only the fields storage needs). */
export interface PublishingReferenceRows {
  readonly preparations: readonly Record<string, unknown>[];
  readonly operations: readonly Record<string, unknown>[];
  readonly publications: readonly Record<string, unknown>[];
}
export interface PublishingReferenceReader {
  /** Throws when any collection cannot be read in full. */
  read(): Promise<PublishingReferenceRows>;
}

/** More records than this in one collection: references are not proven (fail closed) rather than half-loaded. */
export const MAX_PUBLISHING_RECORDS = 100_000;

/** Reads the three publishing collections directly (no model registration, no writes). */
export function mongoPublishingReferenceReader(connection: Connection, maxTimeMS?: number): PublishingReferenceReader {
  const rows = async (name: string, projection: Record<string, 1>) => {
    const found = await connection.collection(name).find({}, { projection, ...(maxTimeMS === undefined ? {} : { maxTimeMS }) }).limit(MAX_PUBLISHING_RECORDS + 1).toArray();
    if (found.length > MAX_PUBLISHING_RECORDS) throw new Error("PUBLISHING_REFERENCES_TOO_LARGE");
    return found as Record<string, unknown>[];
  };
  return {
    read: async () => ({
      preparations: await rows(PUBLISH_PREPARATIONS_COLLECTION, { preparationId: 1, siteId: 1, sourceArtifactRef: 1, artifact: 1 }),
      operations: await rows(PUBLISH_OPERATIONS_COLLECTION, { operationId: 1, siteId: 1, preparationId: 1, status: 1, active: 1, deploymentRequestedAt: 1, deploymentId: 1 }),
      publications: await rows(SITE_PUBLICATIONS_COLLECTION, { siteId: 1, operationId: 1, history: 1 }),
    }),
  };
}

class MalformedPublishingRecord extends Error {}
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new MalformedPublishingRecord();
  return value;
};
const RANK: Record<PublishingRetention, number> = { UNRESOLVED_DEPLOYMENT: 3, PUBLISHED_VERSION: 2, PUBLISHING_PREPARATION: 1 };
const keep = (map: Map<string, PublishingRetention>, ref: string, reason: PublishingRetention) => {
  const existing = map.get(ref);
  if (!existing || RANK[reason] > RANK[existing]) map.set(ref, reason);
};

/** Settled outcomes only: PUBLISHED, or FAILED with no deployment that Vercel might still finish. */
const unresolvedOperation = (op: Record<string, unknown>) =>
  op.active === true || (op.status !== "PUBLISHED" && op.status !== "FAILED") || (op.deploymentRequestedAt != null && !op.deploymentId);

/**
 * Turns publishing records into file obligations. Every preparation's source
 * and artifact are kept; operations and publications only strengthen the
 * reason, or, when they name a record that cannot be found, protect the whole
 * site. A malformed record throws (the caller fails closed).
 */
export function buildPublishingReferences(rows: PublishingReferenceRows): PublishingReferences {
  const sourceRefs = new Map<string, PublishingRetention>();
  const artifactRefs = new Map<string, PublishingRetention>();
  const unresolvedSiteIds = new Set<string>();
  const preparations = new Map<string, { sourceRef: string; artifactRef?: string }>();
  for (const row of rows.preparations) {
    const siteId = text(row.siteId);
    const artifact = row.artifact as { ref?: unknown } | null | undefined;
    const entry = { sourceRef: text(row.sourceArtifactRef), ...(artifact != null ? { artifactRef: text(artifact.ref) } : {}) };
    preparations.set(`${siteId}\0${text(row.preparationId)}`, entry);
    keep(sourceRefs, entry.sourceRef, "PUBLISHING_PREPARATION");
    if (entry.artifactRef) keep(artifactRefs, entry.artifactRef, "PUBLISHING_PREPARATION");
  }
  const operations = new Map<string, { siteId: string; preparationId: string }>();
  const obligation = (siteId: string, preparationId: string | undefined, reason: PublishingRetention) => {
    const preparation = preparationId === undefined ? undefined : preparations.get(`${siteId}\0${preparationId}`);
    if (!preparation) return unresolvedSiteIds.add(siteId);
    keep(sourceRefs, preparation.sourceRef, reason);
    if (preparation.artifactRef) keep(artifactRefs, preparation.artifactRef, reason);
  };
  for (const row of rows.operations) {
    const siteId = text(row.siteId), preparationId = text(row.preparationId);
    operations.set(text(row.operationId), { siteId, preparationId });
    if (unresolvedOperation(row)) obligation(siteId, preparationId, "UNRESOLVED_DEPLOYMENT");
    else if (row.status === "PUBLISHED") obligation(siteId, preparationId, "PUBLISHED_VERSION");
  }
  for (const row of rows.publications) {
    const siteId = text(row.siteId);
    if (row.history != null && !Array.isArray(row.history)) throw new MalformedPublishingRecord();
    const history = (row.history ?? []) as (Record<string, unknown> | null)[];
    for (const operationId of [text(row.operationId), ...history.map(entry => text(entry?.operationId))]) {
      const operation = operations.get(operationId);
      obligation(siteId, operation && operation.siteId === siteId ? operation.preparationId : undefined, "PUBLISHED_VERSION");
    }
  }
  return { sourceRefs, artifactRefs, unresolvedSiteIds };
}

/** Read-only view of the MongoDB current-state model (projects + active jobs) and publishing records. */
export class MongoStorageReferenceSource implements StorageReferenceSource {
  constructor(
    private readonly models: MongoModels,
    private readonly isConnected: () => boolean,
    /** Without it publishing obligations cannot be proven, so references are unavailable. */
    private readonly publishing?: PublishingReferenceReader,
  ) {}
  async load(): Promise<StorageReferenceSnapshot> {
    if (!this.isConnected()) return unavailableReferences("MONGODB_UNAVAILABLE");
    let projects, jobs;
    try {
      projects = await this.models.projects.find({}, { _id: 1, sourceArtifactRef: 1, versionNumber: 1, previousVersion: 1 }).lean().exec();
      jobs = await this.models.jobs.find({ status: { $in: ["QUEUED", "RUNNING"] } }, { projectId: 1 }).lean().exec();
    } catch {
      return unavailableReferences("MONGODB_QUERY_FAILED");
    }
    if (!this.publishing) return unavailableReferences("PUBLISHING_REFERENCES_UNAVAILABLE");
    let publishing: PublishingReferences;
    try {
      publishing = buildPublishingReferences(await this.publishing.read());
    } catch (error) {
      return unavailableReferences(error instanceof MalformedPublishingRecord ? "PUBLISHING_RECORD_MALFORMED" : "PUBLISHING_QUERY_FAILED");
    }
    return storageReferenceSnapshot(projects, jobs, publishing);
  }
}

/** Shared interpretation for the model reader and the inventory's native, query-only reader. */
export function storageReferenceSnapshot(
  projects: readonly Pick<MongoSiteProjectRecord, "_id" | "versionNumber" | "sourceArtifactRef" | "previousVersion">[],
  jobs: readonly Pick<MongoSiteJobRecord, "projectId">[],
  publishing: PublishingReferences,
): StorageReferenceSnapshot {
  const retained = new Map<string, string[]>();
  for (const project of projects) {
    const refs: string[] = [];
    // Legacy current-state records without an explicit ref use the fixed current key.
    if (project.versionNumber > 0) refs.push(project.sourceArtifactRef ?? `sites/${project._id}/current/source.json`);
    if (project.previousVersion?.sourceArtifactRef) refs.push(project.previousVersion.sourceArtifactRef);
    retained.set(project._id, refs);
  }
  return { available: true, retainedSourceRefs: retained, knownSiteIds: new Set(projects.map(project => project._id)),
    activeSiteIds: new Set(jobs.map(job => job.projectId)), publishing };
}
