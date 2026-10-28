import ts from "typescript";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { BuildRepairPatchBundle } from "./site-coder-file-bundle.js";
import { exactMatchOffsets, patchLocations, type PatchLocation } from "./site-edit-patch-resolver.js";
import { createBuildRepairSourceSnapshot, repairDigest, repairSourceRevision, type BuildRepairSourceSnapshot } from "./build-repair-source.js";

export interface BuildRepairPatchDiagnostic {
  readonly path: string;
  readonly findDigest: string;
  readonly sourceDigest: string;
  readonly currentSourceDigest: string;
  readonly matchCount: number;
  readonly locations: readonly PatchLocation[];
  readonly resolution: string;
}
export interface BuildRepairEvidence {
  readonly attempt: number;
  readonly kind: "build" | "navigation" | "interaction" | "functional";
  readonly sourceRevision: string;
  readonly contextDigest: string;
  readonly currentSourceRevision?: string;
  readonly initialDiagnostics: string;
  readonly billingState: "NOT_FINALIZED";
  readonly result: string;
  readonly patches: readonly BuildRepairPatchDiagnostic[];
}

interface IndexedText { readonly text: string; readonly starts: readonly number[]; readonly ends: readonly number[]; readonly removed: readonly number[] }
function indexed(text: string, indentation: boolean): IndexedText {
  let result = "";
  const starts: number[] = [], ends: number[] = [], removed: number[] = [];
  let afterNewline = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (indentation && afterNewline && /[\t ]/.test(char)) { removed.push(index); continue; }
    const crlf = char === "\r" && text[index + 1] === "\n";
    result += crlf ? "\n" : char; starts.push(index); ends.push(index + (crlf ? 2 : 1));
    if (crlf) index++;
    afterNewline = char === "\n" || crlf;
  }
  return { text: result, starts, ends, removed };
}

/** Indentation may differ only outside literals, JSX text, regexes and comments.
 * Newlines are preserved, so automatic semicolon insertion cannot change.
 * Broken/incomplete syntax cannot establish this equivalence: use exact/EOL matching.
 */
function safeIndentation(path: string, source: string, normalized: IndexedText, start = 0, end = source.length): boolean {
  if (!/\.[jt]sx?$/.test(path)) return false;
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
  const protectedRanges: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node) || ts.isRegularExpressionLiteral(node))
      protectedRanges.push({ start: ts.isJsxText(node) ? node.pos : node.getStart(ast), end: node.end });
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      protectedRanges.push({ start: scanner.getTokenPos(), end: scanner.getTextPos() });
  return !normalized.removed.some(offset => offset >= start && offset < end && protectedRanges.some(range => offset >= range.start && offset < range.end));
}

interface Match { readonly start: number; readonly end: number }
function matches(path: string, source: string, find: string): { matches: Match[]; resolution: string } {
  const exact = exactMatchOffsets(source, find);
  if (exact.length) return { matches: exact.map(start => ({ start, end: start + find.length })), resolution: "EXACT_UNIQUE" };
  for (const indentation of [false, true]) {
    const actual = indexed(source, indentation), requested = indexed(find, indentation);
    if (!requested.text || indentation && !safeIndentation(path, find, requested)) continue;
    const candidates = exactMatchOffsets(actual.text, requested.text).map(offset => ({ start: actual.starts[offset]!, end: actual.ends[offset + requested.text.length - 1]! }));
    const verified = indentation ? candidates.filter(range => safeIndentation(path, source, actual, range.start, range.end)) : candidates;
    // Do not narrow multiple textual candidates by semantic heuristics.
    if (candidates.length) return { matches: verified.length === candidates.length ? verified : [],
      resolution: verified.length !== candidates.length ? "UNSAFE_FORMATTING" : indentation ? "SAFE_INDENTATION" : "LINE_ENDINGS" };
  }
  return { matches: [], resolution: "MISSING_FIND_TEXT" };
}

/** Preflight every operation against one source revision before any write.
 * Independent ranges may be applied in reverse offset order; overlapping and
 * cascading operations are rejected, never silently rebased or reordered.
 */
