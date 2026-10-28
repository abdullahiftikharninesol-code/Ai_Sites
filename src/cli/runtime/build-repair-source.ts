import { createHash } from "node:crypto";

export interface RepairSourceFile {
  readonly path: string;
  readonly content: string;
  readonly digest: string;
  readonly excerpts: readonly { readonly start: number; readonly end: number }[];
}
export interface BuildRepairSourceSnapshot {
  readonly revision: string;
  readonly contextDigest: string;
  readonly context: string;
  readonly files: readonly RepairSourceFile[];
}
export const repairDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function repairSourceRevision(files: readonly { readonly path: string; readonly content: string }[]): string {
  return repairDigest(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => [file.path, repairDigest(file.content)])));
}

/** Only complete, verbatim lines are patchable. Labels never prefix source lines. */
export function createBuildRepairSourceSnapshot(
  input: readonly { readonly path: string; readonly content: string }[],
  diagnostics: string,
  maxBytes = 16_000,
): BuildRepairSourceSnapshot {
  const normalized = diagnostics.replaceAll("\\", "/");
  const mentioned = [...new Set(normalized.match(/src\/[\w./-]+\.(?:tsx?|jsx?|css|json)/g) ?? [])];
  const priorities = [...mentioned, ...input.filter(file => /(?:^|\/)App\.[jt]sx?$/.test(file.path)).map(file => file.path), ...input.map(file => file.path)];
  const selected = [...new Set(priorities)].filter(path => input.some(file => file.path === path)).slice(0, 5);
  let used = 0;
  const chunks: string[] = [];
  const files = input.map(file => ({ ...file, digest: repairDigest(file.content), excerpts: [] as { start: number; end: number }[] }));
  for (const path of selected) {
    const file = files.find(file => file.path === path)!;
    const lines = [...file.content.matchAll(/[^\n]*\n|[^\n]+$/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const targets = [...new Set([...normalized.matchAll(new RegExp(`${escaped}[:(](\\d+)`, "g"))].map(match => Number(match[1])))].filter(line => line > 0 && line <= lines.length);
    const header = (first: number, last: number) => `--- ${path} (sha256=${file.digest}; verbatim lines ${first}-${last})\n`;
    const add = (first: number, last: number): boolean => {
      const range = { start: lines[first - 1]!.start, end: lines[last - 1]!.end };
      const chunk = header(first, last) + file.content.slice(range.start, range.end);
      const size = Buffer.byteLength(chunk) + 2;
      if (used + size > maxBytes) return false;
      used += size; file.excerpts.push(range); chunks.push(chunk); return true;
    };
    if (!lines.length) continue;
    if (add(1, lines.length)) continue;
    // Prioritize every distinct diagnostic line, rather than the first four
    // findings (which can all name the same long generated JSX line).
    const desired = new Set<number>();
    for (const target of targets.length ? targets : [1]) {
      for (let radius = 0; radius <= 6; radius++) for (const line of radius ? [target - radius, target + radius] : [target]) {
        if (line > 0 && line <= lines.length) desired.add(line);
      }
    }
    const included = new Set<number>();
    // Reserve labels too; do not slice a long line or a UTF-8 sequence to fit.
    let reserved = 0;
    for (const line of desired) {
      const bytes = Buffer.byteLength(file.content.slice(lines[line - 1]!.start, lines[line - 1]!.end)) + Buffer.byteLength(header(line, line)) + 2;
      if (used + reserved + bytes <= maxBytes) { included.add(line); reserved += bytes; }
    }
    const sorted = [...included].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length;) {
      const first = sorted[index]!;
      let last = first;
      while (sorted[index + 1] === last + 1) { index++; last++; }
      add(first, last); index++;
    }
  }
  const context = chunks.join("\n\n");
  return Object.freeze({ revision: repairSourceRevision(input), contextDigest: repairDigest(context), context,
    files: Object.freeze(files.map(file => Object.freeze({ ...file, excerpts: Object.freeze(file.excerpts.map(range => Object.freeze(range))) }))) });
}
