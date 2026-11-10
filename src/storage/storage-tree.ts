import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Measured { readonly sizeBytes: number; readonly newestModifiedMs: number; readonly files: number; readonly hasLink: boolean; readonly partial: boolean }
/** Size/mtime of a tree without following links; a link anywhere makes the tree uncertain. */
export async function measure(path: string, budget: { files: number }): Promise<Measured> {
  let sizeBytes = 0, newest = 0, files = 0, hasLink = false, partial = false;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    const info = await lstat(current).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink()) { hasLink = true; continue; }
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) {
      for (const entry of await readdir(current).catch(() => [] as string[])) stack.push(join(current, entry));
    } else {
      if (budget.files-- <= 0) { partial = true; break; }
      sizeBytes += info.size; files++;
    }
  }
  return { sizeBytes, newestModifiedMs: newest, files, hasLink, partial };
}
