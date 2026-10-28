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
  readonly conflicts: readonly FunctionalCapability[];
} {
  const clauses = prompt.split(/[.;\n]|\bbut\b/i).map(clause => clause.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s*)/, "").replace(/\*\*|__/g, "").trim());
  const protection = /^(?:do not|don't|never)\s+(?:remove|skip|break|omit|disable|exclude)\b/i;
  const exclusion = /^(?:(?:no|without|omit|exclude)\s+|(?:do not|don't|never)\s+(?:include|add|show|render|implement|create|build|use|provide|display|enable|support|have)\s+)/i;
  const negative = (clause: string) => !protection.test(clause) && exclusion.test(clause);
  const positive = clauses.filter(clause => !negative(clause));
  const affirmative = positive.join(". ");
  const commerce = /\b(?:product|products|clothing|ecommerce|store|cart)\b/i.test(affirmative);
  const capabilities = functionalPatterns.filter(([id, pattern]) => {
    if (id === "size" && !commerce && !/\bsize (?:selection|selector)\b/i.test(affirmative)) return false;
    return positive.some(clause => [...clause.matchAll(new RegExp(pattern.source, "gi"))].some(match =>
      !/\b(?:no|without|omit|exclude|do not|don't|never)\s+(?:(?:include|add|any|a|an|the)\s+)*$/i.test(clause.slice(0, match.index))));
  }).map(([id]) => id);
  const conflicts = capabilities.filter(id => {
    const pattern = functionalPatterns.find(([name]) => name === id)![1];
    return clauses.some(clause => {
      if (!negative(clause) || !pattern.test(clause)) return false;
      const subject = clause.replace(exclusion, "").replace(/^(?:(?:a|an|any|the)\s+)*/i, "");
      // "No fake handlers for a contact form" forbids fake handlers, not the
      // contact form. An exclusion must start with an actual capability subject.
      return functionalPatterns.some(([, candidate]) => candidate.exec(subject)?.index === 0);
    });
  });
  return { affirmative, capabilities, conflicts };
}
