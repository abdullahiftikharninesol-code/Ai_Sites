import ts from "typescript";
import { ApplicationError } from "../../app/errors/application-error.js";
import { functionalCapabilityContract, type FunctionalCapability } from "../../sites/generation/functional-capabilities.js";
import { functionalIntent } from "../../sites/generation/functional-intent.js";

/**
 * Deterministic, source-only checks that make a targeted edit do what was asked:
 * requested interactions must be wired React behavior (not decorative markup),
 * requested product/card fields must actually be rendered, and sections the user
 * did not mention must survive the edit. No model call, browser or network.
 */

/** Interactive families an edit can be held to through static evidence. */
export type EditBehavior = Extract<FunctionalCapability,
  "cart" | "quantity" | "size" | "gallery" | "category-filter" | "filter" | "search" | "sort" | "mobile-nav" | "tabs" | "accordion" | "dialog">;
const EDIT_BEHAVIORS: readonly EditBehavior[] = ["cart", "quantity", "size", "gallery", "category-filter", "filter", "search", "sort", "mobile-nav", "tabs", "accordion", "dialog"];

export type VisibleField = "description" | "price" | "rating" | "ingredients";

const PRESERVATION_CLAUSE = /\b(?:keep|preserve|retain|maintain|leave|without (?:changing|altering|breaking|touching)|do not (?:change|touch|modify|alter)|don't (?:change|touch|modify|alter))\b[^.!?;\n]*/gi;
const BUILD_VERB = /\b(?:add|create|implement|build|include|introduce|enable|wire|hook up|make\b[^.!?\n]{0,60}\b(?:work|working|functional|interactive|clickable|filter\w*|sort\w*|search\w*))\b/i;
const REMOVAL_INTENT = /\b(?:remove|delete|drop|hide|get rid of|take out|replace|redesign|rebuild|restructure|reorgani[sz]e|rearrange|reorder|merge|consolidate|simplify|start over|from scratch|condense|combine)\b/i;

/** Request text with preservation constraints removed: "keep the cart" is not a cart request. */
export function actionableEditText(instruction: string): string {
  return instruction.replace(PRESERVATION_CLAUSE, "");
}

/** Interactions the user explicitly asked this edit to add or make work. */
export function requestedEditBehaviors(instruction: string): readonly EditBehavior[] {
  // "a search icon" or "the cart heading" names artwork/copy, not an interaction.
  const actionable = actionableEditText(instruction)
    .replace(/\b(?:search|cart|bag|menu|filters?|tabs?|modal|dialog|gallery)\s+(?:icons?|images?|illustrations?|headings?|titles?|text|copy|labels?|placeholders?|emojis?|badges?|colou?rs?|styles?|styling)\b/gi, "");
  if (!BUILD_VERB.test(actionable)) return [];
  const { capabilities, excludedCapabilities } = functionalIntent(actionable);
  return EDIT_BEHAVIORS.filter(behavior => capabilities.includes(behavior) && !excludedCapabilities.includes(behavior));
}

const FIELD_PATTERNS: Readonly<Record<VisibleField, RegExp>> = {
  description: /\bdescriptions?\b/i,
  price: /\bpric(?:e|es|ing)\b/i,
  rating: /\bratings?\b/i,
  ingredients: /\bingredients?\b/i,
};
const DISPLAY_VERB = /\b(?:show|shows|showing|display|displays|displaying|include|includes|including|add|adds|adding|render|reveal|surface|list|visible|feature)\b/i;
/** "sort by price", "price filter" or "price range" ask for a control, not a rendered field. */
const CONTROL_CONTEXT = (word: string) => new RegExp(`\\b(?:sort|order|filter)(?:ing|ed)?\\s+(?:\\w+\\s+){0,2}by\\s+${word}|\\b${word}\\s+(?:filters?|filtering|sort\\w*|range|slider|calculator|tiers?|plans?|table)\\b`, "i");

/** Card/listing fields the user asked to be visibly rendered. */
export function requestedVisibleFields(instruction: string): readonly VisibleField[] {
  const clauses = actionableEditText(instruction).split(/[.!?;\n]+/);
  const fields: VisibleField[] = [];
  for (const [field, pattern] of Object.entries(FIELD_PATTERNS) as [VisibleField, RegExp][]) {
    if (clauses.some(clause => {
      const match = pattern.exec(clause);
      if (!match || !DISPLAY_VERB.test(clause) || REMOVAL_INTENT.test(clause)) return false;
      return !CONTROL_CONTEXT(match[0]).test(clause);
    })) fields.push(field);
  }
  return fields;
}

const SCRIPT = /\.[jt]sx?$/;
const parse = (path: string, content: string) =>
  ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const changedPaths = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) =>
  [...after.keys()].filter(path => before.get(path) !== after.get(path));

