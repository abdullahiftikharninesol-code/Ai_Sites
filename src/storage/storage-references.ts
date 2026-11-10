import type { MongoModels } from "../persistence/mongodb/mongo-models.js";

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
}
export interface StorageReferenceSource {
  load(): Promise<StorageReferenceSnapshot>;
}

export const unavailableReferences = (reason: string): StorageReferenceSnapshot =>
  ({ available: false, reason, retainedSourceRefs: new Map(), knownSiteIds: new Set(), activeSiteIds: new Set() });

/** Read-only view of the MongoDB current-state model (projects + active jobs). */
export class MongoStorageReferenceSource implements StorageReferenceSource {
  constructor(private readonly models: MongoModels, private readonly isConnected: () => boolean) {}
  async load(): Promise<StorageReferenceSnapshot> {
    if (!this.isConnected()) return unavailableReferences("MONGODB_UNAVAILABLE");
    try {
      const projects = await this.models.projects.find({}, { _id: 1, sourceArtifactRef: 1, versionNumber: 1, previousVersion: 1 }).lean().exec();
      const jobs = await this.models.jobs.find({ status: { $in: ["QUEUED", "RUNNING"] } }, { projectId: 1 }).lean().exec();
      const retained = new Map<string, string[]>();
      for (const project of projects) {
        const refs: string[] = [];
        // Legacy current-state records without an explicit ref use the fixed current key.
        if (project.versionNumber > 0) refs.push(project.sourceArtifactRef ?? `sites/${project._id}/current/source.json`);
        if (project.previousVersion?.sourceArtifactRef) refs.push(project.previousVersion.sourceArtifactRef);
        retained.set(project._id, refs);
      }
      return { available: true, retainedSourceRefs: retained, knownSiteIds: new Set(projects.map(project => project._id)),
        activeSiteIds: new Set(jobs.map(job => job.projectId)) };
    } catch {
      return unavailableReferences("MONGODB_QUERY_FAILED");
    }
  }
}
