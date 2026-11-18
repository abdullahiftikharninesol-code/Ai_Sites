import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SAVED_SOURCE_LIMITS = Object.freeze({ files: 1_000, fileBytes: 2 * 1024 * 1024,
  totalFileBytes: 8 * 1024 * 1024, snapshotBytes: 16 * 1024 * 1024, responseBytes: 4 * 1024 * 1024, pathBytes: 512 });
export const sourceUnavailable = () => Object.assign(new Error("Saved source is unavailable"), { code: "SOURCE_UNAVAILABLE" });
export const sourceTooLarge = () => Object.assign(new Error("Saved source exceeds read limits"), { code: "SOURCE_TOO_LARGE" });
export interface SavedSourceArtifactReader { read(ref: string): Promise<Uint8Array | undefined> }
const identity = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}`;
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Application read syscalls only. No mkdir, migration, link following or artifact-store initialization. */
export function savedSourceArtifactReader(dataRoot: string): SavedSourceArtifactReader {
  const root = resolve(dataRoot);
  return { async read(ref) {
    // Only server-bound source namespace keys; never an arbitrary filename or URL.
    if (!/^sites\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/(?:current\/source\.json|versions\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/source\/source\.json)$/.test(ref)) throw sourceUnavailable();
    const paths = [root];
    for (const part of ["artifacts", ...ref.split("/")]) paths.push(join(paths.at(-1)!, part));
    const target = paths.at(-1)!;
    const inspect = async () => {
      if (!samePath(await realpath(root), root)) throw sourceUnavailable();
      const identities: string[] = [];
      for (const [index, path] of paths.entries()) {
        const info = await lstat(path);
        if (info.isSymbolicLink() || (index < paths.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw sourceUnavailable();
        identities.push(identity(info));
        if (!samePath(await realpath(path), path)) throw sourceUnavailable();
      }
      return identities;
    };
    try {
      const before = await inspect();
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || identity(stat) !== before.at(-1)) throw sourceUnavailable();
        if (stat.size > SAVED_SOURCE_LIMITS.snapshotBytes) throw sourceTooLarge();
        const chunks: Buffer[] = [], buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          if ((size += bytesRead) > SAVED_SOURCE_LIMITS.snapshotBytes) throw sourceTooLarge();
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const after = await file.stat();
        if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
          identity(after) !== identity(stat) || JSON.stringify(await inspect()) !== JSON.stringify(before)) throw sourceUnavailable();
        return Buffer.concat(chunks);
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      if ((error as { code?: unknown })?.code === "SOURCE_TOO_LARGE") throw error;
      throw sourceUnavailable();
    }
  } };
}