export async function applyValidatedBuildRepairPatches(
  execution: Pick<ExecutionProvider, "readFile" | "writeFile">,
  environmentId: string,
  bundle: BuildRepairPatchBundle,
  suppliedSnapshot?: BuildRepairSourceSnapshot,
  onDiagnostics?: (diagnostics: readonly BuildRepairPatchDiagnostic[]) => void,
): Promise<void> {
  const diagnostics: BuildRepairPatchDiagnostic[] = [];
  const current: { path: string; content: string }[] = [];
  const reject = (message: string, reason: string, path?: string): never => {
    onDiagnostics?.(diagnostics);
    throw new ApplicationError("VALIDATION_FAILED", message, { metadata: {
      failureStage: "PATCH_APPLICATION", validationCheck: "build-repair.patch", reason,
      path, sourceRevision: snapshot.revision, currentSourceRevision: current.length === snapshot.files.length ? repairSourceRevision(current) : undefined, patchDiagnostics: diagnostics,
    } });
  };
  const snapshot = suppliedSnapshot ?? createBuildRepairSourceSnapshot(await Promise.all([...new Set(bundle.patches.map(patch => patch.path))].map(async path => ({ path, content: await execution.readFile(environmentId, path) }))), "", Number.MAX_SAFE_INTEGER);
  for (const file of snapshot.files) {
    let content: string;
    try { content = await execution.readFile(environmentId, file.path); }
    catch { reject(`Build repair source file is no longer available: ${file.path}`, "SOURCE_REVISION_CHANGED", file.path); }
    current.push({ path: file.path, content: content! });
  }
  const currentRevision = repairSourceRevision(current);
  if (currentRevision !== snapshot.revision) {
    for (const patch of bundle.patches) {
      const file = snapshot.files.find(file => file.path === patch.path), actual = current.find(file => file.path === patch.path);
      if (file && actual) diagnostics.push({ path: patch.path, findDigest: repairDigest(patch.find), sourceDigest: file.digest,
        currentSourceDigest: repairDigest(actual.content), matchCount: 0, locations: [], resolution: "SOURCE_REVISION_CHANGED" });
    }
    reject("Build repair source revision changed after context capture; no patch was applied", "SOURCE_REVISION_CHANGED");
  }
  const planned = new Map<string, { start: number; end: number; replace: string }[]>();
  for (const patch of bundle.patches) {
    const file = snapshot.files.find(file => file.path === patch.path);
    if (!file) reject(`Build repair path was not supplied in the source snapshot: ${patch.path}`, "PATH_NOT_SUPPLIED", patch.path);
    const result = matches(patch.path, file!.content, patch.find);
    const diagnostic: BuildRepairPatchDiagnostic = { path: patch.path, findDigest: repairDigest(patch.find), sourceDigest: file!.digest,
      currentSourceDigest: repairDigest(current.find(file => file.path === patch.path)!.content), matchCount: result.matches.length,
      locations: patchLocations(file!.content, result.matches.map(range => range.start)), resolution: result.matches.length > 1 ? "AMBIGUOUS_FIND_TEXT" : result.resolution };
    diagnostics.push(diagnostic);
    if (result.matches.length !== 1) reject(`Build repair find text ${result.matches.length ? `matched ${result.matches.length} times` : "was not found"} in ${patch.path}; supply a unique verbatim source anchor`, diagnostic.resolution, patch.path);
    const match = result.matches[0]!;
    if (!file!.excerpts.some(range => match.start >= range.start && match.end <= range.end)) reject(`Build repair anchor is outside supplied source excerpts: ${patch.path}`, "ANCHOR_NOT_SUPPLIED", patch.path);
    const earlier = planned.get(patch.path) ?? [];
    if (earlier.some(range => range.start < match.end && range.end > match.start)) reject(`Build repair patches overlap in ${patch.path}; combine them into one snapshot-based operation`, "OVERLAPPING_OPERATIONS", patch.path);
    earlier.push({ ...match, replace: patch.replace }); planned.set(patch.path, earlier);
  }
  const staged = new Map<string, string>();
  for (const [path, patches] of planned) {
    let content = snapshot.files.find(file => file.path === path)!.content;
    for (const patch of [...patches].sort((a, b) => b.start - a.start)) content = content.slice(0, patch.start) + patch.replace + content.slice(patch.end);
    staged.set(path, content);
  }
  // Catch asynchronous changes during matching/preflight as well as provider time.
  for (const file of snapshot.files) {
    const content = await execution.readFile(environmentId, file.path);
    if (repairDigest(content) !== file.digest) {
      current.find(item => item.path === file.path)!.content = content;
      for (let index = 0; index < diagnostics.length; index++) if (diagnostics[index]!.path === file.path)
        diagnostics[index] = { ...diagnostics[index]!, currentSourceDigest: repairDigest(content), resolution: "SOURCE_REVISION_CHANGED" };
      reject("Build repair source revision changed during preflight; no patch was applied", "SOURCE_REVISION_CHANGED", file.path);
    }
  }
  onDiagnostics?.(diagnostics);
  const written: string[] = [];
  try {
    for (const [path, content] of staged) { written.push(path); await execution.writeFile(environmentId, path, content); }
  } catch (cause) {
    // The workspace is uncommitted. Restore writes made by this bundle, without
    // overwriting a concurrent external change if a provider lost ownership.
    for (const path of written.reverse()) {
      const content = await execution.readFile(environmentId, path).catch(() => undefined);
      if (content === staged.get(path)) await execution.writeFile(environmentId, path, snapshot.files.find(file => file.path === path)!.content);
    }
    throw cause;
  }
}
