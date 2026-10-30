import type { FunctionalCapability, FunctionalRequirements } from "./functional-capabilities.js";
import type { SitePageSpec, SiteSpec } from "../domain/site-spec.js";
import { equivalentPage, pageFamily, pageId, requestedPages } from "./requested-pages.js";
import type { FunctionalSourceAssessment } from "./functional-source-evidence.js";
import { functionalIntent } from "./functional-intent.js";

export interface FunctionalSourceReference { readonly path: string; readonly line: number }
export interface FunctionalRequirement {
  readonly id: string;
  readonly capability: FunctionalCapability;
  readonly target: { readonly kind: "PAGE" | "SECTION" | "SITE" | "ANY_PAGE"; readonly pageId?: string; readonly pageName?: string; readonly sectionId?: string; readonly sectionName?: string };
  readonly expectedBehavior: string;
  readonly mandatory: true;
  readonly validation: "BROWSER_BEHAVIOR";
  readonly routes?: readonly string[];
  readonly sourceEvidence?: readonly FunctionalSourceReference[];
  readonly sourceAssessment?: FunctionalSourceAssessment;
}
export interface ResolvedFunctionalContract {
  readonly version: 1;
  readonly acceptancePolicy?: "USABLE_WEBSITE";
  readonly advisories?: readonly { readonly check: string; readonly message: string }[];
  readonly pages: readonly { readonly id: string; readonly name: string; readonly route: string; readonly sourceEvidence: readonly FunctionalSourceReference[] }[];
  readonly actualRoutes: readonly string[];
  readonly requirements: readonly FunctionalRequirement[];
}
export const functionalBehaviors: Readonly<Record<FunctionalCapability, string>> = {
  "category-filter": "Select categories to change visible items; selected state is observable; All restores the complete collection.",
  tabs: "Selecting another service tab changes the selected state and visible panel.",
  accordion: "Expand and collapse meaningful answer content.", dialog: "Open project details and close the modal.",
  form: "Reject invalid email; valid demo submission shows honest local confirmation without remote writes.",
  "mobile-nav": "Open the shared mobile menu, follow real page destinations and close it.",
  search: "Changing the search query changes visible matching results.", newsletter: "Validate email and show honest demo-only signup feedback.",
  cart: "Adding the selected product updates the cart quantity; the cart opens with the actual added item.",
  quantity: "Quantity controls update the selected positive quantity.", size: "Selecting a size updates the actual selected value.",
  gallery: "Selecting a thumbnail changes the active product image.", "product-navigation": "Product navigation opens the matching implemented product page.",
};

type SectionBinding = { readonly sectionId: string } | { readonly sectionName: string; readonly exactLabel: boolean };
/** A location must directly qualify this capability, in the same affirmative
 * clause. Ordinary section names describe UI; only a literal ID names a DOM ID. */
