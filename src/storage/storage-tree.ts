import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Measured { readonly sizeBytes: number; readonly newestModifiedMs: number; readonly files: number; readonly hasLink: boolean; readonly partial: boolean }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Size/mtime of a tree without following links; a link anywhere makes the tree uncertain.
 * Anything that exists but cannot be inspected makes it `partial` (never measured as empty).
 */
export async function measure(path: string, budget: { files: number }): Promise<Measured> {
  let sizeBytes = 0, newest = 0, files = 0, hasLink = false, partial = false;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    const info = await lstat(current).catch((error: unknown) => { if (!missing(error)) partial = true; return undefined; });
    if (!info) continue;
    if (info.isSymbolicLink()) { hasLink = true; continue; }
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) {
      const entries = await readdir(current).catch((error: unknown) => { if (!missing(error)) partial = true; return [] as string[]; });
      for (const entry of entries) stack.push(join(current, entry));
    } else {
      if (budget.files-- <= 0) { partial = true; break; }
      sizeBytes += info.size; files++;
    }
  }
  return { sizeBytes, newestModifiedMs: newest, files, hasLink, partial };
}
