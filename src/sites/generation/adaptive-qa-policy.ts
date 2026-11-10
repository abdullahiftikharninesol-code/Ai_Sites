import ts from "typescript";
import postcss from "postcss";
import { ApplicationError } from "../../app/errors/application-error.js";
import { BROWSER_QA_VIEWPORTS, createBrowserQACheckResult, createBrowserQAReport, type BrowserQAFailureKind, type BrowserQAReport, type BrowserQAViewport } from "../../browser-qa/browser-qa-domain.js";
import type { BrowserQACheckExecutor, BrowserQARouteTarget } from "../../browser-qa/browser-qa-runner.js";
import { mapEditRepository } from "../../cli/runtime/edit-repository-map.js";
import type { DeterministicEditScope } from "../../cli/runtime/edit-scope.js";
import { functionalBrowserChecks } from "../../browser-qa/functional-capability-checks.js";
import { functionalRequirements, type FunctionalCapability, type FunctionalRequirements } from "./functional-capabilities.js";
import { extractCalculationFormula, type CalculationFormula } from "./calculation-formula.js";
import { functionalBehaviors, type FunctionalRequirement, type ResolvedFunctionalContract } from "./functional-route-contract.js";
import { functionalSourceManifest } from "./functional-source-contract.js";

/**
 * Deterministic, source-grounded Browser QA selection.
 *
 * Mandatory source/build/protection/meaningful-change validation runs before
 * this policy and is never skipped by it. The policy only decides how much
 * *browser* evidence a candidate needs: which routes, viewports, check groups,
 * screenshots and requested-behavior assertions. Whenever the change scope
 * cannot be proven from source, it falls back to the historical full QA.
 */

export type QAOutcome = "VERIFIED" | "FAILED" | "INCONCLUSIVE";
export type EditChangeKind = "TEXT" | "STYLE" | "NAVIGATION" | "FUNCTIONAL" | "UNCERTAIN";
export type QACheckGroup = "CORE" | "LAYOUT" | "INTERACTION";
export type RequirementPolicy = "REQUIRED" | "OPTIONAL";

export interface EditChangeImpact {
  readonly kind: EditChangeKind;
  /** Routes whose rendering can be affected; every known route when `allRoutes`. */
  readonly routes: readonly string[];
  readonly allRoutes: boolean;
  /** False when route reachability could not be established from source. */
  readonly scopeProven: boolean;
  readonly files: readonly { readonly path: string; readonly kind: EditChangeKind }[];
  readonly reasons: readonly string[];
}

export interface PlannedRequirement {
  readonly id: string;
  readonly capability: FunctionalCapability;
  readonly routes: readonly string[];
  readonly policy: RequirementPolicy;
  readonly reason: "SOURCE_RECOGNIZED" | "SOURCE_UNCERTAIN" | "SECTION_LABEL_ONLY";
  /** calculator: the explicit rule stated in the instruction, if any. */
  readonly formula?: CalculationFormula;
}

export interface BrowserQAPlan {
  /** SOURCE_BUILD_ONLY never launches a browser; FULL is the historical exhaustive run. */
  readonly mode: "SOURCE_BUILD_ONLY" | "TARGETED" | "FULL";
  readonly profile: "GENERATION" | "GENERATION_RETRY" | "TEXT" | "VISUAL" | "NAVIGATION" | "FUNCTIONAL" | "FULL";
  readonly targets: readonly BrowserQARouteTarget[];
  readonly checkGroups: readonly QACheckGroup[];
  /** Interaction probes run only at these viewports (mobile navigation is always mobile). */
  readonly interactionViewports: readonly BrowserQAViewport["id"][];
  readonly screenshotTargets: readonly BrowserQARouteTarget[] | "ALL";
  readonly fullPageScreenshots: boolean;
  readonly requirements: readonly PlannedRequirement[];
  /** Requested behavior with no recognized implementation to assert; always limits coverage. */
  readonly unplannedRequests?: readonly string[];
  readonly reasons: readonly string[];
}

export interface QARequirementResult {
  readonly id: string;
  readonly capability: string;
  readonly policy: RequirementPolicy;
  readonly status: "VERIFIED" | "FAILED" | "UNVERIFIED";
  readonly detail?: string;
  /** What the browser actually exercised for a verified requirement. */
  readonly checked?: string;
}

export interface QAVerification {
  readonly outcome: QAOutcome;
  /** What the evidence actually covers; smoke-only results never claim requirement verification. */
  readonly coverage: "SOURCE_BUILD" | "BROWSER_SMOKE" | "REQUIREMENTS";
  readonly limitedCoverage: boolean;
  readonly plan: { readonly mode: BrowserQAPlan["mode"]; readonly profile: BrowserQAPlan["profile"]; readonly reasons: readonly string[] };
  readonly requirements: readonly QARequirementResult[];
  readonly unverifiedRequests?: readonly string[];
  readonly failureKinds?: readonly string[];
  readonly metrics: { readonly browserLaunched: boolean; readonly routeVisits: number; readonly screenshots: number; readonly durationMs: number };
}