function sectionBindings(passages: readonly string[], capability: RegExp): readonly SectionBinding[] {
  const result = new Map<string, SectionBinding>();
  for (const passage of passages) for (const clause of passage.split(/[\n.;!?]+/)) {
    const feature = capability.exec(clause);
    if (!feature || /\b(?:do not|don't|never|without|omit|exclude)\b/i.test(clause)) continue;
    for (const location of clause.matchAll(/\b(?:in|inside|within)\s+(?:(?:the|a|an)\s+)?/gi)) {
      const tail = clause.slice(location.index + location[0].length);
      const id = /^(?:(?:section|region)\s+)?#([a-z][\w:-]*)\b/i.exec(tail)
        ?? /^(?:section|region)\s+(?:with\s+)?id\s*(?:=|:)?\s*["'`]?([a-z][\w:-]*)\b/i.exec(tail);
      const exactName = /^(?:section|region)\s+(?:named|called|labelled|labeled)\s+["'`]([^"'`]{1,80})["'`]/i.exec(tail)
        ?? /^["'`]([^"'`]{1,80})["'`]\s+(?:section|region)\b/i.exec(tail);
      const name = exactName ?? /^([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})\s+(?:section|region)\b/i.exec(tail);
      const match = id ?? name; if (!match) continue;
      // Do not attach another feature's placement through "and", "beside", etc.
      if (feature.index < location.index) {
        const bridge = clause.slice(feature.index + feature[0].length, location.index);
        if (!/^s?\s*(?:(?:is|are|will|must|should|be|go|appear|located|placed|displayed|rendered|shown|directly|only|exclusively)\s+)*$/i.test(bridge)) continue;
      } else {
        if (!/^\s*[-*\d.)]*\s*$/.test(clause.slice(0, location.index))) continue;
        const bridge = clause.slice(location.index + location[0].length + match[0].length, feature.index);
        if (!/^[\s,:-]*(?:(?:add|include|place|put|show|render|a|an|the|working|validated|professional)\s+)*$/i.test(bridge)) continue;
      }
      if (id) result.set(`id:${id[1]!}`, { sectionId: id[1]! });
      else result.set(`name:${pageId(name![1]!)}`, { sectionName: name![1]!, exactLabel: !!exactName });
    }
  }
  return [...result.values()];
}

/** Deterministic ownership; prose outside a page block never inherits the last page. */
export function assignFunctionalRequirements(prompt: string, capabilities: readonly FunctionalCapability[]): readonly FunctionalRequirement[] {
  const pages = requestedPages(prompt);
  // Page-local instructions must not become constraints on a different page.
  let shared = prompt;
  for (const page of [...pages].filter(page => page.start >= 0).sort((a, b) => b.start - a.start)) shared = shared.slice(0, page.start) + " ".repeat(page.end - page.start) + shared.slice(page.end);
  const capabilityPattern: Record<FunctionalCapability, RegExp> = {
    "category-filter": /(?:categor(?:y|ies).*?filter|filter.*?categor|portfolio filter)/i,
    tabs: /\btabs\b/i, accordion: /\baccordion/i, dialog: /\b(?:modal|dialog|project details)\b/i,
    form: /\b(?:contact|inquiry|feedback) form|form.*valid/i, "mobile-nav": /mobile (?:menu|nav)/i,
    search: /\bsearch/i, newsletter: /\bnewsletter/i, cart: /\bcart\b|add to bag/i,
    quantity: /\bquantity\b/i, size: /\b(?:size|sizes)\b/i, gallery: /\bgallery\b/i, "product-navigation": /product[- ]detail/i,
  };
  const result: FunctionalRequirement[] = [];
  for (const capability of capabilities) {
    const owners = pages.filter(page => {
      if (page.start < 0) return false;
      const intent = functionalIntent(prompt.slice(page.start, page.end));
      // Reuse the same vocabulary as requirement extraction (e.g. expandable
      // questions), rather than losing ownership through a narrower regex.
      return intent.capabilities.includes(capability) || capabilityPattern[capability].test(intent.affirmative);
    });
    const defaultFamily = capability === "form" ? "contact" : capability === "tabs" ? "services" : capability === "category-filter" || capability === "dialog" ? "portfolio"
      : ["size", "quantity", "gallery", "cart", "product-navigation"].includes(capability) ? "product" : capability === "accordion" ? "faq" : "home";
    const preferred = pages.find(page => pageFamily(page.name) === defaultFamily) ?? (["accordion", "category-filter"].includes(capability) ? pages.find(page => pageFamily(page.name) === "home") : undefined);
    const targets = owners.length ? owners : preferred ? [preferred] : [];
    if (capability === "mobile-nav") {
      result.push({ id: "functional:mobile-nav:site", capability, target: { kind: "SITE" }, expectedBehavior: functionalBehaviors[capability], mandatory: true, validation: "BROWSER_BEHAVIOR" });
    } else {
      for (const page of targets.length ? targets : [undefined]) {
        const passages = [page && page.start >= 0 ? prompt.slice(page.start, page.end) : "", ...(targets.length <= 1 ? [shared] : [])];
        const sections = sectionBindings(passages, capabilityPattern[capability]);
        const identity = page ? { pageId: page.id, pageName: page.name } : {};
        const base = `functional:${capability}:${page?.id ?? "any"}`;
        const exact = sections.filter(section => "sectionId" in section || section.exactLabel);
        if (exact.length) for (const section of exact) result.push({ id: `${base}:${"sectionId" in section ? "id-" + section.sectionId : "section-" + pageId(section.sectionName)}`, capability,
          target: { kind: "SECTION", ...identity, ...("sectionId" in section ? { sectionId: section.sectionId } : { sectionName: section.sectionName }) }, expectedBehavior: functionalBehaviors[capability], mandatory: true, validation: "BROWSER_BEHAVIOR" });
        // Unquoted descriptive placement guides the generator without inventing
        // either an exact DOM ID or an exact visible heading as a QA prerequisite.
        else result.push({ id: base, capability, target: { kind: page ? "PAGE" : "ANY_PAGE", ...identity,
          ...(sections.length === 1 && "sectionName" in sections[0]! ? { sectionName: sections[0].sectionName } : {}) },
          expectedBehavior: functionalBehaviors[capability], mandatory: true, validation: "BROWSER_BEHAVIOR" });
      }
    }
  }
  return result;
}

export function plannedFunctionalRequirements(requirements: FunctionalRequirements, pages: readonly SitePageSpec[]): FunctionalRequirements {
  if (!requirements.requirements) return requirements;
  return { ...requirements, requirements: requirements.requirements?.map(requirement => {
    const page = requirement.target.pageId ? pages.find(page => equivalentPage(page.name, requirement.target.pageName ?? requirement.target.pageId!)) : undefined;
    return { ...requirement, ...(page ? { routes: [page.path] } : {}) };
  }) };
}
export function functionalRouteGuidance(requirements: FunctionalRequirements): string {
  return (requirements.requirements ?? []).map(requirement => `PAGE: ${requirement.target.pageName ?? (requirement.target.kind === "SITE" ? "shared site navigation" : "appropriate implemented page")}${requirement.routes?.length ? ` [${requirement.routes.join(", ")}]` : ""}${requirement.target.kind === "SECTION" ? `; SECTION: ${requirement.target.sectionId ? `literal id=${JSON.stringify(requirement.target.sectionId)}` : `accessible heading/label ${JSON.stringify(requirement.target.sectionName)}`}` : requirement.target.sectionName ? `; LOCATION INTENT: ${JSON.stringify(requirement.target.sectionName)} (descriptive, not a literal ID or heading)` : ""}; REQUIRED: ${requirement.capability}; BEHAVIOR: ${requirement.expectedBehavior}`).join("\n");
}
export function withFunctionalContract(spec: SiteSpec, requirements: FunctionalRequirements): SiteSpec {
  return { ...spec, requirements: { ...spec.requirements, functional: plannedFunctionalRequirements(requirements, spec.requirements.pages) } };
}
