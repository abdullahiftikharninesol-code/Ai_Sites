import ts from "typescript";
import postcss from "postcss";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteEditPatch } from "./site-coder-file-bundle.js";
import { editTextDigest, exactMatchOffsets } from "./site-edit-patch-resolver.js";

type ProtectedKind = "email" | "phone" | "url" | "domain";
interface ProtectedValue { readonly kind: ProtectedKind; readonly value: string; readonly start: number; readonly end: number }
interface CopyTarget { readonly target: string; readonly value: string; readonly kind: "heading" | "description" }
export interface DeterministicEditScope {
  readonly rename?: { readonly oldLiteral: string; readonly newLiteral: string };
  readonly brand: boolean;
  readonly content: boolean;
  readonly styling: boolean;
  readonly navigation: boolean;
  readonly contact: boolean;
  readonly functional: boolean;
  readonly instruction: string;
  readonly contactClauses: readonly string[];
  readonly requestedContacts: readonly string[];
  readonly copyTargets: readonly CopyTarget[];
  readonly colors: readonly string[];
  /** An opaque request must never be declared complete just to drop an operation. */
  readonly canProveCompletion: boolean;
}

const action = /\b(?:rename|replace|change|update|rewrite|set|add|remove|implement|make|adjust)\b/i;
const preserve = /^(?:\s*\d+[.)]\s*)?(?:do\s+not|don't|never|keep|preserve|retain|leave|without changing)\b/i;
const contactWords = /\b(?:e-?mail|mailto|phone|telephone|tel|contact\s+(?:information|details|address)|domains?|URLs?|external\s+links?|website\s+address)\b/i;
const normalize = (value: string) => value.replace(/&amp;|&#38;|&#x26;/gi, "&").replace(/&quot;/g, '"').replace(/&(?:apos|#39);/g, "'").replace(/\s+/g, " ").trim();

/** Deterministic, deliberately conservative grammar; preservation is not authorization. */
export function analyzeEditScope(instruction: string, rename?: { readonly oldLiteral: string; readonly newLiteral: string }): DeterministicEditScope {
  const clauses = instruction.split(/[;\n]+|(?<=[.!?])\s+/).map(value => value.trim()).filter(Boolean);
  const unquoted = (value: string) => value.replace(/["“][^"”]*["”]|'[^']*'/g, "");
  const active = clauses.filter(value => action.test(value) && !preserve.test(value) && !/\b(?:not|never|except|excluding|keep|preserve|retain|leave)\b/i.test(unquoted(value)));
  const contactClauses = active.filter(value => contactWords.test(unquoted(value)) ||
    protectedEditValues(value).length >= 2 && /\b(?:replace|change|set)\b/i.test(value));
  const copyTargets: CopyTarget[] = [];
  const colors: string[] = [];
  let complete = true;
  for (const clause of active) {
    const copies = [...clause.matchAll(/\b(?:change|update|rewrite|rename|set)\s+(?:the\s+)?([\w -]{1,80}?(?:heading|headline|title|description|paragraph|copy))\s+to\s+["“]([^"”]+)["”]/gi)];
    for (const copy of copies) copyTargets.push({ target: copy[1]!.toLowerCase(), value: copy[2]!, kind: /heading|headline|title/i.test(copy[1]!) ? "heading" : "description" });
    const color = /\b(?:accent|colou?r|palette|theme|styling)\b/i.test(unquoted(clause)) ? clause.match(/#[\da-f]{6}\b/gi) ?? [] : [];
    colors.push(...color);
    const brand = rename && clause.includes(rename.oldLiteral) && clause.includes(rename.newLiteral);
    const actions = [...unquoted(clause).matchAll(/\b(?:rename|replace|change|update|rewrite|set|add|remove|implement|make|adjust)\b/gi)].length;
    if ((!copies.length && !color.length && !brand) || actions > copies.length + (color.length ? 1 : 0) + (brand ? 1 : 0)) complete = false;
  }
  const activeText = active.map(unquoted).join("\n");
  return {
    ...(rename ? { rename } : {}),
    brand: Boolean(rename) || /\b(?:brand|branding|company name|business name)\b/i.test(activeText),
    content: copyTargets.length > 0 || /\b(?:copy|text|content|heading|headline|description|paragraph|title)\b/i.test(activeText),
    styling: /\b(?:colou?r|accent|palette|theme|styl(?:e|es|ing)|font|spacing|layout)\b/i.test(activeText),
    navigation: /\b(?:navigation|links?|routes?|menus?|destinations?)\b/i.test(activeText),
    contact: contactClauses.length > 0,
    functional: /\b(?:functionality|interactive|interactions?|cart|checkout|quantity|search|filters?|gallery|newsletter|size|controls?|handlers?|state)\b/i.test(activeText),
    instruction, contactClauses,
    requestedContacts: [...new Set(contactClauses.flatMap(clause => protectedEditValues(clause.split(/\b(?:to|with)\b/i).at(-1) ?? '').map(value => value.value)))],
    copyTargets, colors: [...new Set(colors.map(value => value.toLowerCase()))],
    canProveCompletion: active.length > 0 && complete,
  };
}

export function targetedEditScopeGuidance(scope: DeterministicEditScope): string {
  const allowed = (["brand", "content", "styling", "navigation", "contact", "functional"] as const).filter(key => scope[key]);
  return [
    `EDIT SCOPE: authorized categories: ${allowed.join(", ") || "only the explicit user request"}. No unrelated section or functionality changes.`,
    ...(scope.copyTargets.length ? [`Authorized copy targets: ${scope.copyTargets.slice(0, 8).map(target => target.target).join(", ")}.`] : []),
    ...(scope.colors.length ? [`Requested accent values: ${scope.colors.join(", ")}.`] : []),
    "A brand rename authorizes display branding, not inferred email addresses, domains, mailto/tel destinations, phone numbers or external URLs. Preserve these unless the user explicitly requests their change and supplies the replacement; never invent them.",
    "Keep independent changes in separate patches. Never combine an unrelated contact change with requested copy/style. Preserve existing layout and behavior unless explicitly requested.",
  ].join("\n");
}

/** Non-overlapping protected literals, including tokens inside a larger exact anchor. */
export function protectedEditValues(source: string, path?: string): ProtectedValue[] {
  const patterns: readonly [ProtectedKind, RegExp][] = [
    ["email", /[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}/gi],
    ["url", /(?:https?:\/\/|\/\/(?=[\w-]+\.)|mailto:|tel:)[^\s<>"'`{}]+/gi],
    ["phone", /\+?\d[\d ()-]{5,}\d/g],
    ["domain", /\b(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}\b/gi],
  ];
  let candidates = patterns.flatMap(([kind, pattern]) => [...source.matchAll(pattern)].map(match => ({ kind, value: match[0], start: match.index, end: match.index + match[0].length })));
  if (candidates.some(value => value.kind === 'domain')) {
    // Domain syntax overlaps JS member access and local import filenames. Parse
    // valid source rather than treating document.title or ./App.jsx as contacts.
    const file = ts.createSourceFile('protected.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const textRanges: { start: number; end: number }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) textRanges.push({ start: node.getStart(file), end: node.end });
      ts.forEachChild(node, visit);
    };
    visit(file);
    const parsed = (file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length === 0;
    candidates = candidates.filter(value => value.kind !== 'domain' ||
      !/\.(?:[jt]sx?|css|json|html?|svg|png|jpe?g|webp|gif|woff2?|mjs|cjs)$/i.test(value.value) &&
      (!parsed && !path?.endsWith('.css') || value.start === 0 && value.end === source.length || textRanges.some(range => range.start <= value.start && range.end >= value.end)));
  }
  // Prefer the containing URL (e.g. mailto:) over the nested email/domain.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const values: ProtectedValue[] = [];
  for (const value of candidates) if (!values.some(earlier => earlier.start < value.end && earlier.end > value.start)) values.push(value);
  return values;
}

export function maskProtectedEditValues(source: string): string {
  let result = source;
  for (const value of protectedEditValues(source).reverse()) result = result.slice(0, value.start) + " ".repeat(value.end - value.start) + result.slice(value.end);
  return result;
}

function authorized(value: ProtectedValue, scope: DeterministicEditScope): boolean {
  return scope.contactClauses.some(clause => {
    if (!clause.includes(value.value) && !(value.value.startsWith("mailto:") && clause.includes(value.value.slice(7))) &&
        !(value.value.startsWith("tel:") && clause.includes(value.value.slice(4)))) return false;
    return value.kind === "email" || value.value.startsWith("mailto:") ? /\b(?:email|e-mail|mailto|replace|change|set)\b/i.test(clause)
      : value.kind === "phone" || value.value.startsWith("tel:") ? /\b(?:phone|telephone|tel|replace|change|set)\b/i.test(clause)
      : /\b(?:domain|url|link|address|replace|change|set)\b/i.test(clause);
  });
}

export function explicitlyAuthorizedProtectedPatch(patch: SiteEditPatch, scope: DeterministicEditScope): boolean {
  const values = protectedEditValues(patch.replace);
  return values.length > 0 && values.every(value => authorized(value, scope));
}

function counts(values: readonly ProtectedValue[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value.value, (result.get(value.value) ?? 0) + 1);
  return result;
}

/** Full-source check also catches a short brand patch that accidentally touches an address. */
export function validateProtectedEditValues(scope: DeterministicEditScope, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
  for (const [path, source] of after) {
    const old = protectedEditValues(before.get(path) ?? "", path), next = protectedEditValues(source, path);
    const a = counts(old), b = counts(next);
    const removed = old.filter(value => (a.get(value.value) ?? 0) > (b.get(value.value) ?? 0));
    const added = next.filter(value => (b.get(value.value) ?? 0) > (a.get(value.value) ?? 0));
    if (!removed.length && !added.length && JSON.stringify(old.map(value => value.value)) !== JSON.stringify(next.map(value => value.value)))
      throw scopeError(path, "PROTECTED_VALUE_REORDER_NOT_AUTHORIZED");
    if (removed.length || added.length) {
      // An explicit category and supplied new literal are required. Moving or deleting
      // contact values is uncertain too; it cannot be laundered through a broad patch.
      if (!added.length || added.some(value => !authorized(value, scope)) || removed.some(value =>
        !added.some(replacement => replacement.kind === value.kind && authorized(replacement, scope))))
        throw scopeError(path, "PROTECTED_VALUE_CHANGE_NOT_AUTHORIZED");
    }
  }
}

export function scopeError(path: string, reason: string, patch?: SiteEditPatch): ApplicationError {
  return new ApplicationError("VALIDATION_FAILED", `Targeted edit scope rejected in ${path}: ${reason}`, {
    metadata: { failureStage: "PATCH_APPLICATION", validationCheck: "edit.scope", path, reason,
      ...(patch ? { findDigest: editTextDigest(patch.find), replacementDigest: editTextDigest(patch.replace) } : {}) },
  });
}

function staticContactPosition(file: ts.SourceFile, start: number, end: number): boolean {
  let safe = false;
  const visit = (node: ts.Node): void => {
    if (node.getFullStart() > start || node.end < end) return;
    if (ts.isJsxText(node)) safe = true;
    if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent) && /^(?:href|action)$/i.test(node.parent.name.getText(file))) safe = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return safe;
}

function protectedShape(source: string): string {
  let result = source;
  for (const value of protectedEditValues(source).reverse()) result = result.slice(0, value.start) + `\0${value.kind}\0` + result.slice(value.end);
  return result;
}

/** Only whole, pure protected-literal substitutions can be excluded, never a mixed patch. */
export function independentScopedPatches(patches: readonly SiteEditPatch[], source: ReadonlyMap<string, string>, scope: DeterministicEditScope): { readonly patches: readonly SiteEditPatch[]; readonly excluded: readonly number[] } {
  const excluded: number[] = [];
  for (const [index, patch] of patches.entries()) {
    const old = protectedEditValues(patch.find, patch.path), next = protectedEditValues(patch.replace, patch.path);
    if (JSON.stringify([...counts(old)]) === JSON.stringify([...counts(next)])) continue;
    if (next.length && next.every(value => authorized(value, scope))) continue;
    // Contact/navigation requests that cannot be bound to a supplied value are
    // uncertain, not clearly unrelated. Do not silently omit a required change.
    if (scope.contact || scope.navigation || !scope.canProveCompletion || !old.length || !next.length ||
        protectedShape(patch.find) !== protectedShape(patch.replace) ||
        old.length !== next.length || old.some((value, i) => value.kind !== next[i]!.kind) ||
        new Set(old.map(value => value.value)).size !== 1 || new Set(next.map(value => value.value)).size !== 1 ||
        [...old, ...next].some(value => scope.instruction.includes(value.value)))
      throw scopeError(patch.path, "MIXED_OR_UNCERTAIN_UNAUTHORIZED_OPERATION", patch);
    const original = source.get(patch.path) ?? "", offsets = exactMatchOffsets(original, patch.find);
    if (!offsets.length || !/\.[jt]sx$/.test(patch.path)) throw scopeError(patch.path, "UNPROVEN_SOURCE_INDEPENDENCE", patch);
    const file = ts.createSourceFile(patch.path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length ||
        offsets.some(offset => old.some(value => !staticContactPosition(file, offset + value.start, offset + value.end))))
      throw scopeError(patch.path, "NON_STATIC_CONTACT_DEPENDENCY", patch);
    for (const [otherIndex, other] of patches.entries()) {
      if (otherIndex === index) continue;
      if ([...old, ...next].some(value => other.find.includes(value.value) || other.replace.includes(value.value)))
        throw scopeError(patch.path, "OVERLAPPING_OR_ORDER_DEPENDENT_OPERATION", patch);
      if (other.path !== patch.path) continue;
      const otherOffsets = exactMatchOffsets(original, other.find);
      if (!otherOffsets.length ||
          offsets.some(start => otherOffsets.some(otherStart => start < otherStart + other.find.length && otherStart < start + patch.find.length)))
        throw scopeError(patch.path, "OVERLAPPING_OR_ORDER_DEPENDENT_OPERATION", patch);
    }
    excluded.push(index);
  }
  if (excluded.length) for (const [index, patch] of patches.entries()) {
    if (!excluded.includes(index) && !provenAuthorizedPatch(patch, source.get(patch.path) ?? "", scope))
      throw scopeError(patch.path, "RETAINED_OPERATION_AUTHORIZATION_UNCERTAIN", patch);
  }
  return { patches: patches.filter((_patch, index) => !excluded.includes(index)), excluded };
}

function jsxText(node: ts.Node): string {
  if (ts.isJsxText(node)) return node.getText();
  if (ts.isJsxExpression(node)) return node.expression && ts.isStringLiteralLike(node.expression) ? node.expression.text : "{dynamic}";
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText() === "br" ? " " : "{dynamic}";
  return ts.isJsxElement(node) ? node.children.map(jsxText).join("") : "";
}
function copyTargetMatches(file: ts.SourceFile, node: ts.JsxElement, target: CopyTarget, requireValue = true): boolean {
  if (!(target.kind === "heading" ? /^h[1-6]$/.test(node.openingElement.tagName.getText(file)) : node.openingElement.tagName.getText(file) === "p")) return false;
  if (requireValue && normalize(jsxText(node)) !== normalize(target.value)) return false;
  const ancestors: ts.Node[] = [];
  for (let current: ts.Node | undefined = node; current; current = current.parent) ancestors.push(current);
  if (/\bhome(?:page)?\b/.test(target.target) && !ancestors.some(item => ts.isFunctionDeclaration(item) && /^Home(?:Page)?$/i.test(item.name?.text ?? "") ||
      ts.isVariableDeclaration(item) && /^Home(?:Page)?$/i.test(item.name.getText(file))) && !/(?:^|\/)Home(?:Page)?\.[jt]sx?$/.test(file.fileName)) return false;
  for (const section of ["hero", "featured", "footer", "header"]) {
    if (!new RegExp(`\\b${section}\\b`).test(target.target)) continue;
    if (!ancestors.some(item => ts.isJsxElement(item) && (item.openingElement.tagName.getText(file) === section || item.openingElement.attributes.properties.some(attr =>
      ts.isJsxAttribute(attr) && /^(?:className|id)$/.test(attr.name.getText(file)) && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text.split(/[\s_-]+/).includes(section))))) return false;
  }
  return true;
}

function staticCopy(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return true;
  if (ts.isJsxExpression(node)) return Boolean(node.expression && ts.isStringLiteralLike(node.expression));
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText() === "br" && node.attributes.properties.length === 0;
  return ts.isJsxElement(node) && /^(?:i|em|b|strong|span)$/.test(node.openingElement.tagName.getText()) &&
    node.openingElement.attributes.properties.length === 0 && node.children.every(staticCopy);
}
function copyFragment(source: string): string | undefined {
  const file = ts.createSourceFile('copy.tsx', `const copy=<span>${source}</span>`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) return;
  const statement = file.statements[0];
  const node = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  return node && ts.isJsxElement(node) && node.children.every(staticCopy) ? normalize(jsxText(node)) : undefined;
}

/** Required when anything is excluded: every retained operation must itself have
 * a narrow authorization proof, not merely share a broad category keyword. */
function provenAuthorizedPatch(patch: SiteEditPatch, source: string, scope: DeterministicEditScope): boolean {
  const rename = scope.rename;
  if (rename) {
    const old = normalize(patch.find), next = normalize(patch.replace);
    const escaped = rename.oldLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (old.toLowerCase().includes(rename.oldLiteral.toLowerCase()) && old.replace(new RegExp(escaped, 'gi'), () => rename.newLiteral) === next) {
      if (patch.path === 'index.html' && patch.find.toLowerCase() === rename.oldLiteral.toLowerCase()) return true;
      const file = ts.createSourceFile(patch.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      if (exactMatchOffsets(source, patch.find).every(offset => staticContactPosition(file, offset, offset + patch.find.length))) return true;
    }
    if (copyFragment(patch.find)?.toLowerCase() === rename.oldLiteral.toLowerCase() && copyFragment(patch.replace)?.toLowerCase() === rename.newLiteral.toLowerCase()) {
      const file = ts.createSourceFile(patch.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      if (exactMatchOffsets(source, patch.find).every(offset => {
        let matched = false;
        const visit = (node: ts.Node): void => {
          if (ts.isJsxElement(node) && node.children.every(staticCopy) && normalize(jsxText(node)).toLowerCase() === rename.oldLiteral.toLowerCase() &&
              node.openingElement.end <= offset && node.closingElement.getStart(file) >= offset + patch.find.length) matched = true;
          ts.forEachChild(node, visit);
        };
        visit(file); return matched;
      })) return true;
    }
  }
  if (patch.path.endsWith('.css') && scope.styling) {
    try {
      const a = postcss.parse(`x{${patch.find}}`), b = postcss.parse(`x{${patch.replace}}`);
      const old: { prop: string; value: string }[] = [], next: { prop: string; value: string }[] = [];
      a.walkDecls(decl => { old.push(decl); }); b.walkDecls(decl => { next.push(decl); });
      if (old.length === 1 && next.length === 1 && old[0]!.prop === next[0]!.prop && scope.colors.includes(next[0]!.value.toLowerCase()) &&
          patch.find.replace(old[0]!.value, '') === patch.replace.replace(next[0]!.value, '')) return true;
    } catch { return false; }
  }
  const copy = copyFragment(patch.replace);
  if (!copy || copyFragment(patch.find) === undefined) return false;
  const targets = scope.copyTargets.filter(target => normalize(target.value) === copy);
  const file = ts.createSourceFile(patch.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return exactMatchOffsets(source, patch.find).every(offset => {
    let matched = false;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.end <= offset && node.closingElement.getStart(file) >= offset + patch.find.length &&
          targets.some(target => copyTargetMatches(file, node, target, false))) matched = true;
      ts.forEachChild(node, visit);
    };
    visit(file); return matched;
  });
}

/** Recognized exact copy/color values are checked on source, never model claims. */
export function validateEditScopeCompletion(scope: DeterministicEditScope, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
  for (const requested of scope.requestedContacts) {
    let found = false;
    for (const [path, source] of after) {
      if (!/\.[jt]sx?$/.test(path)) continue;
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteralLike(node) || ts.isJsxText(node)) && protectedEditValues(ts.isJsxText(node) ? node.getText(file) : node.text)
          .some(value => value.value === requested || value.value === `mailto:${requested}` || value.value === `tel:${requested}`)) found = true;
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    if (!found) throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The explicitly requested contact change is incomplete", { metadata: { requirement: "contact", phase: "completion", valueDigest: editTextDigest(requested) } });
  }
  for (const target of scope.copyTargets) {
    let found = false;
    for (const [path, source] of after) {
      if (!/\.[jt]sx?$/.test(path)) continue;
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node) && copyTargetMatches(file, node, target)) found = true;
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    if (!found) throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The requested copy change is incomplete", {
      metadata: { requirement: "content", target: target.target, phase: "completion", valueDigest: editTextDigest(target.value) },
    });
  }
  for (const color of scope.colors) {
    let found = false;
    for (const [path, source] of after) {
      if (source === before.get(path)) continue;
      if (path.endsWith('.css')) {
        try { postcss.parse(source).walkDecls(decl => { if (decl.value.toLowerCase().includes(color)) found = true; }); } catch { /* Static/build validation remains authoritative. */ }
      } else if (/\.[jt]sx?$/.test(path)) {
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const visit = (node: ts.Node): void => { if (ts.isStringLiteralLike(node) && node.text.toLowerCase() === color &&
          (ts.isPropertyAssignment(node.parent) || ts.isJsxAttribute(node.parent))) found = true; ts.forEachChild(node, visit); };
        visit(file);
      }
    }
    if (!found) throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The requested explicit accent color is incomplete", { metadata: { requirement: "style", phase: "completion" } });
  }
}
