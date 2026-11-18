import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { savedSourceArtifactReader } from "./saved-source-artifact-reader.js";
import { PublishingError } from "../publishing/publishing-errors.js";

const unavailable = () => new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "Publishing storage is unavailable or unsafe.");
const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const preparedKey = /^sites\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/publishing\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/attempt-[1-9][0-9]*\/artifact\.json$/;
export const MAX_PREPARED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = MAX_PREPARED_ARTIFACT_BYTES;

/** Trusted host storage; rejects known path/link escapes, not a sandbox against privileged namespace races. */
export async function preparationDirectory(root: string, segments: readonly string[], create = false): Promise<string> {
  let current = resolve(root);
  if (!same(await realpath(current), current) || !(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) throw unavailable();
  for (const part of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) || part === "." || part === "..") throw unavailable();
    current = join(current, part);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await realpath(current), current)) throw unavailable();
  }
  return current;
}
export function productionPreparationArtifacts(dataRoot: string): ArtifactStore {
  const root = resolve(dataRoot), source = savedSourceArtifactReader(root);
  const target = async (key: string, create: boolean) => {
    if (!preparedKey.test(key)) throw unavailable();
    const segments = ["artifacts", ...key.split("/")], leaf = segments.pop()!;
    await preparationDirectory(root, ["artifacts"]);
    return join(await preparationDirectory(root, segments, create), leaf);
  };
  const get: ArtifactStore["get"] = async key => {
    if (!preparedKey.test(key)) return source.read(key);
    try {
      const path = await target(key, false), before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_ARTIFACT_BYTES) throw unavailable();
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await file.stat();
        if (info.dev !== before.dev || info.ino !== before.ino || info.size > MAX_ARTIFACT_BYTES) throw unavailable();
        const chunks: Buffer[] = [], buffer = Buffer.alloc(64 * 1024); let size = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          if ((size += bytesRead) > MAX_ARTIFACT_BYTES) throw unavailable();
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const data = Buffer.concat(chunks);
        const after = await file.stat(), pathAfter = await lstat(path);
        if (data.length > MAX_ARTIFACT_BYTES || data.length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || pathAfter.ino !== before.ino || pathAfter.dev !== before.dev) throw unavailable();
        await target(key, false); return new Uint8Array(data);
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw unavailable(); }
  };
  return { get, exists: async key => (await get(key)) !== undefined,
    delete: () => Promise.reject(unavailable()),
    put: async (key, data, options) => {
      if (data.byteLength > MAX_ARTIFACT_BYTES) throw unavailable();
      const path = await target(key, true);
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      return { key, kind: options.kind, contentType: options.contentType, sizeBytes: data.byteLength, createdAt: new Date(), sha256: createHash("sha256").update(data).digest("hex"), storageProvider: "local", storageKey: key };
    },
  };
}