const viewport = (id: BrowserQAViewport["id"]): BrowserQAViewport => BROWSER_QA_VIEWPORTS.find(item => item.id === id)!;
const DESKTOP = viewport("DESKTOP"), MOBILE = viewport("MOBILE");
const target = (route: string, at: BrowserQAViewport): BrowserQARouteTarget => ({ route, viewport: at });
const uniqueRoutes = (routes: readonly string[]) => [...new Set(routes.filter(route => route.startsWith("/") && !/[:*]/.test(route)))];

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

const KIND_RANK: Readonly<Record<EditChangeKind, number>> = { TEXT: 0, STYLE: 1, NAVIGATION: 2, FUNCTIONAL: 3, UNCERTAIN: 4 };
const maxKind = (kinds: readonly EditChangeKind[]): EditChangeKind => kinds.reduce<EditChangeKind>((a, b) => KIND_RANK[b] > KIND_RANK[a] ? b : a, "TEXT");
const STYLE_ATTRIBUTES = /^(?:className|class|style)$/;
const NAVIGATION_ATTRIBUTES = /^(?:href|to|src|srcSet|path|action)$/;
const TEXT_ATTRIBUTES = /^(?:alt|title|aria-label|aria-description|placeholder|label)$/;
// Object properties that conventionally carry display copy in generated data arrays.
const TEXT_PROPERTIES = /^(?:name|title|heading|subtitle|description|summary|text|body|copy|label|caption|quote|author|role|alt|excerpt|eyebrow|cta|tagline|bio)$/i;
const DYNAMIC_MODULE_LOADING = /import\.meta\.glob|require\.context|\bimport\(\s*[^'"\s)]/;

interface Literal { readonly node: ts.Node; readonly start: number; readonly end: number; readonly text: string }
function literals(file: ts.SourceFile, root: ts.Node): Literal[] {
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = ts.isJsxText(node) ? node.pos : node.getStart(file);
      found.push({ node, start, end: node.end, text: file.text.slice(start, node.end) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}
function skeleton(file: ts.SourceFile, root: ts.Node, values: readonly Literal[]): string {
  let result = "", cursor = root.getStart(file);
  for (const value of values) { result += file.text.slice(cursor, value.start) + "\u0000"; cursor = value.end; }
  return (result + file.text.slice(cursor, root.end)).replace(/\s+/g, " ");
}
/** A changed literal's role, judged from its syntactic owner, never from its words. */
function literalKind(literal: Literal): EditChangeKind {
  if (ts.isJsxText(literal.node)) return "TEXT";
  for (let node: ts.Node | undefined = literal.node.parent; node; node = node.parent) {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      return STYLE_ATTRIBUTES.test(name) ? "STYLE" : NAVIGATION_ATTRIBUTES.test(name) ? "NAVIGATION" : TEXT_ATTRIBUTES.test(name) ? "TEXT" : "FUNCTIONAL";
    }
    if (ts.isJsxExpression(node) && ts.isJsxElement(node.parent)) return ts.isNumericLiteral(literal.node) ? "FUNCTIONAL" : "TEXT";
    if (ts.isPropertyAssignment(node)) {
      if (ts.isNumericLiteral(literal.node)) return "FUNCTIONAL";
      const name = node.name.getText().replace(/^["']|["']$/g, "");
      return TEXT_PROPERTIES.test(name) && ts.isObjectLiteralExpression(node.parent) && (ts.isArrayLiteralExpression(node.parent.parent) || ts.isVariableDeclaration(node.parent.parent)) ? "TEXT" : "FUNCTIONAL";
    }
    if (ts.isBinaryExpression(node) || ts.isCallExpression(node) || ts.isCaseClause(node) || ts.isConditionalExpression(node) || ts.isIfStatement(node) ||
        ts.isReturnStatement(node) || ts.isVariableDeclaration(node) || ts.isBlock(node) || ts.isSourceFile(node)) return "FUNCTIONAL";
  }
  return "FUNCTIONAL";
}

interface Declaration { readonly name: string; readonly node: ts.Node }
function topLevelDeclarations(file: ts.SourceFile): Declaration[] {
  return file.statements.flatMap(statement => {
    if (ts.isImportDeclaration(statement)) return [];
    const names = ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(item => ts.isIdentifier(item.name) ? [item.name.text] : [])
      : (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name ? [statement.name.text]
      : ts.isExportAssignment(statement) ? ["default"] : [];
    return [{ name: names.join(",") || `#statement${file.statements.indexOf(statement)}`, node: statement }];
  });
}
const parse = (path: string, content: string) => ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const parseFailed = (file: ts.SourceFile) => (file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length > 0;

/** Changed top-level declarations of a script file and the kind of each change. */
function scriptChanges(path: string, before: string | undefined, after: string): { readonly kind: EditChangeKind; readonly declarations: ReadonlyMap<string, EditChangeKind> } | undefined {
  if (Buffer.byteLength(after) > 256 * 1024 || (before !== undefined && Buffer.byteLength(before) > 256 * 1024)) return undefined;
  const next = parse(path, after);
  if (parseFailed(next)) return undefined;
  const changed = new Map<string, EditChangeKind>();
  if (before === undefined) {
    for (const declaration of topLevelDeclarations(next)) changed.set(declaration.name, "FUNCTIONAL");
    return { kind: "FUNCTIONAL", declarations: changed };
  }
  const previous = parse(path, before);
  if (parseFailed(previous)) return undefined;
  const old = new Map(topLevelDeclarations(previous).map(item => [item.name, item.node]));
  const current = topLevelDeclarations(next);
  // Imports/exports or the declaration set itself changed: module structure, not content.
  const importText = (file: ts.SourceFile) => file.statements.filter(ts.isImportDeclaration).map(item => item.getText(file)).sort().join("\n");
  if (importText(previous) !== importText(next)) changed.set("#imports", "FUNCTIONAL");
  for (const name of old.keys()) if (!current.some(item => item.name === name)) changed.set(name, "FUNCTIONAL");
  for (const { name, node } of current) {
    const prior = old.get(name);
    if (!prior) { changed.set(name, "FUNCTIONAL"); continue; }
    if (prior.getText(previous) === node.getText(next)) continue;
    const a = literals(previous, prior), b = literals(next, node);
    if (a.length !== b.length || skeleton(previous, prior, a) !== skeleton(next, node, b)) { changed.set(name, "FUNCTIONAL"); continue; }
    const kinds = b.filter((literal, index) => literal.text.replace(/\s+/g, " ") !== a[index]!.text.replace(/\s+/g, " ")).map(literalKind);
    changed.set(name, kinds.length ? maxKind(kinds) : "TEXT");
  }
  return { kind: changed.size ? maxKind([...changed.values()]) : "TEXT", declarations: changed };
}

/** Class/id tokens used by changed CSS rules; undefined when a rule is global (element/:root/@font-face). */
function changedStyleTokens(before: string, after: string): string[] | undefined {
  const rules = (content: string) => {
    const map = new Map<string, string>();
    try {
      postcss.parse(content).walk(node => {
        if (node.type === "rule") map.set(`${node.parent?.type === "atrule" ? `@${(node.parent as postcss.AtRule).params} ` : ""}${node.selector}`, node.nodes.map(child => child.toString()).join(";"));
        else if (node.type === "atrule" && !node.nodes?.some(child => child.type === "rule")) map.set(`@${node.name} ${node.params}`, node.toString());
      });
    } catch { return undefined; }
    return map;
  };
  const old = rules(before), next = rules(after);
  if (!old || !next) return undefined;
  const tokens = new Set<string>();
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    if (old.get(key) === next.get(key)) continue;
    if (key.startsWith("@") && !key.includes(" .") && !key.includes(" #") && !/[.#]/.test(key.split(" ").slice(1).join(" ").replace(/\([^)]*\)/g, ""))) return undefined;
    for (const complex of key.replace(/^@\S+\s+[^.#]*?(?=[.#]|$)/, "").split(",")) {
      const found = [...complex.replace(/\[[^\]]*\]|\([^)]*\)/g, "").matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]!);
      if (!found.length) return undefined;
      tokens.add(found.at(-1)!);
    }
  }
  return [...tokens];
}

/**
 * Which routes can render a changed declaration. Route roots are the component
 * identifiers bound next to a known route literal (`<Route path element>`,
 * `{ path, element }`, `route === "/x" && <X/>`, `case "/x":`). Anything not
 * reachable from a route root (router shell, shared layout, global data) or
 * any unknown structure affects every route.
 */
function affectedRoutes(sources: ReadonlyMap<string, string>, changed: ReadonlyMap<string, ReadonlySet<string>>, routes: readonly string[]): { readonly routes: readonly string[]; readonly all: boolean; readonly reason?: string } {
  const scripts = [...sources].filter(([path]) => /\.[jt]sx?$/.test(path) && !/\.d\.ts$/.test(path));
  if (scripts.some(([, content]) => DYNAMIC_MODULE_LOADING.test(content))) return { routes, all: true, reason: "DYNAMIC_MODULE_LOADING" };
  const map = mapEditRepository(scripts.map(([path, content]) => ({ path, content })));
  if (map.files.some(file => file.parseErrors)) return { routes, all: true, reason: "UNPARSEABLE_SOURCE" };
  const key = (path: string, name: string) => `${path}#${name}`;
  const edges = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  for (const file of map.files) {
    const own = new Set(file.regions.filter(region => !region.owner).flatMap(region => region.declares));
    declared.set(file.path, own);
    const imported = new Map(file.imports.flatMap(item => item.target ? item.bindings.map(binding => [binding, item.target!] as const) : []));
    for (const region of file.regions.filter(item => !item.owner && item.declares.length && item.kind !== "ImportDeclaration")) {
      const targets = new Set<string>();
      for (const reference of region.references) {
        if (own.has(reference) && !region.declares.includes(reference)) targets.add(key(file.path, reference));
        const module = imported.get(reference);
        if (module) targets.add(key(module, "*"));
      }
      for (const name of region.declares) edges.set(key(file.path, name), targets);
    }
  }
  // A module node reaches every top-level declaration of that module.
  for (const [path, names] of declared) edges.set(key(path, "*"), new Set([...names].map(name => key(path, name))));
  const reach = (roots: readonly string[]) => {
    const seen = new Set<string>(roots), queue = [...roots];
    for (let i = 0; i < queue.length; i++) for (const next of edges.get(queue[i]!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    return seen;
  };
  const rootsByRoute = new Map<string, string[]>();
  for (const [path, content] of scripts) {
    const file = parse(path, content), own = declared.get(path) ?? new Set<string>();
    const imported = new Map(map.files.find(item => item.path === path)!.imports.flatMap(item => item.target ? item.bindings.map(binding => [binding, item.target!] as const) : []));
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && routes.includes(node.text)) {
        const attribute = ts.isJsxAttribute(node.parent) ? node.parent.name.getText(file) : undefined;
        if (!attribute || attribute === "path") {
          let scope: ts.Node | undefined = node.parent;
          while (scope && !(ts.isJsxElement(scope) || ts.isJsxSelfClosingElement(scope) || ts.isObjectLiteralExpression(scope) || ts.isConditionalExpression(scope) ||
            ts.isBinaryExpression(scope) && scope.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || ts.isCaseClause(scope) || ts.isIfStatement(scope))) scope = scope.parent;
          const bound: string[] = [];
          const collect = (child: ts.Node): void => {
            if (ts.isIdentifier(child)) {
              if (own.has(child.text)) bound.push(key(path, child.text));
              const module = imported.get(child.text);
              if (module) bound.push(key(module, "*"));
            }
            ts.forEachChild(child, collect);
          };
          if (scope) {
            const body = ts.isConditionalExpression(scope) ? scope.whenTrue : ts.isIfStatement(scope) ? scope.thenStatement : scope;
            collect(body);
          }
          if (bound.length) rootsByRoute.set(node.text, [...(rootsByRoute.get(node.text) ?? []), ...bound]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (routes.some(route => !rootsByRoute.has(route))) return { routes, all: true, reason: "ROUTE_BINDING_UNRESOLVED" };
  const reachable = new Map([...rootsByRoute].map(([route, roots]) => [route, reach(roots)]));
  const affected = new Set<string>();
  for (const [path, names] of changed) for (const name of names) {
    const node = name.startsWith("#") ? key(path, "*") : key(path, name);
    const hits = [...reachable].filter(([, seen]) => seen.has(node) || seen.has(key(path, "*"))).map(([route]) => route);
    // Not reachable from any route root: router shell, shared layout or global state.
    if (!hits.length || name.startsWith("#")) return { routes, all: true, reason: "SHARED_OR_UNMAPPED_SOURCE" };
    hits.forEach(route => affected.add(route));
  }
  return affected.size === routes.length ? { routes, all: true, reason: "EVERY_ROUTE_RENDERS_CHANGE" } : { routes: routes.filter(route => affected.has(route)), all: false };
}

/** Classify a meaningful edit and the routes it can affect from before/after source alone. */
export function analyzeEditImpact(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, changedPaths: readonly string[], knownRoutes: readonly string[]): EditChangeImpact {
  const routes = uniqueRoutes(knownRoutes.length ? knownRoutes : ["/"]);
  const files: { path: string; kind: EditChangeKind }[] = [];
  const reasons: string[] = [];
  const changed = new Map<string, Set<string>>();
  const markups = [...after].filter(([path]) => /\.[jt]sx?$/.test(path));
  for (const path of changedPaths) {
    if (/\.[jt]sx?$/.test(path) && after.has(path) && !/(?:^|\/)main\.[jt]sx?$/.test(path)) {
      const result = scriptChanges(path, before.get(path), after.get(path)!);
      if (!result) { files.push({ path, kind: "UNCERTAIN" }); reasons.push(`UNANALYZABLE_SOURCE:${path}`); continue; }
      files.push({ path, kind: result.kind });
      changed.set(path, new Set(result.declarations.keys()));
    } else if (path.endsWith(".css") && after.has(path) && before.has(path)) {
      files.push({ path, kind: "STYLE" });
      const tokens = changedStyleTokens(before.get(path)!, after.get(path)!);
      if (!tokens) { reasons.push(`GLOBAL_STYLE_RULE:${path}`); changed.set(path, new Set(["#global"])); continue; }
      // Declarations whose markup uses a changed class/id inherit the style change.
      for (const [file, content] of markups) {
        const source = parse(file, content);
        for (const declaration of topLevelDeclarations(source))
          if (tokens.some(token => new RegExp(`(?<![\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(declaration.node.getText(source))))
            changed.set(file, new Set([...(changed.get(file) ?? []), declaration.name]));
      }
      if (!tokens.length || ![...changed.keys()].some(file => file !== path)) changed.set(path, new Set(["#global"]));
    } else {
      // Entry points, HTML shell, manifests, deleted or binary files: scope unknown.
      files.push({ path, kind: "UNCERTAIN" }); reasons.push(`UNSCOPED_FILE:${path}`);
    }
  }
  const kind = maxKind(files.map(file => file.kind));
  if (kind === "UNCERTAIN") return { kind, routes, allRoutes: true, scopeProven: false, files, reasons };
  const scopedChanges = new Map([...changed].filter(([path]) => !path.endsWith(".css")));
  const globalCss = [...changed].some(([path, names]) => path.endsWith(".css") && names.has("#global"));
  const mapped = globalCss ? { routes, all: true, reason: "GLOBAL_STYLE_RULE" } : affectedRoutes(after, scopedChanges, routes);
  if (mapped.reason) reasons.push(mapped.reason);
  const unproven = ["DYNAMIC_MODULE_LOADING", "UNPARSEABLE_SOURCE", "ROUTE_BINDING_UNRESOLVED"].includes(mapped.reason ?? "");
  return { kind, routes: mapped.routes, allRoutes: mapped.all, scopeProven: routes.length === 1 || !unproven, files, reasons };
}

// ---------------------------------------------------------------------------
// Requested behavior
// ---------------------------------------------------------------------------

const BUILD_VERB = /\b(?:add|create|implement|build|include|introduce|enable|make\b[^.!?\n]{0,40}\b(?:work|functional|interactive|clickable|filter|sort|search))\b/i;
const REMOVAL_VERB = /\b(?:remove|delete|hide|drop|get rid of|disable|take out)\b/i;

/**
 * Behavior the user explicitly requested in an edit, bound to the source that
 * implements it. Only a structurally recognized control becomes a mandatory
 * browser assertion. A requested-to-be-built capability that is provably absent
 * from a closed render graph rejects the edit; uncertain implementations are
 * probed but can only limit coverage, never fail the edit.
 */
export function requestedEditRequirements(instruction: string, after: ReadonlyMap<string, string>): PlannedRequirement[] {
  const requested = functionalRequirements(instruction);
  const capabilities = requested.capabilities.filter(capability => !requested.excludedCapabilities?.includes(capability));
  if (!capabilities.length) return [];
  const bundle = { files: [...after].filter(([path]) => /\.[jt]sx?$/.test(path)).map(([path, content]) => ({ path, content })) };
  let manifest;
  try { manifest = functionalSourceManifest(bundle); } catch { return capabilities.map(capability => ({ id: `edit.${capability}`, capability, routes: ["/"], policy: "OPTIONAL" as const, reason: "SOURCE_UNCERTAIN" as const })); }
  const planned: PlannedRequirement[] = [];
  const formula = capabilities.includes("calculator") ? extractCalculationFormula(instruction) : undefined;
  for (const capability of capabilities) {
    const recognized = manifest.routes.filter(route => route.capabilityAssessments[capability].state === "RECOGNIZED").map(route => route.path);
    const possible = manifest.routes.filter(route => route.capabilityAssessments[capability].state !== "PROVEN_MISSING").map(route => route.path);
    if (!possible.length && manifest.routes.length && BUILD_VERB.test(instruction) && !REMOVAL_VERB.test(instruction))
      throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", `The requested ${capability} behavior has no implemented control in the edited website. Your saved website is unchanged.`, {
        metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "edit.requested-capability", reason: "REQUESTED_CAPABILITY_NOT_IMPLEMENTED", capability, editOutcome: "NOT_APPLIED" },
      });
    const stated = capability === "calculator" && formula ? { formula } : {};
    if (recognized.length) planned.push({ id: `edit.${capability}`, capability, routes: uniqueRoutes(recognized), policy: "REQUIRED", reason: "SOURCE_RECOGNIZED", ...stated });
    else if (possible.length) planned.push({ id: `edit.${capability}`, capability, routes: uniqueRoutes(possible), policy: "OPTIONAL", reason: "SOURCE_UNCERTAIN", ...stated });
  }
  return planned;
}

/** Generation requirements resolved against generated source; only recognized controls are mandatory. */
export function plannedGenerationRequirements(contract: ResolvedFunctionalContract | undefined): PlannedRequirement[] {
  return (contract?.requirements ?? []).filter(requirement => requirement.routes?.length).map(requirement => {
    const sectionLabelOnly = requirement.target.kind === "SECTION" && !requirement.target.sectionId;
    const recognized = requirement.sourceAssessment?.state === "RECOGNIZED";
    return { id: requirement.id, capability: requirement.capability, routes: uniqueRoutes(requirement.routes!),
      policy: recognized && !sectionLabelOnly ? "REQUIRED" as const : "OPTIONAL" as const,
      reason: sectionLabelOnly ? "SECTION_LABEL_ONLY" as const : recognized ? "SOURCE_RECOGNIZED" as const : "SOURCE_UNCERTAIN" as const };
  });
}

// ---------------------------------------------------------------------------
// Plan selection
// ---------------------------------------------------------------------------

export function selectEditQAPlan(input: {
  readonly impact: EditChangeImpact;
  readonly scope?: DeterministicEditScope;
  readonly requirements: readonly PlannedRequirement[];
  readonly routes: readonly string[];
}): BrowserQAPlan {
  const { impact, requirements } = input;
  const allRoutes = uniqueRoutes(input.routes.length ? input.routes : ["/"]);
  const requirementRoutes = requirements.flatMap(requirement => requirement.routes);
  const reasons = [`CHANGE_${impact.kind}`, impact.allRoutes ? "SCOPE_ALL_ROUTES" : `SCOPE_${impact.routes.length}_ROUTES`, ...impact.reasons];
  const both = (routes: readonly string[]) => routes.flatMap(route => [target(route, DESKTOP), target(route, MOBILE)]);
  const base = { requirements, reasons, fullPageScreenshots: false } as const;
  // Unknown scope, or behavior changes whose route reach is unproven: historical exhaustive QA.
  if (impact.kind === "UNCERTAIN" || (impact.kind === "FUNCTIONAL" && !impact.scopeProven)) {
    return { ...base, mode: "FULL", profile: "FULL", targets: BROWSER_QA_VIEWPORTS.flatMap(at => allRoutes.map(route => target(route, at))),
      checkGroups: ["CORE", "LAYOUT", "INTERACTION"], interactionViewports: BROWSER_QA_VIEWPORTS.map(item => item.id), screenshotTargets: "ALL", fullPageScreenshots: true };
  }
  if (impact.kind === "FUNCTIONAL" || requirements.length) {
    const routes = uniqueRoutes([...impact.routes, ...requirementRoutes]);
    return { ...base, mode: "TARGETED", profile: "FUNCTIONAL", targets: both(routes), checkGroups: ["CORE", "LAYOUT", "INTERACTION"],
      interactionViewports: ["DESKTOP", "MOBILE"], screenshotTargets: [] };
  }
  if (impact.kind === "NAVIGATION") {
    const routes = uniqueRoutes(["/", ...impact.routes]);
    return { ...base, mode: "TARGETED", profile: "NAVIGATION", targets: both(routes), checkGroups: ["CORE", "INTERACTION"], interactionViewports: ["DESKTOP", "MOBILE"], screenshotTargets: [] };
  }
  if (impact.kind === "STYLE") {
    // Layout evidence at both breakpoints; screenshots only for a bounded sample of affected routes.
    return { ...base, mode: "TARGETED", profile: "VISUAL", targets: both(impact.routes), checkGroups: ["CORE", "LAYOUT"], interactionViewports: [],
      screenshotTargets: both(impact.routes.slice(0, 2)) };
  }
  // Text only. A deterministic copy target already proven by source completion
  // needs no browser: token-level literal changes cannot alter runtime behavior.
  const scope = input.scope;
  if (scope?.canProveCompletion && scope.copyTargets.length && !scope.colors.length && !scope.functional && !scope.navigation && !scope.contact)
    return { ...base, mode: "SOURCE_BUILD_ONLY", profile: "TEXT", targets: [], checkGroups: [], interactionViewports: [], screenshotTargets: [], reasons: [...reasons, "COPY_CHANGE_PROVEN_IN_SOURCE"] };
  return { ...base, mode: "TARGETED", profile: "TEXT", targets: impact.routes.map(route => target(route, DESKTOP)), checkGroups: ["CORE"], interactionViewports: [], screenshotTargets: [] };
}

/**
 * New websites: every route renders at desktop, every route is checked for
 * mobile rendering, interaction probes run once at desktop, and recognized
 * requested behavior is asserted. A repair retry keeps all mandatory checks but
 * revisits mobile only where the previous attempt failed (plus the entry route).
 */
export function selectGenerationQAPlan(routes: readonly string[], contract: ResolvedFunctionalContract | undefined, retry?: { readonly failed: readonly { readonly route?: string | undefined; readonly viewport?: string | undefined }[] }): BrowserQAPlan {
  const all = uniqueRoutes(routes.length ? routes : ["/"]);
  if (!all.includes("/")) all.unshift("/");
  const requirements = plannedGenerationRequirements(contract);
  const mobileRoutes = retry ? uniqueRoutes(["/", ...retry.failed.filter(item => item.viewport === "MOBILE" && item.route).map(item => item.route!)]) : all;
  return {
    mode: "TARGETED", profile: retry ? "GENERATION_RETRY" : "GENERATION",
    targets: [...all.map(route => target(route, DESKTOP)), ...mobileRoutes.filter(route => all.includes(route)).map(route => target(route, MOBILE))],
    checkGroups: ["CORE", "LAYOUT", "INTERACTION"], interactionViewports: ["DESKTOP"],
    screenshotTargets: [target("/", DESKTOP), target("/", MOBILE)], fullPageScreenshots: true, requirements,
    unplannedRequests: (contract?.advisories ?? []).filter(item => item.check === "functional.completion").slice(0, 12).map(item => item.message.slice(0, 200)),
    reasons: [retry ? "REPAIR_RETRY_AFFECTED_AND_MANDATORY" : "NEW_WEBSITE", `${all.length}_ROUTES`, `${requirements.filter(item => item.policy === "REQUIRED").length}_REQUIRED_REQUIREMENTS`],
  };
}

// ---------------------------------------------------------------------------
// Check selection
// ---------------------------------------------------------------------------

const GROUP_OF: Readonly<Record<string, QACheckGroup>> = {
  "route.load": "CORE", "internal-links": "CORE", "runtime.page-error": "CORE", "runtime.console-error": "CORE", "network.failed-request": "CORE",
  "generation.meaningful-content": "CORE", "browser-safety-events": "CORE",
  "responsive-overflow": "LAYOUT", "broken-images": "LAYOUT", "accessibility-smoke": "LAYOUT",
  "interaction-smoke": "INTERACTION", "interaction.mobile-nav": "INTERACTION", "form-smoke": "INTERACTION", "generation.primary-navigation": "INTERACTION",
  "functional.controls": "INTERACTION", "functional.navigation": "INTERACTION", "generation.requirement-advisories": "INTERACTION", "template-reference.requirements": "INTERACTION",
};

/** Keep the checks a plan's groups need and restrict interaction probes to the planned viewports. */
export function checksForPlan(plan: BrowserQAPlan, checks: readonly BrowserQACheckExecutor[]): BrowserQACheckExecutor[] {
  return checks.filter(check => {
    if (check.definition.checkId.startsWith("functional.requirements") || check.definition.checkId === "functional.optional-requirements") return true;
    const group = GROUP_OF[check.definition.checkId] ?? (check.definition.category === "INTERACTION" || check.definition.category === "FORM" ? "INTERACTION" : "CORE");
    return plan.checkGroups.includes(group);
  }).map(check => {
    const group = GROUP_OF[check.definition.checkId];
    // Navigation reachability (including the collapsed mobile menu) runs at every planned viewport.
    if (group !== "INTERACTION" || check.definition.checkId === "interaction.mobile-nav" || check.definition.checkId === "generation.primary-navigation") return check;
    const applies = check.appliesTo;
    return { ...check, appliesTo: (route: string, at: BrowserQAViewport) => plan.interactionViewports.includes(at.id) && (applies ? applies(route, at) : true) };
  });
}

/** Contract for the planned requirements; `policy` selects required or optional ones. */
export function requirementContract(plan: BrowserQAPlan, policy: RequirementPolicy, base?: ResolvedFunctionalContract): ResolvedFunctionalContract | undefined {
  const selected = plan.requirements.filter(item => item.policy === policy);
  if (!selected.length) return undefined;
  const known = new Map((base?.requirements ?? []).map(requirement => [requirement.id, requirement]));
  const requirements: FunctionalRequirement[] = selected.map(item => {
    const original = known.get(item.id);
    return original ? { ...original, routes: item.routes } : { id: item.id, capability: item.capability, target: { kind: "ANY_PAGE" }, expectedBehavior: functionalBehaviors[item.capability],
      mandatory: true, validation: "BROWSER_BEHAVIOR", routes: item.routes, ...(item.formula ? { formula: item.formula } : {}) };
  });
  return { version: 1, pages: [], actualRoutes: base?.actualRoutes ?? uniqueRoutes(selected.flatMap(item => item.routes)), requirements };
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** Failure kinds that prove only that verification did not complete, not that the site is defective. */
const INCONCLUSIVE_KINDS: ReadonlySet<BrowserQAFailureKind> = new Set(["QA_INFRASTRUCTURE_FAILURE", "CHECK_EXECUTION_ERROR", "CHECK_TIMEOUT", "READINESS_TIMEOUT", "ACTIONABILITY_TIMEOUT", "ROUTE_DEADLINE_EXCEEDED", "RUN_DEADLINE_EXCEEDED"]);
const UNREACHABLE_PREVIEW = /ERR_CONNECTION|ECONNREFUSED|ERR_EMPTY_RESPONSE|net::ERR_TIMED_OUT|Timeout \d+ms exceeded/i;

export function evaluateQAVerification(plan: BrowserQAPlan, report: BrowserQAReport | undefined, options: { readonly browserQAEnabled?: boolean } = {}): QAVerification {
  const planSummary = { mode: plan.mode, profile: plan.profile, reasons: plan.reasons };
  // Precedence: a pass on any route > an objective failure > limited coverage.
  const probes = new Map<string, "PASS" | "FAIL" | "LIMITED">();
  const failures = new Map<string, string>(), details = new Map<string, string>();
  for (const check of report?.checks ?? []) for (const probe of check.functionalProbes ?? []) {
    const current = probes.get(probe.requirementId);
    if (probe.result === "PASS") { probes.set(probe.requirementId, "PASS"); if (probe.detail) details.set(probe.requirementId, probe.detail); }
    else if (probe.result === "FAIL" && current !== "PASS") { probes.set(probe.requirementId, "FAIL"); failures.set(probe.requirementId, check.message.slice(0, 300)); }
    else if (probe.result === "LIMITED" && current === undefined) { probes.set(probe.requirementId, "LIMITED"); details.set(probe.requirementId, probe.detail ?? "Not objectively verifiable"); }
  }
  const requirements: QARequirementResult[] = plan.requirements.map(item => {
    const observed = probes.get(item.id);
    return { id: item.id, capability: item.capability, policy: item.policy,
      status: observed === "PASS" ? "VERIFIED" : observed === "FAIL" && item.policy === "REQUIRED" ? "FAILED" : "UNVERIFIED",
      ...(observed === "FAIL" ? { detail: failures.get(item.id)! } : observed === "LIMITED" ? { detail: `LIMITED_COVERAGE: ${details.get(item.id)!}` }
        : observed === undefined ? { detail: report ? "Not exercised by an applicable probe" : "No browser verification ran" } : {}),
      ...(observed === "PASS" && details.has(item.id) ? { checked: details.get(item.id)! } : {}) };
  });
  const metrics = { browserLaunched: !!report && !report.checks.some(check => check.checkId === "qa.infrastructure" && !check.route), routeVisits: report?.checks.filter(check => check.checkId === "page-readiness").length ?? 0,
    screenshots: report?.screenshots?.length ?? 0, durationMs: report?.durationMs ?? 0 };
  const blocking = (report?.checks ?? []).filter(check => check.status === "FAIL" && check.severity === "ERROR");
  const inconclusive = (check: (typeof blocking)[number]) => !!check.failureKind && INCONCLUSIVE_KINDS.has(check.failureKind) ||
    check.failureKind === "NAVIGATION_FAILURE" && check.checkId === "page-readiness" && UNREACHABLE_PREVIEW.test(check.message);
  const outcome: QAOutcome = !blocking.length ? "VERIFIED" : blocking.some(check => !inconclusive(check)) ? "FAILED" : "INCONCLUSIVE";
  const coverage = !report ? "SOURCE_BUILD" : requirements.some(item => item.status === "VERIFIED") ? "REQUIREMENTS" : "BROWSER_SMOKE";
  const unverifiedRequests = plan.unplannedRequests ?? [];
  return { outcome, coverage, limitedCoverage: requirements.some(item => item.status !== "VERIFIED") || unverifiedRequests.length > 0 || (!report && options.browserQAEnabled === false),
    plan: planSummary, requirements, ...(unverifiedRequests.length ? { unverifiedRequests } : {}), ...(blocking.length ? { failureKinds: [...new Set(blocking.map(check => check.failureKind ?? "UNCLASSIFIED"))] } : {}), metrics };
}

/**
 * Browser assertions for planned requirements, reusing the existing capability
 * probes. Required ones keep the blocking `functional.requirements` id (and the
 * existing single functional-repair path); optional ones are reported under
 * `functional.optional-requirements` at WARNING severity so an uncertain
 * implementation limits coverage instead of failing an otherwise valid site.
 */
export function requirementChecks(plan: BrowserQAPlan, functional: FunctionalRequirements, backendEnabled: boolean, base?: ResolvedFunctionalContract): BrowserQACheckExecutor[] {
  const checks: BrowserQACheckExecutor[] = [];
  const routes = uniqueRoutes(plan.targets.map(item => item.route));
  const required = requirementContract(plan, "REQUIRED", base);
  if (required) checks.push(functionalBrowserChecks(functional, routes, backendEnabled, required)[1]!);
  const optional = requirementContract(plan, "OPTIONAL", base);
  if (optional) {
    const probe = functionalBrowserChecks(functional, routes, backendEnabled, optional)[1]!;
    const id = "functional.optional-requirements";
    checks.push({ ...probe, definition: { ...probe.definition, checkId: id, defaultSeverity: "WARNING" },
      async execute(context) {
        try {
          const result = await probe.execute(context);
          return createBrowserQACheckResult({ ...result, checkId: id, severity: "WARNING" });
        } catch (error) {
          return createBrowserQACheckResult({ checkId: id, category: "INTERACTION", status: "WARNING", severity: "WARNING", route: context.route, viewport: context.viewport,
            message: `Optional requirement probe could not complete: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) });
        }
      } });
  }
  return checks;
}

/** Optional requirement probes never block, even when the runner itself timed them out. */
export function applyOptionalRequirementPolicy(report: BrowserQAReport): BrowserQAReport {
  if (!report.checks.some(check => check.checkId === "functional.optional-requirements" && check.severity === "ERROR")) return report;
  return createBrowserQAReport({ ...report, checks: report.checks.map(check => check.checkId === "functional.optional-requirements" && check.severity === "ERROR"
    ? createBrowserQACheckResult({ ...check, severity: "WARNING" }) : check) });
}