const STATE_HOOKS = new Set(["useState", "useReducer", "useSyncExternalStore", "useCart", "useProductFilter", "useToggle", "useQuantity"]);
const HANDLER_ATTRIBUTES = new Set(["onClick", "onChange", "onInput", "onSubmit", "onKeyDown", "onToggle", "onValueChange", "onSelect", "onOpenChange", "onCheckedChange"]);
const MANAGED_BEHAVIOR: Readonly<Record<string, readonly EditBehavior[]>> = {
  CategoryFilter: ["category-filter", "filter"], ProductSearch: ["search", "filter"], MobileNav: ["mobile-nav"], Tabs: ["tabs"],
  Accordion: ["accordion"], DemoDialog: ["dialog"], CartPanel: ["cart"], CartTrigger: ["cart"], AddToCartButton: ["cart"],
  QuantityControl: ["quantity"], SizeSelector: ["size"], ProductGallery: ["gallery"],
};
const MANAGED_HOOK_BEHAVIOR: Readonly<Record<string, readonly EditBehavior[]>> = {
  useProductFilter: ["category-filter", "filter", "search"], useCart: ["cart"], useQuantity: ["quantity"],
};

interface BehaviorEvidence {
  stateHooks: number;
  handlers: number;
  /** Source text of `.filter`/`.sort` calls whose result reaches rendered JSX. */
  renderedFilters: Set<string>;
  renderedSorts: Set<string>;
  managed: Map<EditBehavior, number>;
  tags: Map<string, number>;
  ariaExpanded: number;
}

/** An `onClick={() => {}}` or `onClick={() => alert("Soon")}` is not behavior. */
function inertHandler(expression: ts.Expression): boolean {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const body = expression.body;
  if (ts.isBlock(body)) {
    if (!body.statements.length) return true;
    return body.statements.every(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
      /^(?:window\.)?(?:alert|console\.\w+)$/.test(statement.expression.expression.getText()));
  }
  return ts.isCallExpression(body) && /^(?:window\.)?(?:alert|console\.\w+)$/.test(body.expression.getText());
}

/** Name of the variable/function that holds the value an expression produces, if any. */
function holderName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isJsxExpression(current)) return "<jsx>";
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

