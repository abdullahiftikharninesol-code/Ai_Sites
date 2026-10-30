import ts from "typescript";
import { posix } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import type { SiteSpec } from "../domain/site-spec.js";
import type { FunctionalCapability, FunctionalRequirements } from "./functional-capabilities.js";
import type { FunctionalSourceReference, ResolvedFunctionalContract } from "./functional-route-contract.js";
import { equivalentPage, pageId, requestedPages } from "./requested-pages.js";
import { assessFunctionalSource, type FunctionalSourceAssessment, type FunctionalSourcePart } from "./functional-source-evidence.js";

interface FunctionSource { readonly key: string; readonly name: string; readonly file: ts.SourceFile; readonly node: ts.Node; readonly children: readonly string[] }
interface RouteSource { readonly path: string; readonly roots: readonly string[]; readonly nodes: readonly ts.Node[]; readonly refs: readonly FunctionalSourceReference[]; readonly labels: readonly string[] }
export interface FunctionalSourceManifest {
  readonly routes: readonly { readonly path: string; readonly labels: readonly string[]; readonly capabilities: readonly FunctionalCapability[]; readonly capabilityAssessments: Readonly<Record<FunctionalCapability, FunctionalSourceAssessment>>; readonly complete: boolean; readonly sourceEvidence: readonly FunctionalSourceReference[]; readonly sections: readonly string[]; readonly sectionIdsComplete: boolean }[];
}
const reference = (file: ts.SourceFile, node: ts.Node): FunctionalSourceReference => ({ path: file.fileName, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
const text = (node: ts.Node | undefined): string | undefined => node && ts.isStringLiteralLike(node) ? node.text : undefined;
function routePath(value: string): string | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || /\s/.test(value) || [...value].some(char => char.charCodeAt(0) < 32)) return;
  return value.split(/[?#]/)[0]!.replace(/\/$/, "") || "/";
}
function jsxNames(node: ts.Node, file: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
      const name = child.tagName.getText(file);
      if (/^[A-Z]/.test(name) && name !== "Route" && name !== "Routes") names.push(name);
    }
    ts.forEachChild(child, visit);
  }; visit(node); return [...new Set(names)];
}
function attrs(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): ts.Expression | ts.StringLiteral | undefined {
  const attr = node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name);
  return attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr?.initializer;
}

