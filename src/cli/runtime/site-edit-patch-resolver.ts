import { createHash } from "node:crypto";
import ts from "typescript";
import postcss from "postcss";
import type { SiteEditPatch, SiteEditPatchMode } from "./site-coder-file-bundle.js";

export interface SiteEditPatchContext {
  readonly instruction: string;
  /** Only files actually supplied as relevant source, not the entire workspace. */
  readonly relevantPaths: readonly string[];
  readonly rename?: { readonly oldLiteral: string; readonly newLiteral: string } | undefined;
}
export interface PatchLocation { readonly offset: number; readonly line: number; readonly column: number }
export interface SiteEditPatchDiagnostic {
  readonly path: string;
  readonly findDigest: string;
  readonly replacementDigest: string;
  readonly matchCount: number;
  readonly locations: readonly PatchLocation[];
  readonly requestedMode: SiteEditPatchMode;
  readonly resolution: string;
  readonly intendedOperation: string;
  readonly rebased: boolean;
  readonly reason: string;
}
export const editTextDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
export function exactMatchOffsets(source: string, find: string): number[] {
  if (!find) return [];
  const result: number[] = [];
  for (let offset = source.indexOf(find); offset >= 0; offset = source.indexOf(find, offset + find.length)) result.push(offset);
  return result;
}
export function patchLocations(source: string, offsets: readonly number[]): PatchLocation[] {
  return offsets.slice(0, 64).map(offset => {
    const before = source.slice(0, offset);
    return { offset, line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
  });
}
function literal(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&(?:apos|#39);/g, "'").replace(/&quot;/g, '"');
}
const globalScope = /\b(?:globally|everywhere|throughout (?:the )?(?:website|site|project)|across (?:the )?(?:(?:whole|entire) )?(?:website|site|project))\b/i;
function clauses(instruction: string): string[] { return instruction.split(/[;\n]+|(?<=[.!?])\s+/); }
export function explicitlyAuthorizedGlobalRename(patch: SiteEditPatch, context?: SiteEditPatchContext): boolean {
  const rename = context?.rename;
  if (!context || !rename || !context.relevantPaths.includes(patch.path) ||
    literal(patch.find).toLowerCase() !== rename.oldLiteral.toLowerCase() ||
    literal(patch.replace).toLowerCase() !== rename.newLiteral.toLowerCase()) return false;
  // Constraints elsewhere in a multi-sentence request still limit a rename.
  if (/\b(?:except|excluding|apart from|but not)\b/i.test(context.instruction) ||
    clauses(context.instruction).some(clause => /\b(?:not|never|keep|leave|retain|preserve|only)\b/i.test(clause) &&
      (/\b(?:brand(?:ing)?|company name)\b/i.test(clause) || literal(clause).toLowerCase().includes(rename.oldLiteral.toLowerCase())))) return false;
  return clauses(context.instruction).some(clause => /\b(?:rename|replace|change)\b/i.test(clause) && globalScope.test(clause) &&
    !/\b(?:not|never|only|except)\b/i.test(clause) &&
    literal(clause).toLowerCase().includes(rename.oldLiteral.toLowerCase()) &&
    literal(clause).toLowerCase().includes(rename.newLiteral.toLowerCase()));
}

interface LocalIntent { readonly clause: string; readonly kind: "LOCAL_HEADING" | "LOCAL_DESCRIPTION" | "CSS_DECLARATION" }
function localIntent(patch: SiteEditPatch, context?: SiteEditPatchContext): LocalIntent | undefined {
  if (!context?.relevantPaths.includes(patch.path)) return;
  const replacement = literal(patch.replace).trim();
  if (!replacement) return;
  const candidates = clauses(context.instruction).filter(clause =>
    /\b(?:change|update|rewrite|rename|replace|set)\b/i.test(clause) &&
    !/\b(?:not|never|except|everywhere|globally)\b/i.test(clause) &&
    // Recovery requires the requested new value, not unrelated keywords in a long brief.
    ([...clause.matchAll(/["“']([^"”']+)["”']/g)].some(match => literal(match[1]!) === replacement) ||
      /^#[\da-f]{3,8}$/i.test(replacement) && clause.toLowerCase().includes(replacement.toLowerCase())));
  if (candidates.length !== 1) return;
  const clause = candidates[0]!;
  if (patch.path.endsWith(".css")) return { clause, kind: "CSS_DECLARATION" };
  if (/\b(?:heading|headline|title)\b/i.test(clause)) return { clause, kind: "LOCAL_HEADING" };
  if (/\b(?:description|copy|paragraph)\b/i.test(clause)) return { clause, kind: "LOCAL_DESCRIPTION" };
  return;
}

export function patchIntendedOperation(patch: SiteEditPatch, context?: SiteEditPatchContext): string {
  return explicitlyAuthorizedGlobalRename(patch, context) ? "GLOBAL_RENAME" : localIntent(patch, context)?.kind ?? "EXACT_PATCH";
}

function attributes(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  return attrs.properties.flatMap(attr => ts.isJsxAttribute(attr) &&
    ["className", "id"].includes(attr.name.getText()) && attr.initializer && ts.isStringLiteral(attr.initializer)
    ? [attr.initializer.text] : []).join(" ");
}
function jsxTargetMatches(file: ts.SourceFile, start: number, end: number, intent: LocalIntent): boolean {
  let leaf: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.pos > start || node.end < end) return;
    if (ts.isJsxText(node) || ts.isStringLiteral(node) && ts.isJsxExpression(node.parent)) leaf = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Bare values must be actual JSX copy, never an attribute, code, comment or data label.
  if (!leaf) return false;
  const ancestors: ts.Node[] = [];
  for (let current: ts.Node | undefined = leaf; current; current = current.parent) ancestors.push(current);
  const elements = ancestors.filter((node): node is ts.JsxElement => ts.isJsxElement(node));
  const tags = elements.map(node => node.openingElement.tagName.getText(file));
  if (!tags.some(tag => intent.kind === "LOCAL_HEADING" ? /^h[1-6]$/.test(tag) : tag === "p")) return false;
  const component = ancestors.find(node => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  const componentName = component && ts.isFunctionDeclaration(component) ? component.name?.text ?? ""
    : component?.parent && ts.isVariableDeclaration(component.parent) ? component.parent.name.getText(file) : "";
  const scopes: boolean[] = [];
  const hasElementScope = (scope: string) => elements.some(node => attributes(node).split(/[\s_-]+/).includes(scope));
  const clause = intent.clause;
  if (/\bhome(?:page)?\b/i.test(clause)) scopes.push(/^Home(?:Page)?$/i.test(componentName) ||
    (!componentName || componentName === "App") && /(?:^|\/)Home(?:Page)?\.[jt]sx?$/i.test(file.fileName));
  for (const scope of ["hero", "featured", "footer", "header"]) {
    if (new RegExp(`\\b${scope}\\b`, "i").test(clause)) scopes.push(hasElementScope(scope) || tags.includes(scope) || componentName.toLowerCase() === scope);
  }
  const explicit = /\b(?:in|inside)\s+(?:the\s+)?["']?([A-Z][A-Za-z0-9_]*)["']?\s+component\b/.exec(clause);
  if (explicit) scopes.push(componentName === explicit[1]);
  return scopes.length > 0 && scopes.every(Boolean);
}

function cssTargetOffsets(source: string, offsets: readonly number[], patch: SiteEditPatch, intent: LocalIntent): number[] {
  const matches: number[] = [];
  try {
    const root = postcss.parse(source);
    root.walkDecls(declaration => {
      const start = declaration.source?.start?.offset, end = declaration.source?.end?.offset;
      const parent = declaration.parent;
      if (start === undefined || end === undefined || parent?.type !== "rule") return;
      // Require both the exact selector and property in the user's clause.
      // A color name alone cannot authorize rewriting every identical CSS value.
      const selector = parent.selector;
      const hasLiteral = (text: string) => intent.clause.includes(text) &&
        new RegExp(`(?:^|[\\s"'\\x60])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"'\\x60,:])`).test(intent.clause);
      if (!hasLiteral(selector) || !hasLiteral(declaration.prop)) return;
      for (const offset of offsets) if (offset >= start && offset + patch.find.length <= end + 1) matches.push(offset);
    });
  } catch { return []; }
  return [...new Set(matches)];
}

/** Never scores candidates or picks the first: every explicit constraint must leave exactly one. */
export function uniqueContextualOffset(source: string, offsets: readonly number[], patch: SiteEditPatch, context?: SiteEditPatchContext): { readonly offset: number; readonly operation: string } | undefined {
  const intent = localIntent(patch, context);
  if (!intent) return;
  const matching = intent.kind === "CSS_DECLARATION" ? cssTargetOffsets(source, offsets, patch, intent)
    : (() => {
      const file = ts.createSourceFile(patch.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      return offsets.filter(offset => jsxTargetMatches(file, offset, offset + patch.find.length, intent));
    })();
  return matching.length === 1 ? { offset: matching[0]!, operation: intent.kind } : undefined;
}
