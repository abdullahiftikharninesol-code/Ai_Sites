import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unavailableReferences, type StorageReferenceSnapshot, type StorageReferenceSource } from "./storage-references.js";

/**
 * Sites recorded by the retired SQLite persistence (`sites.sqlite`,
 * `runtime.sqlite` in the data root). The application no longer reads these
 * stores, so their sites are not in Recents, but they are still a remaining
 * reference: their artifacts and workspaces must never be treated as orphaned.
 *
 * Read-only and non-mutating: the database files are copied to a private
 * temporary directory and only the copy is opened. If a store exists but cannot
 * be read, references are reported unavailable (fail closed).
 */
export const LEGACY_SQLITE_STORES = [
  { file: "sites.sqlite", queries: ["SELECT id AS site FROM site_projects", "SELECT site_id AS site FROM site_versions", "SELECT site_id AS site FROM site_jobs"] },
  { file: "runtime.sqlite", queries: ["SELECT site_id AS site FROM site_runtimes"] },
] as const;
const MAX_STORE_BYTES = 256 * 1024 * 1024;

type SqliteModule = { DatabaseSync: new (path: string) => { prepare(sql: string): { all(): unknown[] }; close(): void } };

export async function loadLegacyStoreSiteIds(dataRoot: string): Promise<{ readonly available: boolean; readonly siteIds: ReadonlySet<string>; readonly stores: number }> {
  const root = resolve(dataRoot);
  const present: (typeof LEGACY_SQLITE_STORES)[number][] = [];
  for (const store of LEGACY_SQLITE_STORES) {
    const info = await stat(join(root, store.file)).catch(() => undefined);
    if (!info) continue;
    if (!info.isFile() || info.size > MAX_STORE_BYTES) return { available: false, siteIds: new Set(), stores: present.length };
    present.push(store);
  }
  if (!present.length) return { available: true, siteIds: new Set(), stores: 0 };
  let sqlite: SqliteModule;
  try { sqlite = await import("node:sqlite"); }
  catch { return { available: false, siteIds: new Set(), stores: present.length }; }
  const copyDir = await mkdtemp(join(tmpdir(), "sites-legacy-refs-"));
  const siteIds = new Set<string>();
  try {
    for (const store of present) {
      const copy = join(copyDir, store.file);
      await copyFile(join(root, store.file), copy);
      // Committed rows may still live only in the write-ahead log.
      await copyFile(join(root, `${store.file}-wal`), `${copy}-wal`).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      const db = new sqlite.DatabaseSync(copy);
      try {
        for (const query of store.queries)
          for (const row of db.prepare(query).all() as { site?: unknown }[]) if (typeof row.site === "string" && row.site) siteIds.add(row.site);
      } finally { db.close(); }
    }
    return { available: true, siteIds, stores: present.length };
  } catch {
    return { available: false, siteIds: new Set(), stores: present.length };
  } finally {
    await rm(copyDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => undefined);
  }
}

/** Adds legacy-store sites to a reference source; any failure makes references unavailable. */
export function withLegacyStoreReferences(source: StorageReferenceSource, dataRoot: string): StorageReferenceSource {
  return {
    async load(): Promise<StorageReferenceSnapshot> {
      const [current, legacy] = await Promise.all([source.load(), loadLegacyStoreSiteIds(dataRoot)]);
      if (!current.available) return current;
      if (!legacy.available) return unavailableReferences("LEGACY_STORE_UNREADABLE");
      return { ...current, legacySiteIds: legacy.siteIds };
    },
  };
}