/** The calls whose `.filter(...)`/`.sort(...)` result reaches rendered JSX directly or through derived variables. */
function callsReachingJsx(file: ts.SourceFile, calls: readonly ts.Node[]): readonly ts.Node[] {
  const declarations: { name: string; text: string }[] = [];
  const jsxExpressions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push({ name: node.name.text, text: node.initializer.getText(file) });
    if (ts.isJsxExpression(node) && node.expression) jsxExpressions.push(node.expression.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  const references = (text: string, name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);
  return calls.filter(call => {
    const holder = holderName(call);
    if (holder === "<jsx>") return true;
    if (!holder) return false;
    const holders = new Set([holder]);
    for (let grew = true; grew;) {
      grew = false;
      for (const declaration of declarations)
        if (!holders.has(declaration.name) && [...holders].some(name => references(declaration.text, name))) { holders.add(declaration.name); grew = true; }
    }
    return jsxExpressions.some(text => [...holders].some(name => references(text, name)));
  });
}

function collectBehaviorEvidence(files: readonly { readonly path: string; readonly content: string }[]): BehaviorEvidence {
  const evidence: BehaviorEvidence = { stateHooks: 0, handlers: 0, renderedFilters: new Set(), renderedSorts: new Set(), managed: new Map(), tags: new Map(), ariaExpanded: 0 };
  const count = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const { path, content } of files) {
    if (!SCRIPT.test(path)) continue;
    const file = parse(path, content);
    const filters: ts.Node[] = [], sorts: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (STATE_HOOKS.has(name)) evidence.stateHooks += 1;
        for (const behavior of MANAGED_HOOK_BEHAVIOR[name] ?? []) count(evidence.managed, behavior);
        if (ts.isPropertyAccessExpression(callee) && name === "filter") filters.push(node);
        if (ts.isPropertyAccessExpression(callee) && (name === "sort" || name === "toSorted")) sorts.push(node);
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        count(evidence.tags, tag);
        for (const behavior of MANAGED_BEHAVIOR[tag] ?? []) count(evidence.managed, behavior);
      }
      if (ts.isJsxAttribute(node)) {
        const name = node.name.getText(file);
        if (name === "aria-expanded") evidence.ariaExpanded += 1;
        const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        if (HANDLER_ATTRIBUTES.has(name) && value && !inertHandler(value)) evidence.handlers += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const normalized = (node: ts.Node) => node.getText(file).replace(/\s+/g, " ");
    for (const call of callsReachingJsx(file, filters)) evidence.renderedFilters.add(normalized(call));
    for (const call of callsReachingJsx(file, sorts)) evidence.renderedSorts.add(normalized(call));
  }
  return evidence;
}

/**
 * Only what this edit added counts: pre-existing state or handlers in a touched
 * file (an existing menu toggle, say) must not vouch for a new decorative control.
 */
function behaviorSatisfied(behavior: EditBehavior, before: BehaviorEvidence, after: BehaviorEvidence): boolean {
  if ((after.managed.get(behavior) ?? 0) > (before.managed.get(behavior) ?? 0)) return true;
  const interactive = after.stateHooks > 0 && after.handlers > before.handlers;
  const added = (key: "renderedFilters" | "renderedSorts") => [...after[key]].some(text => !before[key].has(text));
  const addedTag = (tag: string) => (after.tags.get(tag) ?? 0) > (before.tags.get(tag) ?? 0);
  switch (behavior) {
    case "category-filter": case "filter": case "search": return interactive && added("renderedFilters");
    case "sort": return interactive && added("renderedSorts");
    case "accordion": return addedTag("details") || interactive;
    case "dialog": return addedTag("dialog") || interactive;
    case "mobile-nav": return interactive && after.ariaExpanded > 0;
    default: return interactive;
  }
}

const BEHAVIOR_LABELS: Readonly<Record<EditBehavior, string>> = {
  cart: "shopping cart", quantity: "quantity selector", size: "size selector", gallery: "image gallery", "category-filter": "category filter",
  filter: "filter", search: "search", sort: "sorting", "mobile-nav": "mobile menu", tabs: "tabs", accordion: "accordion", dialog: "dialog",
};

