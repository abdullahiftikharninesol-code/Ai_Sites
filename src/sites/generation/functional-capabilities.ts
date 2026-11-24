import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteSpec } from "../domain/site-spec.js";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import ts from "typescript";
import { posix } from "node:path";
import { assignFunctionalRequirements, functionalRouteGuidance, type FunctionalRequirement } from "./functional-route-contract.js";
import { functionalIntent } from "./functional-intent.js";

export type FunctionalCapability = "cart" | "quantity" | "size" | "gallery" | "category-filter" | "product-navigation" |
  "mobile-nav" | "tabs" | "accordion" | "dialog" | "search" | "form" | "newsletter" |
  "sort" | "filter" | "calculator" | "multi-step" | "comparison";
/**
 * Behavior families recognized for verification only. They never add text to
 * the generation or planning prompt (no token change): requests that mention
 * them are generated exactly as before, and QA asserts the requested behavior
 * only where the generated source structurally implements it.
 */
export const VERIFICATION_ONLY_CAPABILITIES: ReadonlySet<FunctionalCapability> = new Set(["sort", "filter", "calculator", "multi-step", "comparison"]);
const guided = (capability: FunctionalCapability) => !VERIFICATION_ONLY_CAPABILITIES.has(capability);
export interface FunctionalRequirements {
  readonly version: 1;
  readonly capabilities: readonly FunctionalCapability[];
  readonly optionalCapabilities?: readonly FunctionalCapability[];
  readonly excludedCapabilities?: readonly FunctionalCapability[];
  readonly backendRequired: boolean;
  readonly unsupportedTransactions: boolean;
  /** The request's own words that asked for real backend behavior (for an actionable message). */
  readonly backendPhrases?: readonly string[];
  readonly requirements?: readonly FunctionalRequirement[];
  readonly conflictingCapabilities?: readonly FunctionalCapability[];
}
const TRANSACTION_PATTERN = /\b(?:(?:real|live)\s+(?:payments?|payment processing|checkout|bookings?|reservations?)|process\s+(?:(?:live|real)\s+)?payments|charge\s+(?:credit\s+)?cards|persistent bookings|send (?:actual|real) emails)\b/gi;
const BACKEND_PATTERN = /\b(?:real backend|persistent submissions|real account creation)\b/gi;
/** Negation directly governing a phrase inside its own clause ("demo checkout (no real payments)"). */
const NEGATED_BEFORE = /\b(?:no|not|without|never|instead of|rather than|excluding|except|avoid(?:ing)?|no need (?:to|for))\b|n't\b/i;
const NEGATED_AFTER = /^\s*(?:(?:is|are|isn't|aren't)\s+)?(?:not\s+(?:required|needed|necessary|wanted)|unnecessary|not needed|out of scope)\b/i;
// "or" is not a boundary: negation distributes over it ("without real emails or a real backend").
const CLAUSE_BOUNDARY = /[.;:!?\n()[\],]|\b(?:and|but)\b/gi;
/** Phrases the request actually asks for; a negated mention is not a request. */
function affirmedPhrases(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    let start = 0;
    for (const boundary of text.slice(0, match.index).matchAll(CLAUSE_BOUNDARY)) start = boundary.index + boundary[0].length;
    const before = text.slice(start, match.index).trim().split(/\s+/).slice(-6).join(" ");
    const afterClause = text.slice(match.index + match[0].length).split(CLAUSE_BOUNDARY)[0] ?? "";
    if (NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(afterClause)) continue;
    found.push(match[0].toLowerCase());
  }
  return found;
}
function unsupportedBackendMessage(phrases: readonly string[] | undefined): string {
  const asked = phrases?.length ? ` ("${phrases.join('", "')}")` : "";
  return `Your request asks for real backend behavior${asked}, which has no configured implementation, so a frontend-only website cannot honestly provide it. ` +
    'Remove that requirement, or ask for a demo version instead (for example "a demo checkout with no real payments").';
}

