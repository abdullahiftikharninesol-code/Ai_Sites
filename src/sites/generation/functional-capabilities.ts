import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteSpec } from "../domain/site-spec.js";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import ts from "typescript";
import { posix } from "node:path";
import { assignFunctionalRequirements, functionalRouteGuidance, type FunctionalRequirement } from "./functional-route-contract.js";
import { functionalIntent } from "./functional-intent.js";

export type FunctionalCapability = "cart" | "quantity" | "size" | "gallery" | "category-filter" | "product-navigation" |
  "mobile-nav" | "tabs" | "accordion" | "dialog" | "search" | "form" | "newsletter";
export interface FunctionalRequirements {
  readonly version: 1;
  readonly capabilities: readonly FunctionalCapability[];
  readonly backendRequired: boolean;
  readonly unsupportedTransactions: boolean;
  readonly requirements?: readonly FunctionalRequirement[];
  readonly conflictingCapabilities?: readonly FunctionalCapability[];
}
/** Explicit behavior only; visual adjectives/template controls never add requirements. */
export function functionalRequirements(prompt: string): FunctionalRequirements {
  const { affirmative, capabilities, conflicts } = functionalIntent(prompt);
  return Object.freeze({ version: 1, capabilities: Object.freeze(capabilities), requirements: Object.freeze(assignFunctionalRequirements(prompt, capabilities)),
    ...(conflicts.length ? { conflictingCapabilities: Object.freeze(conflicts) } : {}),
    backendRequired: /\b(?:real backend|persistent submissions|send (?:actual|real) emails|real account creation|real payments|process payments|charge cards|persistent bookings)\b/i.test(affirmative),
    unsupportedTransactions: /\b(?:real payments|process payments|charge cards|persistent bookings|send (?:actual|real) emails)\b/i.test(affirmative) });
}
export function assertFunctionalRequestConsistency(requirements: FunctionalRequirements): void {
  if (requirements.conflictingCapabilities?.length)
    throw new ApplicationError("UNSUPPORTED_SITE_REQUIREMENT", "Conflicting include/exclude instructions for: " + requirements.conflictingCapabilities.join(", "));
}
export function assertFunctionalBackendSupport(requirements: FunctionalRequirements, spec?: SiteSpec): void {
  assertFunctionalRequestConsistency(requirements);
  if (requirements.unsupportedTransactions || (requirements.backendRequired && !spec?.runtime?.enabled && !spec?.auth?.authRequired))
    throw new ApplicationError("UNSUPPORTED_SITE_REQUIREMENT", "Requested real backend behavior has no configured implementation; frontend mock success cannot satisfy it");
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
};
export function functionalGenerationContract(requirements: FunctionalRequirements): string {
  if (!requirements.capabilities.length) return "";
  return ["Functional capability contract v1 (mandatory requested behavior):",
    "Prefer verified named imports from ./sites-ui/functional; style with className/CSS. Equivalent custom behavior is allowed. No empty/alert-only callbacks or fake destinations.",
    "PageContent({children,className?}) renders main; SiteLink accepts standard anchor props including onClick. Use useEffect with cleanup for listeners. Custom tabs: aria-selected, aria-controls, real tabpanel. Mobile menus: aria-expanded, linked navigation panel. Never add empty semantic markers.",
    ...requirements.capabilities.map(id => `${id}: ${contracts[id]}`),
    functionalRouteGuidance(requirements),
    requirements.backendRequired ? "Real backend requested: demo-only forms cannot fulfill that requirement. Use the existing configured runtime contract, or fail clearly." : "Frontend mock data only; show honest demo feedback, never fake remote success.",
    requirements.capabilities.includes("cart") ? 'Safe repair opt-in: only a Cart trigger wired to const cart=useCart() may use data-sites-action="cart.open"; render CartPanel as its actual destination.' : "",
  ].filter(Boolean).join("\n");
}
