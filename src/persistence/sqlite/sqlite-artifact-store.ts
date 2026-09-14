import type { ArtifactMetadata, ArtifactStore } from "../artifact-store.js";
import type { SqliteDatabase } from "./sqlite-database.js";
export interface PersistenceTelemetry {
  databaseReads: number;
  databaseWrites: number;
  artifactReads: number;
  artifactWrites: number;
  artifactBytesWritten: number;
}
export class SqliteCatalogedArtifactStore implements ArtifactStore {
  readonly telemetry: PersistenceTelemetry = {
    databaseReads: 0,
    databaseWrites: 0,
    artifactReads: 0,
    artifactWrites: 0,
    artifactBytesWritten: 0,
  };
  constructor(
    private readonly delegate: ArtifactStore,
    private readonly db: SqliteDatabase,
  ) {}
  async put(
    key: string,
    data: Uint8Array,
    options: { readonly kind: ArtifactMetadata["kind"]; readonly contentType: string },
  ): Promise<ArtifactMetadata> {
    const metadata = await this.delegate.put(key, data, options);
    const parsed = parseKey(key);
    this.db.connection
      .prepare(
        "INSERT OR REPLACE INTO artifact_records (storage_key,kind,content_type,size_bytes,sha256,site_id,version_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        key,
        options.kind,
        options.contentType,
        metadata.sizeBytes,
        metadata.sha256 ?? "",
        parsed.siteId,
        parsed.versionId,
        metadata.createdAt.toISOString(),
      );
    this.telemetry.artifactWrites++;
    this.telemetry.artifactBytesWritten += data.byteLength;
    this.telemetry.databaseWrites++;
    return { ...metadata, ...parsed };
  }
  async get(key: string) {
    this.telemetry.artifactReads++;
    return this.delegate.get(key);
  }
  async delete(key: string) {
    await this.delegate.delete(key);
    this.db.connection.prepare("DELETE FROM artifact_records WHERE storage_key = ?").run(key);
    this.telemetry.databaseWrites++;
  }
  async exists(key: string) {
    this.telemetry.artifactReads++;
    return this.delegate.exists(key);
  }
  storageBytesForSite(siteId: string): number {
    this.telemetry.databaseReads++;
    return Number(
      (
        this.db.connection
          .prepare(
            "SELECT COALESCE(SUM(size_bytes),0) value FROM artifact_records WHERE site_id = ?",
          )
          .get(siteId) as { value: number }
      ).value,
    );
  }
  listForVersion(siteId: string, versionId: string): readonly ArtifactMetadata[] {
    this.telemetry.databaseReads++;
    return (
      this.db.connection
        .prepare(
          "SELECT * FROM artifact_records WHERE site_id = ? AND version_id = ? ORDER BY storage_key",
        )
        .all(siteId, versionId) as Array<Record<string, unknown>>
    ).map((row) => ({
      key: String(row.storage_key),
      kind: String(row.kind) as ArtifactMetadata["kind"],
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      storageProvider: "local",
      storageKey: String(row.storage_key),
      siteId,
      versionId,
      createdAt: new Date(String(row.created_at)),
    }));
  }
}
function parseKey(key: string): { siteId?: string; versionId?: string } {
  const match = /^sites\/([^/]+)\/versions\/([^/]+)\//.exec(key);
  if (match) return { siteId: match[1]!, versionId: match[2]! };
  const deployment = /^sites\/([^/]+)\/deployments\/[^/]+\//.exec(key);
  return deployment ? { siteId: deployment[1]! } : {};
}