/** Explicit behavior only; visual adjectives/template controls never add requirements. */
export function functionalRequirements(prompt: string): FunctionalRequirements {
  const { affirmative, capabilities, optionalCapabilities, excludedCapabilities, conflicts } = functionalIntent(prompt);
  const transactions = affirmedPhrases(affirmative, TRANSACTION_PATTERN), backend = affirmedPhrases(affirmative, BACKEND_PATTERN);
  const unsupportedTransactions = transactions.length > 0;
  return Object.freeze({ version: 1, capabilities: Object.freeze(capabilities), requirements: Object.freeze(assignFunctionalRequirements(prompt, capabilities)),
    ...(conflicts.length ? { conflictingCapabilities: Object.freeze(conflicts) } : {}),
    ...(optionalCapabilities.length ? { optionalCapabilities: Object.freeze(optionalCapabilities) } : {}),
    ...(excludedCapabilities.length ? { excludedCapabilities: Object.freeze(excludedCapabilities) } : {}),
    backendRequired: unsupportedTransactions || backend.length > 0,
    unsupportedTransactions, ...(transactions.length || backend.length ? { backendPhrases: Object.freeze([...new Set([...transactions, ...backend])].slice(0, 3)) } : {}) });
}
/** Plain-language names for features a user can recognize in their own prompt. */
const CAPABILITY_LABELS: Readonly<Record<FunctionalCapability, string>> = {
  cart: "shopping cart", quantity: "quantity selector", size: "size selector", gallery: "image gallery", "category-filter": "category filter",
  "product-navigation": "product detail pages", "mobile-nav": "mobile menu", tabs: "tabs", accordion: "accordion / FAQ", dialog: "pop-up dialog",
  search: "search", form: "contact form", newsletter: "newsletter signup", sort: "sorting", filter: "filters", calculator: "calculator",
  "multi-step": "multi-step form", comparison: "comparison tool",
};
/** What each unsupported real-backend phrase means for the user. */
function unsupportedFeatureLabel(phrase: string): string {
  if (/payment|checkout|charge/i.test(phrase)) return "Real payment processing (charging actual money)";
  if (/booking|reservation/i.test(phrase)) return "Real bookings or reservations that are saved and confirmed";
  if (/email/i.test(phrase)) return "Sending real emails";
  if (/account/i.test(phrase)) return "Real user accounts and sign-up";
  return "A real backend that stores submitted data";
}
/**
 * Request-review failures carry structured, client-safe metadata so the UI can
 * explain exactly what to change in the prompt instead of a generic failure.
 */