/** Resolve actual routing syntax and rendered component graphs, never URL aliases alone. */
export function functionalSourceManifest(bundle: SiteCoderFileBundle): FunctionalSourceManifest {
  const files = new Map(bundle.files.filter(file => /^src\/.*\.[jt]sx?$/.test(file.path) && !file.path.startsWith("src/sites-ui/")).map(file => [file.path, ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));
  const functions = new Map<string, FunctionSource>(), imports = new Map<string, Map<string, { path: string; name: string }>>();
  const routes: RouteSource[] = [], layouts: RouteSource[] = [], nav = new Map<string, Set<string>>();
  const named = (file: ts.SourceFile, name: string) => `${file.fileName}:${name}`;
  const addNav = (path: string | undefined, label: string | undefined) => {
    const route = path && routePath(path); if (!route) return;
    const labels = nav.get(route) ?? new Set<string>(); if (label) labels.add(label); nav.set(route, labels);
  };
  for (const file of files.values()) {
    const localImports = new Map<string, { path: string; name: string }>(); imports.set(file.fileName, localImports);
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text, binding = statement.importClause?.namedBindings;
      const base = specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file.fileName), specifier)).replace(/\.[jt]sx?$/, "") : specifier;
      if (binding && ts.isNamedImports(binding)) for (const item of binding.elements) localImports.set(item.name.text, { path: base, name: (item.propertyName ?? item.name).text });
      if (statement.importClause?.name) localImports.set(statement.importClause.name.text, { path: base, name: "default" });
    }
    const collect = (node: ts.Node): void => {
      const name = ts.isFunctionDeclaration(node) ? node.name?.text : ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (name) functions.set(named(file, name), { key: named(file, name), name, file, node, children: jsxNames(node, file) });
      if (ts.isObjectLiteralExpression(node)) {
        const properties = node.properties.filter(ts.isPropertyAssignment);
        const target = properties.find(prop => ["href", "to"].includes(prop.name.getText(file).replace(/["']/g, "")));
        const label = properties.find(prop => ["label", "name", "title"].includes(prop.name.getText(file).replace(/["']/g, "")));
        addNav(text(target?.initializer), text(label?.initializer));
      }
      if (ts.isJsxElement(node)) {
        const opening = node.openingElement;
        const target = text(attrs(opening, "href")) ?? text(attrs(opening, "to"));
        const label = node.children.filter(ts.isJsxText).map(child => child.text.trim()).join(" ");
        addNav(target, label);
      }
      ts.forEachChild(node, collect);
    }; collect(file);
  }
  const resolveFunction = (file: ts.SourceFile, name: string): FunctionSource | undefined => {
    const local = functions.get(named(file, name)); if (local) return local;
    const imported = imports.get(file.fileName)?.get(name);
    if (!imported?.path.startsWith("src/")) return;
    for (const suffix of [".tsx", ".jsx", ".ts", ".js", "/index.tsx", "/index.jsx"]) {
      const target = files.get(imported.path + suffix); if (!target) continue;
      if (imported.name !== "default") return functions.get(named(target, imported.name));
      return [...functions.values()].find(fn => fn.file === target && /\bexport\s+default\b/.test(fn.node.getText(target)));
    }
    return;
  };
  const apps = [...functions.values()].filter(fn => fn.name === "App");
  const reachable = new Set<string>();
  const walkFunction = (fn: FunctionSource): void => { if (reachable.has(fn.key)) return; reachable.add(fn.key); for (const child of fn.children) { const target = resolveFunction(fn.file, child); if (target) walkFunction(target); } };
  for (const app of apps) walkFunction(app);
  const references = new Set<string>();
  for (const fn of functions.values()) if (reachable.has(fn.key)) {
    const visit = (node: ts.Node): void => { if (ts.isIdentifier(node)) references.add(named(fn.file, node.text)); ts.forEachChild(node, visit); }; visit(fn.node);
  }
  const addRoute = (file: ts.SourceFile, path: string, node: ts.Node, labels: string[] = [], layout = false) => {
    const route = routePath(path); if (!route || route.includes("*")) return;
    (layout ? layouts : routes).push({ path: route, roots: jsxNames(node, file).map(name => resolveFunction(file, name)?.key ?? named(file, name)), nodes: [node], refs: [reference(file, node)], labels });
  };
  for (const file of files.values()) {
    const routeVariables = new Set<string>(), conditions = new Map<string, string>(), routerObjects = new Set<ts.Node>();
    const locations = new Set(["location", "window.location", "document.location"]);
    const isPathValue = (node: ts.Node): boolean => {
      if (ts.isParenthesizedExpression(node)) return isPathValue(node.expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken && text(node.right) === "/") return isPathValue(node.left);
      // Recognize only the proved trailing-slash normalization. Arbitrary
      // replace calls or values named pathname cannot establish routing.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "replace" && node.arguments.length === 2 &&
        ["/\\/$/", "/\\/+$/"].includes(node.arguments[0]!.getText(file)) && text(node.arguments[1]) === "") return isPathValue(node.expression.expression);
      return ts.isIdentifier(node) && routeVariables.has(node.text) || ts.isPropertyAccessExpression(node) && node.name.text === "pathname" && locations.has(node.expression.getText(file));
    };
    const comparison = (node: ts.Expression): string | undefined => {
      if (ts.isParenthesizedExpression(node)) return comparison(node.expression);
      if (ts.isIdentifier(node)) return conditions.get(node.text);
      if (!ts.isBinaryExpression(node) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) return;
      return isPathValue(node.left) ? text(node.right) : isPathValue(node.right) ? text(node.left) : undefined;
    };
    const variables = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(file) === "useLocation") locations.add(node.name.text);
        if (ts.isIdentifier(node.name) && isPathValue(node.initializer)) routeVariables.add(node.name.text);
        if (ts.isArrayBindingPattern(node.name) && ts.isCallExpression(node.initializer) && node.initializer.arguments[0] && isPathValue(node.initializer.arguments[0])) {
          const first = node.name.elements[0]; if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) routeVariables.add(first.name.text);
        }
        const route = comparison(node.initializer); if (route && ts.isIdentifier(node.name)) conditions.set(node.name.text, route);
      }
      ts.forEachChild(node, variables);
    }; variables(file);
    const ownerReachable = (node: ts.Node): boolean => {
      for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
        const fn = [...functions.values()].find(fn => fn.node === parent); if (fn) return reachable.has(fn.key);
      }
      return false;
    };
    const markObjects = (node: ts.Node): void => { routerObjects.add(node); ts.forEachChild(node, markObjects); };
    const configs = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && /^(?:createBrowserRouter|createHashRouter|useRoutes)$/.test(node.expression.getText(file))) {
        const owner = node.parent;
        if (ownerReachable(node) || ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name) && references.has(named(file, owner.name.text))) {
          for (const arg of node.arguments) {
            if (ts.isIdentifier(arg)) {
              for (const statement of file.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
                if (declaration.name.getText(file) === arg.text && declaration.initializer) markObjects(declaration.initializer);
            } else markObjects(arg);
          }
        }
      }
      if (ts.isElementAccessExpression(node) && node.argumentExpression && isPathValue(node.argumentExpression) && ts.isIdentifier(node.expression) && ownerReachable(node)) {
        for (const statement of file.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
          if (declaration.name.getText(file) === node.expression.text && declaration.initializer) markObjects(declaration.initializer);
      }
      ts.forEachChild(node, configs);
    }; configs(file);
    const visit = (node: ts.Node, parentPath = ""): void => {
      if (!ownerReachable(node) && !routerObjects.has(node) && node !== file && !ts.isVariableStatement(node) && !ts.isVariableDeclarationList(node) && !ts.isVariableDeclaration(node)) {
        // Traverse declarations to find used module-scoped router configuration,
        // but never treat unrelated JSX or route metadata as implemented pages.
        if (ts.isFunctionDeclaration(node)) return;
        ts.forEachChild(node, child => visit(child, parentPath)); return;
      }
      if (ts.isIfStatement(node)) {
        const route = comparison(node.expression); if (route) {
          addRoute(file, route, node.thenStatement);
          if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) addRoute(file, "/", node.elseStatement, ["Home"]);
        }
      }
      if (ts.isConditionalExpression(node)) {
        const route = comparison(node.condition); if (route) { addRoute(file, route, node.whenTrue); if (!ts.isConditionalExpression(node.whenFalse)) addRoute(file, "/", node.whenFalse, ["Home"]); }
      }
      if (ts.isSwitchStatement(node) && isPathValue(node.expression)) for (const clause of node.caseBlock.clauses) {
        const route = ts.isCaseClause(clause) ? text(clause.expression) : "/";
        if (route) addRoute(file, route, clause, ts.isDefaultClause(clause) ? ["Home"] : []);
      }
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "Route") {
        const raw = text(attrs(node.openingElement, "path"));
        const path = raw?.startsWith("/") ? raw : posix.join(parentPath || "/", raw ?? "");
        const element = attrs(node.openingElement, "element");
        const nested = node.children.some(child => ts.isJsxElement(child) && child.openingElement.tagName.getText(file) === "Route" || ts.isJsxSelfClosingElement(child) && child.tagName.getText(file) === "Route");
        if (element) addRoute(file, path, element, [], nested);
        for (const child of node.children) visit(child, path); return;
      }
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "Route") {
        const raw = text(attrs(node, "path")), path = raw?.startsWith("/") ? raw : posix.join(parentPath || "/", raw ?? "");
        const element = attrs(node, "element"); if (element) addRoute(file, path, element);
      }
      if (ts.isObjectLiteralExpression(node) && routerObjects.has(node)) {
        const props = node.properties.filter(ts.isPropertyAssignment), path = text(props.find(prop => prop.name.getText(file).replace(/["']/g, "") === "path")?.initializer);
        const element = props.find(prop => prop.name.getText(file).replace(/["']/g, "") === "element")?.initializer;
        const actual = path?.startsWith("/") ? path : posix.join(parentPath || "/", path ?? "");
        if (element) addRoute(file, actual, element, [], props.some(property => property.name.getText(file) === "children"));
        for (const property of props) { const path = text(property.name); if (path?.startsWith("/") && /<\w/.test(property.initializer.getText(file))) addRoute(file, path, property.initializer); }
        for (const property of props) if (property.name.getText(file) === "children") visit(property.initializer, actual);
        return;
      }
      ts.forEachChild(node, child => visit(child, parentPath));
    }; visit(file);
  }
  if (!routes.some(route => route.path === "/")) for (const app of apps) {
    const home = app.children.map(child => resolveFunction(app.file, child)).find(fn => fn && equivalentPage(fn.name, "Home") && !routes.some(route => route.roots.includes(fn.key)));
    // A router with only nested routes does not implicitly implement `/`.
    // Manual routers may have an unclaimed Home component as their fallback.
    if (!routes.length || home) routes.push({ path: "/", roots: [home?.key ?? app.key], nodes: [], refs: [reference(app.file, app.node)], labels: ["Home"] });
  }
  const owners = new Map<string, Set<string>>();
  for (const route of routes) for (const root of route.roots) { const paths = owners.get(root) ?? new Set<string>(); paths.add(route.path); owners.set(root, paths); }
  return { routes: [...new Set(routes.map(route => route.path))].map(path => {
    const candidates = routes.filter(route => route.path === path), seen = new Set<string>(), names = new Set(candidates.flatMap(route => route.labels));
    const contents: string[] = [], parts: FunctionalSourcePart[] = [], omitted: ts.Node[] = [], refs = candidates.flatMap(route => route.refs); let complete = true;
    const expand = (key: string): void => {
      if (seen.has(key) || owners.has(key) && !owners.get(key)!.has(path)) return;
      seen.add(key); const fn = functions.get(key); if (!fn) return;
      names.add(fn.name); contents.push(fn.node.getText(fn.file)); parts.push({ file: fn.file, node: fn.node }); refs.push(reference(fn.file, fn.node));
      for (const child of fn.children) { const target = resolveFunction(fn.file, child); if (target) expand(target.key); else if (!/^(?:MobileNav|Tabs|Accordion|DemoDialog|DemoForm|ContactSection|CategoryFilter|ProductSearch|NewsletterSignup|CartPanel|AddToCartButton|QuantityControl|SizeSelector|ProductGallery|Button|Card|Link|NavLink|BrowserRouter|RouterProvider|Outlet|Fragment)$/.test(child)) complete = false; }
    };
    for (const candidate of candidates) { for (const root of candidate.roots) expand(root); for (const node of candidate.nodes) { contents.push(node.getText()); parts.push({ file: node.getSourceFile(), node }); } }
    // Layout-only route containers are not standalone pages, but their shared
    // navigation/controls are rendered by each descendant through Outlet.
    for (const layout of layouts.filter(layout => layout.path === "/" || path === layout.path || path.startsWith(layout.path + "/"))) {
      for (const root of layout.roots) expand(root);
      for (const node of layout.nodes) { contents.push(node.getText()); parts.push({ file: node.getSourceFile(), node }); }
    }
    // Shared header/footer contribute navigation, but not the entire App's
    // conditional page body (which would leak every capability into every route).
    for (const app of apps) for (const child of app.children.filter(name => /Header|Footer|Navbar|Navigation/.test(name))) { const target = resolveFunction(app.file, child); if (target) expand(target.key); }
    for (const app of apps) {
      const excluded = [...routes, ...layouts].flatMap(route => route.nodes).filter(node => node.getSourceFile() === app.file && node.pos >= app.node.pos && node.end <= app.node.end);
      omitted.push(...excluded); parts.push({ file: app.file, node: app.node });
      let shared = app.node.getText(app.file);
      const start = app.node.getStart(app.file);
      const spans = excluded.map(node => ({ start: node.getStart(app.file) - start, end: node.end - start })).sort((a, b) => b.start - a.start);
      for (const span of spans) shared = shared.slice(0, span.start) + " ".repeat(span.end - span.start) + shared.slice(span.end);
      contents.push(shared);
    }
    for (const label of nav.get(path) ?? []) names.add(label);
    const content = contents.join("\n"), sections = [...content.matchAll(/\bid\s*=\s*(?:["']([\w:-]+)["']|\{\s*["']([\w:-]+)["']\s*\})/g)].map(match => (match[1] ?? match[2])!);
    // Dynamic attributes, spreads and opaque components need the actual DOM.
    const sectionIdsComplete = complete && !/\bid\s*=\s*\{(?!\s*["'][\w:-]+["']\s*\})|\{\s*\.\.\./.test(content);
    const capabilityAssessments = assessFunctionalSource(parts, omitted, complete, (file, name) => {
      const imported = imports.get(file.fileName)?.get(name);
      if (imported && (imported.path === "src/sites-ui/functional" || imported.path === "src/sites-ui/sections/ContactSection")) return { kind: "MANAGED", exportName: imported.name };
      return { kind: resolveFunction(file, name) || /^(?:Link|NavLink|BrowserRouter|Routes|Route|RouterProvider|Outlet|Fragment)$/.test(name) ? "LOCAL" : "OPAQUE" };
    });
    return { path, labels: [...names], capabilities: (Object.keys(capabilityAssessments) as FunctionalCapability[]).filter(capability => capabilityAssessments[capability].state === "RECOGNIZED"), capabilityAssessments, complete,
      sourceEvidence: refs.filter((ref, index) => refs.findIndex(other => other.path === ref.path && other.line === ref.line) === index).slice(0, 8), sections, sectionIdsComplete };
  }) };
}

export function resolveFunctionalSourceContract(spec: SiteSpec, bundle: SiteCoderFileBundle): ResolvedFunctionalContract {
  const functional = spec.requirements.functional;
  const manifest = functionalSourceManifest(bundle);
  const explicit = requestedPages(spec.project.description ?? "");
  // The user declaration is authoritative even if a planner omitted a page.
  const requested = explicit.map(item => spec.requirements.pages.find(page => equivalentPage(item.name, page.name)) ?? item);
  const pages: ResolvedFunctionalContract["pages"][number][] = [];
  const fail = (message: string, requirementId: string, capability: string, route?: string): never => {
    throw new ApplicationError("GENERATION_INCOMPLETE", message, { metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "functional.completion", requirementId, capability, expectedRoute: route,
      routeMapping: { version: 1, pages, actualRoutes: manifest.routes.map(route => route.path), requirements: functional?.requirements ?? [] } } });
  };
  for (const page of requested) {
    const identityMatches = manifest.routes.filter(route => route.labels.some(label => equivalentPage(label, page.name)));
    const exact = identityMatches.filter(route => route.path === page.path);
    const matches = exact.length ? exact : identityMatches;
    if (matches.length !== 1) fail(`Required page ${page.name} has ${matches.length ? "ambiguous generated routes" : "no implemented generated route"}`, `page:${pageId(page.name)}`, "page", page.path);
    const route = matches[0]!;
    if (pages.some(existing => existing.route === route.path)) fail(`Required page ${page.name} shares another page's route without a distinct implementation`, `page:${pageId(page.name)}`, "page", page.path);
    pages.push({ id: pageId(page.name), name: page.name, route: route.path, sourceEvidence: route.sourceEvidence });
  }
  const requirements = (functional?.requirements ?? []).map(requirement => {
    let candidates = manifest.routes;
    if (requirement.target.kind === "PAGE") {
      const page = pages.find(page => page.id === requirement.target.pageId);
      candidates = page ? manifest.routes.filter(route => route.path === page.route) : manifest.routes.filter(route => route.labels.some(label => equivalentPage(label, requirement.target.pageName ?? requirement.target.pageId!)));
      if (!candidates.length) fail(`Required ${requirement.capability} page ${requirement.target.pageName} is not implemented`, requirement.id, requirement.capability, requirement.routes?.[0]);
    } else if (requirement.target.kind === "SECTION") {
      const page = pages.find(page => page.id === requirement.target.pageId);
      candidates = manifest.routes.filter(route => (!requirement.target.sectionId || !route.sectionIdsComplete || route.sections.includes(requirement.target.sectionId)) &&
        (page ? route.path === page.route : !requirement.target.pageId || route.labels.some(label => equivalentPage(label, requirement.target.pageName ?? requirement.target.pageId!))));
      if (requirement.target.sectionId && !candidates.length) fail(`Required explicit section #${requirement.target.sectionId} for ${requirement.capability} is not implemented${page ? ` on ${page.route}` : " on its required page"}`, requirement.id, requirement.capability, page?.route);
      // Semantic section labels need the rendered accessibility/heading tree.
      // Browser QA resolves them; prose is never converted to an exact DOM ID.
    }
    else if (requirement.target.kind === "ANY_PAGE") {
      const matching = candidates.filter(route => route.capabilityAssessments[requirement.capability].state !== "PROVEN_MISSING");
      if (matching.length) candidates = matching;
    }
    if (!candidates.length || candidates.every(route => route.capabilityAssessments[requirement.capability].state === "PROVEN_MISSING"))
      fail(`Required ${requirement.capability} has no implemented control on ${candidates.map(route => route.path).join(", ") || requirement.target.pageName || "its required section"}`, requirement.id, requirement.capability, candidates[0]?.path);
    const states = candidates.map(route => route.capabilityAssessments[requirement.capability]);
    const sourceAssessment = states.find(state => state.state === "UNCERTAIN") ?? states.find(state => state.state === "RECOGNIZED") ?? states[0]!;
    return { ...requirement, routes: candidates.map(route => route.path), sourceEvidence: candidates.flatMap(route => route.sourceEvidence).slice(0, 8), sourceAssessment };
  });
  return { version: 1, pages, actualRoutes: manifest.routes.map(route => route.path), requirements };
}
export function applyFunctionalSourceContract(spec: SiteSpec, contract: ResolvedFunctionalContract): SiteSpec {
  const pages = (contract.acceptancePolicy === "USABLE_WEBSITE" ? spec.requirements.pages.filter(page => contract.pages.some(item => equivalentPage(item.name, page.name))) : spec.requirements.pages).map(page => {
    const resolved = contract.pages.find(item => equivalentPage(item.name, page.name));
    return resolved ? { ...page, path: resolved.route } : page;
  });
  for (const route of contract.actualRoutes) if (!pages.some(page => page.path === route)) pages.push({ name: route === "/" ? "Home" : route.split("/").filter(Boolean).at(-1)!, path: route });
  const functional: FunctionalRequirements | undefined = spec.requirements.functional ? { ...spec.requirements.functional, requirements: contract.requirements } : undefined;
  return { ...spec, requirements: { ...spec.requirements, pages, ...(functional ? { functional } : {}) } };
}

/** Initial generation accepts a usable implementation, not a complete prompt checklist.
 * Strict resolution above remains available to template/edit tooling and tests. */
export function resolveUsableGenerationSourceContract(spec: SiteSpec, bundle: SiteCoderFileBundle): ResolvedFunctionalContract {
  const manifest = functionalSourceManifest(bundle);
  const advisories: { check: string; message: string }[] = [];
  const pages: ResolvedFunctionalContract["pages"][number][] = [];
  for (const page of requestedPages(spec.project.description ?? "")) {
    const candidates = manifest.routes.filter(route => route.labels.some(label => equivalentPage(label, page.name)));
    const route = candidates.find(route => route.path === page.path) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!route || pages.some(item => item.route === route.path)) {
      advisories.push({ check: "functional.completion", message: `Requested page ${page.name} has no uniquely recognized implementation` });
    } else pages.push({ id: page.id, name: page.name, route: route.path, sourceEvidence: route.sourceEvidence });
  }
  const requirements = (spec.requirements.functional?.requirements ?? []).flatMap(requirement => {
    const page = pages.find(page => page.id === requirement.target.pageId);
    let candidates = manifest.routes.filter(route => !requirement.target.pageId || (page ? route.path === page.route : route.labels.some(label => equivalentPage(label, requirement.target.pageName ?? requirement.target.pageId!))));
    if (requirement.target.sectionId) candidates = candidates.filter(route => !route.sectionIdsComplete || route.sections.includes(requirement.target.sectionId!));
    if (!candidates.length || candidates.every(route => route.capabilityAssessments[requirement.capability].state === "PROVEN_MISSING")) {
      advisories.push({ check: "functional.completion", message: `Requested ${requirement.capability} has no recognized control on ${requirement.target.pageName ?? "its assigned surface"}` });
      return [];
    }
    if (candidates.every(route => route.capabilityAssessments[requirement.capability].state !== "RECOGNIZED"))
      advisories.push({ check: "functional.completion", message: `Requested ${requirement.capability} uses an uncertain implementation; full requirement behavior is not an acceptance gate` });
    return [{ ...requirement, routes: candidates.map(route => route.path), sourceEvidence: candidates.flatMap(route => route.sourceEvidence).slice(0, 8) }];
  });
  return { version: 1, acceptancePolicy: "USABLE_WEBSITE", pages, actualRoutes: manifest.routes.map(route => route.path), requirements, advisories };
}