/** Requested behaviors with no wired React state/handler/render evidence in the source the edit changed. */
export function missingEditBehaviors(behaviors: readonly EditBehavior[], before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly EditBehavior[] {
  if (!behaviors.length) return [];
  const changed = changedPaths(before, after).filter(path => SCRIPT.test(path));
  let previous: BehaviorEvidence, next: BehaviorEvidence;
  try {
    previous = collectBehaviorEvidence(changed.filter(path => before.has(path)).map(path => ({ path, content: before.get(path)! })));
    next = collectBehaviorEvidence(changed.map(path => ({ path, content: after.get(path)! })));
  } catch { return []; }
  return behaviors.filter(behavior => !behaviorSatisfied(behavior, previous, next));
}

export function editBehaviorLabel(behavior: EditBehavior): string {
  return BEHAVIOR_LABELS[behavior];
}

const CUSTOM_BEHAVIOR: Readonly<Record<EditBehavior, string>> = {
  "category-filter": "hold the selected category in useState, give every option (including All) an onClick/onChange that sets it, render items.filter(matching selected) instead of the full list, mark the active option (aria-pressed or a selected class) and show an empty state.",
  filter: "keep filter values in state, derive the visible list with .filter() from that state and render the derived list.",
  search: "a controlled input whose onChange updates query state; render the list filtered by that query.",
  sort: "keep the sort key in state and render a sorted copy ([...items].sort) of the list.",
  cart: "one shared cart state (lift it to the nearest common parent or a context): add buttons update it, the header count and cart panel read it, items can be removed and the total is computed.",
  quantity: "a numeric state with decrement/increment handlers (minimum 1) whose value is shown and used.",
  size: "the selected size lives in state, options show the selected one, and the value is used by the add action.",
  gallery: "the active image index lives in state and thumbnail buttons change the large image.",
  "mobile-nav": "a menu button with aria-expanded and aria-controls toggles open state; the panel renders only when open (or via an open class) and closes when a link is chosen.",
  tabs: "selected tab state; tab buttons set it and only the selected panel renders.",
  accordion: "native <details>/<summary> or per-item open state that shows/hides the answer.",
  dialog: "open state with a trigger and a Close button (native <dialog> or a state-rendered overlay).",
};

/**
 * Edit-time behavior guidance. Generation receives the full functional contract;
 * an edit only needs the requested families, and may use the managed runtime
 * only when that site actually ships it.
 */
export function editBehaviorGuidance(behaviors: readonly EditBehavior[], managedRuntimeAvailable: boolean): string {
  if (!behaviors.length) return "";
  return [
    "REQUESTED BEHAVIOR: implement as working React behavior inside the existing components and styling, not decorative markup.",
    ...behaviors.map(behavior => {
      const managed = managedRuntimeAvailable ? functionalCapabilityContract(behavior) : "";
      return `- ${behavior}: ${CUSTOM_BEHAVIOR[behavior]}${managed ? ` Or use the managed API from "./sites-ui/functional" (path relative to src/): ${managed}` : ""}`;
    }),
    "Never use href=\"#\" placeholders, empty handlers or alert()-only actions. Style new controls, including focus-visible and selected states, with the site's existing tokens and classes.",
  ].join("\n");
}

const FIELD_STEMS: Readonly<Record<VisibleField, RegExp>> = {
  description: /desc|blurb|summary|tagline/i, price: /pric|cost|amount|currency|formatMoney/i, rating: /rating|stars|review/i, ingredients: /ingredient/i,
};
const NON_VISIBLE_ATTRIBUTES = /^(?:key|className|class|id|style|href|src|alt|title|role|name|htmlFor|type|value|aria-[\w-]+|data-[\w-]+|on[A-Z]\w*)$/;

/** Whether changed JSX renders the field, or changed CSS reveals/styles an element named for it. */
function fieldRendered(field: VisibleField, files: readonly { readonly path: string; readonly content: string }[], before: ReadonlyMap<string, string>): boolean {
  const stem = FIELD_STEMS[field];
  for (const { path, content } of files) {
    if (path.endsWith(".css")) {
      const previous = before.get(path) ?? "";
      const selectors = (css: string) => new Set([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => stem.test(selector!)).map(([, selector, body]) => `${selector!.trim()}{${body!.trim()}}`));
      const old = selectors(previous);
      if ([...selectors(content)].some(rule => !old.has(rule))) return true;
      continue;
    }
    if (!SCRIPT.test(path)) continue;
    let found = false;
    const file = parse(path, content);
    // Copy written straight into JSX ("Gentle gel cleanser for daily use.") is a visible description too.
    const previousTexts = new Set<string>();
    if (field === "description" || field === "ingredients") {
      const collect = (node: ts.Node): void => { if (ts.isJsxText(node)) previousTexts.add(node.text.trim()); ts.forEachChild(node, collect); };
      try { collect(parse(path, before.get(path) ?? "")); } catch { /* unparsable previous source: compare against nothing */ }
    }
    const visit = (node: ts.Node): void => {
      if (found) return;
      if ((field === "description" || field === "ingredients") && ts.isJsxText(node)) {
        const text = node.text.trim();
        if (text.length >= 20 && /\s/.test(text) && !previousTexts.has(text)) found = true;
      }
      if (ts.isJsxExpression(node) && node.expression) {
        const attribute = ts.isJsxAttribute(node.parent) ? node.parent.name.getText(file) : undefined;
        if ((!attribute || !NON_VISIBLE_ATTRIBUTES.test(attribute)) && stem.test(node.expression.getText(file))) found = true;
      }
      if (field === "price" && ts.isJsxText(node) && /[$€£¥₹]\s?\d|\d\s?(?:USD|EUR|GBP|PKR|Rs)\b/.test(node.text)) found = true;
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
        const className = node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(file) === "className");
        const text = className?.initializer && ts.isStringLiteral(className.initializer) ? className.initializer.text : "";
        if (text && stem.test(text) && ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent) &&
          node.parent.children.some(child => (ts.isJsxText(child) && child.text.trim().length > 0) || ts.isJsxExpression(child))) found = true;
      }
      ts.forEachChild(node, visit);
    };
    try { visit(file); } catch { return true; }
    if (found) return true;
  }
  return false;
}

