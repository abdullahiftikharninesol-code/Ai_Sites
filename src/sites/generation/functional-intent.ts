import type { FunctionalCapability } from "./functional-capabilities.js";

export const functionalPatterns: readonly [FunctionalCapability, RegExp][] = [
  ["cart", /\b(?:add to (?:cart|bag)|shopping (?:cart|bag)|cart (?:view|drawer|state|button|panel))\b/i],
  ["quantity", /\bquantity\b/i], ["size", /\b(?:product sizes?|size selection|size selector|sizes)\b/i],
  ["gallery", /\b(?:(?:selectable|interactive|product) gallery|gallery (?:selection|placeholders?)|gallery.*thumbnails)\b/i],
  ["category-filter", /\b(?:categor(?:y|ies) filter(?:s|ing)?|filter.*categor(?:y|ies))\b/i],
  ["product-navigation", /\bproduct[- ]detail(?:s)?\b/i], ["mobile-nav", /\bmobile (?:menu|nav(?:igation)?)\b/i],
  ["tabs", /\btabs\b/i], ["accordion", /\baccordions?\b|\b(?:expandable|collapsible) (?:FAQs?|questions?|answers?)\b/i],
  ["dialog", /\b(?:modal|dialog)\b/i], ["search", /\b(?:search|searchable)\b/i],
  ["form", /\b(?:contact|inquiry|feedback) form\b/i], ["newsletter", /\bnewsletter\b/i],
];

/** Scan all clauses, not a truncated prefix. Markdown bullets do not negate negation. */
export function functionalIntent(prompt: string): {
  readonly affirmative: string;
  readonly capabilities: readonly FunctionalCapability[];
  readonly optionalCapabilities: readonly FunctionalCapability[];
  readonly excludedCapabilities: readonly FunctionalCapability[];
  readonly conflicts: readonly FunctionalCapability[];
} {
  const clauses = prompt.split(/[.;\n]|\bbut\b|\band\s+(?=(?:add|include|must|do not|don't|never|no|without|optionally)\b)/i).map(clause => clause.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s*)/, "").replace(/\*\*|__/g, "").trim());
  const protection = /^(?:do not|don't|never)\s+(?:remove|skip|break|omit|disable|exclude)\b/i;
  const exclusion = /^(?:(?:no|without|omit|exclude)\s+|(?:do not|don't|never)\s+(?:include|add|show|render|implement|create|build|use|provide|display|enable|support|have|send|charge|process)\s+)/i;
  const negative = (clause: string) => !protection.test(clause) && exclusion.test(clause);
  const positive = clauses.filter(clause => !negative(clause));
  const optional = /\b(?:optionally|optional|if possible|if feasible|nice (?:to have|if)|would be nice|could (?:also )?(?:add|include)|maybe (?:add|include))\b/i;
  const suggestions: string[] = [];
  const mandatory = positive.flatMap(clause => {
    let optionalList = false;
    return clause.split(/\s+and\s+|\s+(?:with|plus)\s+(?=(?:(?:a|an|the)\s+)?optional(?:ly)?\b)|,\s*(?=(?:must|required|add|include|optional(?:ly)?)\b)/i).filter(part => {
      if (/^(?:must|required|add|include)\b|\b(?:is required|is mandatory)\b/i.test(part.trim())) optionalList = false;
      if (optional.test(part)) optionalList = true;
      if (optionalList) suggestions.push(part);
      return !optionalList;
    });
  });
  const affirmative = mandatory.join(". ");
  const commerce = /\b(?:product|products|clothing|ecommerce|store|cart)\b/i.test(affirmative);
  const capabilities = functionalPatterns.filter(([id, pattern]) => {
    if (id === "size" && !commerce && !/\bsize (?:selection|selector)\b/i.test(affirmative)) return false;
    return mandatory.some(clause => [...clause.matchAll(new RegExp(pattern.source, "gi"))].some(match =>
      !/\b(?:no|without|omit|exclude|do not|don't|never)\s+(?:(?:include|add|any|a|an|the)\s+)*$/i.test(clause.slice(0, match.index))));
  }).map(([id]) => id);
  const optionalCapabilities = functionalPatterns.filter(([id, pattern]) => !capabilities.includes(id) && suggestions.some(clause => pattern.test(clause))).map(([id]) => id);
  const excludedCapabilities = functionalPatterns.filter(([id, pattern]) => clauses.some(clause => {
    if (!negative(clause)) return false;
    // A ban on fake handlers is not a ban on the form those handlers mention.
    // Each excluded list item must directly name this capability, not merely
    // mention its keyword later in an explanation of a different constraint.
    return clause.replace(exclusion, "").split(/,|\s+(?:and|or)\s+/i).some(item => {
      const subject = item.trim().replace(/^(?:(?:a|an|any|the)\s+)*/i, "");
      const qualified = subject.replace(/^(?:(?:working|functional|validated|interactive|product|site-wide|global|local|frontend|front-end|live|real)\s+)*/i, "");
      return pattern.exec(subject)?.index === 0 || pattern.exec(qualified)?.index === 0 || id === "cart" && /^cart\b/i.test(qualified) || id === "form" && /^(?:(?:contact|inquiry|feedback)\s+)?forms?\b/i.test(qualified);
    });
  })).map(([id]) => id);
  const conflicts = capabilities.filter(id => excludedCapabilities.includes(id));
  return { affirmative, capabilities, optionalCapabilities, excludedCapabilities, conflicts };
}
