import { posix } from "node:path";
import type { Connection } from "mongoose";
import type { MongoSiteProjectRecord } from "../persistence/mongodb/mongo-models.js";
import { SiteSourceSnapshotService, type SiteSourceSnapshot, type SiteSourceManifestFile } from "../sites/generation/source-snapshot.js";
import { validSiteId } from "./production-website-reads.js";
import type { ProductionRoute } from "./production-http-routes.js";
import { SAVED_SOURCE_LIMITS as LIMIT, sourceTooLarge, sourceUnavailable, type SavedSourceArtifactReader } from "./saved-source-artifact-reader.js";

export type SavedSourceBinding = Pick<MongoSiteProjectRecord, "_id" | "ownerId" | "versionNumber" | "sourceArtifactRef">;
export interface SavedSourceRepository { getOwnedById(siteId: string, ownerId: string): Promise<SavedSourceBinding | undefined> }
export function mongoSavedSourceRepository(connection: Pick<Connection, "db">): SavedSourceRepository {
  return { async getOwnedById(siteId, ownerId) {
    if (!connection.db) throw sourceUnavailable();
    return await connection.db.collection<MongoSiteProjectRecord>("sites_projects").findOne({ _id: siteId, ownerId },
      { projection: { _id: 1, ownerId: 1, versionNumber: 1, sourceArtifactRef: 1 }, maxTimeMS: 5_000 }) ?? undefined;
  } };
}
const fail = (code: string) => Object.assign(new Error("Saved source request failed"), { code });
function normalizedPath(path: string): boolean {
  return !!path && Buffer.byteLength(path) <= LIMIT.pathBytes && posix.normalize(path) === path && !path.startsWith("/") &&
    !/[\\:%]/.test(path) && ![...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    path.split("/").every(part => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function allowedPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.some(part => part.startsWith(".") || /^(?:node_modules|dist|secrets?|credentials?|passwords?|tokens?|api[-_]?keys?|private[-_]?key|access[-_]?token|refresh[-_]?token|service[-_]?account(?:key)?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:[._-]|$)/i.test(part))) return false;
  if (/\.(?:pem|key|p8|ppk|p12|pfx|crt|cer|der|jks|keystore)$/i.test(path)) return false;
  if (["package.json", "package-lock.json", "index.html", "vite.config.ts"].includes(path) || /^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/.test(path)) return true;
  return /^(?:src|public)\/.+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|sass|less|html|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|txt|xml|webmanifest)$/i.test(path);
}

/** Structural/resource gates precede the existing manifest size/hash verifier, which performs no writes. */
async function verifiedSnapshot(bytes: Uint8Array, ref: string): Promise<SiteSourceSnapshot> {
  if (bytes.byteLength > LIMIT.snapshotBytes) throw sourceTooLarge();
  try {
    const raw = Buffer.from(bytes), text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) throw sourceUnavailable();
    const snapshot = JSON.parse(text) as SiteSourceSnapshot;
    if (![1, 2].includes(snapshot?.manifest?.schemaVersion) || !Array.isArray(snapshot.manifest.files) ||
      !snapshot.files || typeof snapshot.files !== "object" || Array.isArray(snapshot.files)) throw sourceUnavailable();
    if (snapshot.manifest.files.length > LIMIT.files || Object.keys(snapshot.files).length > LIMIT.files) throw sourceTooLarge();
    const paths = new Set<string>();
    let total = 0;
    for (const file of snapshot.manifest.files as readonly SiteSourceManifestFile[]) {
      if (!file || typeof file.path !== "string" || !normalizedPath(file.path) || paths.has(file.path.toLowerCase()) ||
        !Object.hasOwn(snapshot.files, file.path) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
        typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        (file.encoding !== undefined && file.encoding !== "base64")) throw sourceUnavailable();
      paths.add(file.path.toLowerCase());
      const content = snapshot.files[file.path];
      if (typeof content !== "string") throw sourceUnavailable();
      if (file.sizeBytes > LIMIT.fileBytes || (file.encoding === "base64" ? content.length > Math.ceil(LIMIT.fileBytes / 3) * 4 : Buffer.byteLength(content) > LIMIT.fileBytes)) throw sourceTooLarge();
      if ((total += file.sizeBytes) > LIMIT.totalFileBytes) throw sourceTooLarge();
      if (file.encoding === "base64" && Buffer.from(content, "base64").toString("base64") !== content) throw sourceUnavailable();
    }
    if (Object.keys(snapshot.files).length !== paths.size) throw sourceUnavailable();
    const denied = () => Promise.reject(new Error("Read-only source verifier"));
    return await new SiteSourceSnapshotService({ get: () => Promise.resolve(bytes), put: denied, delete: denied, exists: () => Promise.resolve(true) }).verify(ref);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "SOURCE_TOO_LARGE") throw error;
    throw sourceUnavailable();
  }
}

export function productionSavedSourceRoute(repository: SavedSourceRepository, artifacts: SavedSourceArtifactReader): ProductionRoute {
  return { access: "authenticated", method: "GET", path: "/api/dev/sites/:siteId/versions/:versionId/files",
    handle: async ({ ownerId, params, url, response }) => {
      const siteId = params.siteId!, versionId = params.versionId!;
      if (!validSiteId(siteId)) throw fail("SITE_NOT_FOUND");
      const binding = async () => {
        const row = await repository.getOwnedById(siteId, ownerId);
        if (!row || row._id !== siteId || row.ownerId !== ownerId) throw fail("SITE_NOT_FOUND");
        if (!Number.isSafeInteger(row.versionNumber) || row.versionNumber < 1 || versionId !== `${siteId}:v${row.versionNumber}`) throw fail("VERSION_NOT_FOUND");
        const ref = row.sourceArtifactRef ?? `sites/${siteId}/current/source.json`;
        const parts = typeof ref === "string" ? ref.split("/") : [];
        if (!(parts[0] === "sites" && parts[1] === siteId &&
          ((parts.length === 4 && parts[2] === "current" && parts[3] === "source.json") ||
            (parts.length === 6 && parts[2] === "versions" && validSiteId(parts[3]!) && parts[4] === "source" && parts[5] === "source.json")))) throw sourceUnavailable();
        return ref;
      };
      const ref = await binding(), requested = url.searchParams.getAll("path");
      if (requested.length > 1 || (requested.length === 1 && !normalizedPath(requested[0]!))) throw fail("INVALID_REQUEST");
      const path = requested[0];
      if (path !== undefined && !allowedPath(path)) throw fail("SOURCE_FILE_NOT_FOUND");
      const bytes = await artifacts.read(ref);
      if (!bytes) throw fail("SOURCE_NOT_FOUND");
      const snapshot = await verifiedSnapshot(bytes, ref);
      if (await binding() !== ref) throw fail("VERSION_NOT_FOUND");
      const files = snapshot.manifest.files.filter(file => allowedPath(file.path));
      const file = path === undefined ? undefined : files.find(file => file.path === path);
      if (path !== undefined && !file) throw fail("SOURCE_FILE_NOT_FOUND");
      const metadata = (entry: typeof files[number]) => ({ path: entry.path, sizeBytes: entry.sizeBytes, ...(entry.encoding ? { encoding: entry.encoding } : {}) });
      const result = file ? { siteId, versionId, ...metadata(file), content: snapshot.files[file.path] }
        : { siteId, versionId, files: files.map(metadata) };
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > LIMIT.responseBytes) throw sourceTooLarge();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(serialized);
    },
  };
}