/** Requested fields that no changed source renders. */
export function missingVisibleFields(fields: readonly VisibleField[], before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly VisibleField[] {
  if (!fields.length) return [];
  const changed = changedPaths(before, after).map(path => ({ path, content: after.get(path)! }));
  return fields.filter(field => !fieldRendered(field, changed, before));
}

const ROUTING_TAGS = new Set(["Fragment", "React.Fragment", "StrictMode", "Suspense", "Routes", "Route", "BrowserRouter", "HashRouter", "MemoryRouter", "Router", "Outlet", "Link", "NavLink", "Navigate", "Toaster", "ErrorBoundary"]);
const LANDMARK_TAGS = new Set(["section", "header", "footer", "nav", "main", "aside", "article"]);
const ENTRY = /(?:^|\/)App\.[jt]sx$/;

interface Landmarks { readonly ids: Set<string>; readonly components: Set<string> }

function landmarks(files: ReadonlyMap<string, string>, componentScope: "entry" | "all"): Landmarks {
  const ids = new Set<string>(), components = new Set<string>();
  for (const [path, content] of files) {
    if (!/\.[jt]sx$/.test(path)) continue;
    const collectComponents = componentScope === "all" || ENTRY.test(path);
    const file = parse(path, content);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        if (LANDMARK_TAGS.has(tag)) {
          const id = node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(file) === "id");
          if (id?.initializer && ts.isStringLiteral(id.initializer) && id.initializer.text) ids.add(id.initializer.text);
        }
        if (collectComponents && /^[A-Z]/.test(tag) && !tag.includes(".") && !ROUTING_TAGS.has(tag)) components.add(tag);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { ids, components };
}

const words = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3);

/**
 * Rejects an edit that silently drops a page section (landmark id) or a section
 * component composed by the entry file when the user neither named it nor asked
 * to remove, replace or restructure anything. The saved website stays unchanged.
 */
export function validateEditPreservation(instruction: string, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
  if (REMOVAL_INTENT.test(actionableEditText(instruction))) return;
  let previous: Landmarks, next: Landmarks;
  try { previous = landmarks(before, "entry"); next = landmarks(after, "all"); } catch { return; }
  const mentioned = new Set(words(instruction));
  const unmentioned = (name: string) => !words(name).some(word => mentioned.has(word) || mentioned.has(`${word}s`) || mentioned.has(word.replace(/s$/, "")));
  const missing = [
    ...[...previous.ids].filter(id => !next.ids.has(id) && unmentioned(id)).map(id => `#${id}`),
    ...[...previous.components].filter(name => !next.components.has(name) && unmentioned(name)).map(name => `<${name}>`),
  ];
  if (missing.length)
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE",
      `The edit removed website sections you did not ask to change (${missing.slice(0, 5).join(", ")}). Your saved website is unchanged.`, {
        metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "edit.preservation", reason: "UNRELATED_SECTION_REMOVED", missing, editOutcome: "NOT_APPLIED" },
      });
}