export function assertFunctionalRequestConsistency(requirements: FunctionalRequirements): void {
  const conflicts = requirements.conflictingCapabilities ?? [];
  if (conflicts.length)
    throw new ApplicationError("UNSUPPORTED_SITE_REQUIREMENT", "Conflicting include/exclude instructions for: " + conflicts.join(", "), {
      metadata: { failureStage: "REQUEST_REVIEW", requestIssue: "CONFLICTING_INSTRUCTIONS", conflictingFeatures: conflicts.map(id => CAPABILITY_LABELS[id]) },
    });
}
export function assertFunctionalBackendSupport(requirements: FunctionalRequirements, spec?: SiteSpec): void {
  assertFunctionalRequestConsistency(requirements);
  if (requirements.unsupportedTransactions || (requirements.backendRequired && !spec?.runtime?.enabled && !spec?.auth?.authRequired))
    throw new ApplicationError("UNSUPPORTED_SITE_REQUIREMENT", unsupportedBackendMessage(requirements.backendPhrases), {
      metadata: { failureStage: "REQUEST_REVIEW", requestIssue: "UNSUPPORTED_FEATURES",
        unsupportedFeatures: [...new Set((requirements.backendPhrases?.length ? requirements.backendPhrases : ["real backend"]).map(unsupportedFeatureLabel))],
        matchedPhrases: requirements.backendPhrases ?? [] },
    });
}
/** A configured backend does not make a known demo-only form a real submission. */
export function validateFunctionalBackendBundle(bundle: SiteCoderFileBundle, requirements: FunctionalRequirements): void {
  if (!requirements.backendRequired) return;
  const forbidden = new Set<string>([
    ...(requirements.capabilities.includes("form") ? ["DemoForm", "ContactSection"] : []),
    ...(requirements.capabilities.includes("newsletter") ? ["NewsletterSignup"] : []),
  ]);
  if (!forbidden.size) return;
  for (const file of bundle.files) {
    if (!/\.[jt]sx$/.test(file.path)) continue;
    const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const demoNames = new Set<string>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const path = posix.normalize(posix.join(posix.dirname(file.path), statement.moduleSpecifier.text)).replace(/\.tsx$/, "");
      if (path !== "src/sites-ui/functional" && path !== "src/sites-ui/sections/ContactSection") continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
        if (forbidden.has((binding.propertyName ?? binding.name).text)) demoNames.add(binding.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) for (const name of forbidden) demoNames.add(`${bindings.name.text}.${name}`);
    }
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && demoNames.has(node.tagName.getText(ast)))
        throw new ApplicationError("GENERATION_INCOMPLETE", `${file.path}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1} uses a demo-only form for required real backend behavior`,
          { metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "functional.backend" } });
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
}
const contracts: Record<FunctionalCapability, string> = {
  cart: 'useCart(): {items,count,isOpen,add(product,quantity=1,size=""),openCart(),closeCart(),remove(key)}. Product={id,name,price,image?}; CartTrigger/CartPanel share this controller; AddToCartButton accepts product,quantity,size. Demo cart survives same-tab navigation, not a backend.',
  quantity: "QuantityControl: value:number,onChange(value). useQuantity(initial=1) returns {quantity,setQuantity,increase,decrease}; minimum 1.",
  size: 'SizeSelector: options:string[],value:string,onChange(value); store selection with useState. Pass size to cart.add.',
  gallery: 'ProductGallery: images:{src,alt}[]; thumbnail buttons change the active image. Supply local resolved images/placeholders.',
  "category-filter": 'useProductFilter(products:{id,name,category}[]) returns {query,setQuery,category,setCategory,visible,categories}; render visible, not the unfiltered list. CategoryFilter: options:string[],value,onChange.',
  "product-navigation": "Product links must reach declared product routes; carry product identity in a query/path and render the matching product.",
  "mobile-nav": 'MobileNav: items:{label,href}[],className?; real open/close state. All destinations must exist.',
  tabs: 'Tabs: items:{id,label,content:ReactNode}[]; real selected state and visible tab panel.',
  accordion: 'Accordion: items:{id,label,content:ReactNode}[]; native details expand/collapse.',
  dialog: 'DemoDialog: label:string,children:ReactNode; native modal opens/closes with a real trigger and Close button.',
  search: 'ProductSearch: products:{id,name,category?}[]; live local query filters visible results. Or useProductFilter for a custom layout.',
  form: 'DemoForm: label?="Contact",className?; required name/email/message, native validation, visible honest demo-only confirmation; no remote send or persistence.',
  newsletter: 'NewsletterSignup: className?; required valid email and visible demo-only confirmation. Never claim actual subscription, email delivery, account creation or payment.',
  // Verification-only families: never sent to the model.
  sort: "", filter: "", calculator: "", "multi-step": "", comparison: "",
};
/** The managed-runtime API line for one guided capability ("" for verification-only families). */
export function functionalCapabilityContract(capability: FunctionalCapability): string {
  return contracts[capability];
}
export function functionalGenerationContract(input: FunctionalRequirements): string {
  // Verification-only families are filtered out so the prompt is byte-identical to before.
  const optionalCapabilities = input.optionalCapabilities?.filter(guided), excludedCapabilities = input.excludedCapabilities?.filter(guided);
  const requirements: FunctionalRequirements = { ...input, capabilities: input.capabilities.filter(guided),
    ...(input.requirements ? { requirements: input.requirements.filter(requirement => guided(requirement.capability)) } : {}) };
  const boundaries = [optionalCapabilities?.length ? `Optional suggestions, not mandatory completion gates: ${optionalCapabilities.join(", ")}. If shown, controls must work.` : "",
    excludedCapabilities?.length ? `Explicitly excluded capabilities: ${excludedCapabilities.join(", ")}. Do not add them.` : ""].filter(Boolean);
  if (!requirements.capabilities.length) return boundaries.join("\n");
  return ["Functional capability contract v1 (mandatory requested behavior):", ...boundaries,
    "Prefer verified named imports from ./sites-ui/functional; style with className/CSS. Equivalent custom behavior is allowed. No empty/alert-only callbacks or fake destinations.",
    "PageContent({children,className?}) renders main; SiteLink accepts standard anchor props including onClick. Use useEffect with cleanup for listeners. Custom tabs: aria-selected, aria-controls, real tabpanel. Mobile menus: aria-expanded, linked navigation panel. Never add empty semantic markers.",
    ...requirements.capabilities.map(id => `${id}: ${contracts[id]}`),
    functionalRouteGuidance(requirements),
    requirements.backendRequired ? "Real backend requested: demo-only forms cannot fulfill that requirement. Use the existing configured runtime contract, or fail clearly." : "Frontend mock data only; show honest demo feedback, never fake remote success.",
    requirements.capabilities.includes("cart") ? 'Safe repair opt-in: only a Cart trigger wired to const cart=useCart() may use data-sites-action="cart.open"; render CartPanel as its actual destination.' : "",
  ].filter(Boolean).join("\n");
}
