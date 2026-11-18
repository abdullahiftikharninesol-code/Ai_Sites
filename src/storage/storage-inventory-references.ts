import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Connection } from "mongoose";
import type { MongoSiteJobRecord, MongoSiteProjectRecord } from "../persistence/mongodb/mongo-models.js";
import { LEGACY_SQLITE_STORES } from "./legacy-store-references.js";
import {
  buildPublishingReferences, MAX_PUBLISHING_RECORDS, mongoPublishingReferenceReader,
  storageReferenceSnapshot, unavailableReferences, type StorageReferenceSource,
} from "./storage-references.js";

/** No model registration, auto-indexing, collection creation or write methods. Projections omit prompts/credentials. */
export function inventoryMongoReferences(connection: Connection): StorageReferenceSource {
  const rows = async (name: string, filter: Record<string, unknown>, projection: Record<string, 1>) => {
    const result = await connection.collection(name).find(filter, { projection, maxTimeMS: 5_000 }).limit(MAX_PUBLISHING_RECORDS + 1).toArray();
    if (result.length > MAX_PUBLISHING_RECORDS) throw new Error("REFERENCE_LIMIT");
    return result as Record<string, unknown>[];
  };
  return {
    async load() {
      if (Number(connection.readyState) !== 1) return unavailableReferences("MONGODB_UNAVAILABLE");
      try {
        const projects = await rows("sites_projects", {}, { _id: 1, versionNumber: 1, sourceArtifactRef: 1, "previousVersion.sourceArtifactRef": 1 });
        const jobs = await rows("sites_jobs", { status: { $in: ["QUEUED", "RUNNING"] } }, { projectId: 1 });
        for (const project of projects) {
          const previous = project.previousVersion as { sourceArtifactRef?: unknown } | undefined;
          if (typeof project._id !== "string" || !project._id || !Number.isSafeInteger(project.versionNumber) || Number(project.versionNumber) < 0 ||
            (project.sourceArtifactRef != null && (typeof project.sourceArtifactRef !== "string" || !project.sourceArtifactRef)) ||
            (previous != null && (typeof previous.sourceArtifactRef !== "string" || !previous.sourceArtifactRef))) throw new Error("REFERENCE_MALFORMED");
        }
        if (jobs.some(job => typeof job.projectId !== "string")) throw new Error("REFERENCE_MALFORMED");
        const publishing = buildPublishingReferences(await mongoPublishingReferenceReader(connection, 5_000).read());
        return storageReferenceSnapshot(projects as unknown as MongoSiteProjectRecord[], jobs as unknown as MongoSiteJobRecord[], publishing);
      } catch { return unavailableReferences("INVENTORY_REFERENCES_UNVERIFIED"); }
    },
  };
}

/** SQLite can create WAL/SHM files even on read paths. Inventory never opens or copies these stores. */
export function inventoryLegacyReferences(source: StorageReferenceSource, root: string): StorageReferenceSource {
  return {
    async load() {
      try {
        for (const { file } of LEGACY_SQLITE_STORES) {
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            const present = await lstat(join(root, `${file}${suffix}`)).then(() => true, (error: unknown) => {
              if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
              throw error;
            });
            if (present) return unavailableReferences("LEGACY_STORE_REQUIRES_READ_ONLY_VERIFICATION");
          }
        }
        return await source.load();
      } catch { return unavailableReferences("INVENTORY_REFERENCES_UNVERIFIED"); }
    },
  };
}
