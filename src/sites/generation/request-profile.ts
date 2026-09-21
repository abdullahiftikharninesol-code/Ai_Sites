import type { SiteSpec } from "../domain/site-spec.js";

export type RequestComplexity = "NORMAL" | "COMPLEX";

export interface RequestProfile {
  readonly complexity: RequestComplexity;
  readonly reasons: readonly string[];
  readonly needsAgentPlanning: boolean;
}

// This is deliberately conservative. Ordinary multi-page marketing sites are
// still deterministic; only explicit application/workflow signals route to the
// planner. Package and agent decisions never come from this classifier.
const COMPLEX_PATTERNS: readonly [RegExp, string][] = [
  [/\b(admin|administrator|staff|member)\s+(portal|dashboard|area)\b/i, "role-based application surface"],
  [/\b(authenticated|multi[- ]tenant|permissions?|roles?)\b/i, "explicit access-control workflow"],
  [/\b(checkout|payment|subscription|billing)\b/i, "transaction workflow"],
  [/\b(multi[- ]step|approval workflow|workflow automation|state machine)\b/i, "multi-step business workflow"],
  [/\b(relational database|database relationships?|many[- ]to[- ]many|foreign key)\b/i, "complex data model"],
  [/\b(real[- ]time|websocket|live collaboration|complex integration)\b/i, "non-static integration"],
];

export function analyzeRequestProfile(prompt: string): RequestProfile {
  const reasons = COMPLEX_PATTERNS
    .filter(([pattern]) => pattern.test(prompt))
    .map(([, reason]) => reason);
  return Object.freeze({
    complexity: reasons.length > 0 ? "COMPLEX" : "NORMAL",
    reasons: Object.freeze(reasons),
    needsAgentPlanning: reasons.length > 0,
  });
}

export function siteSpecRequestProfile(siteSpec: SiteSpec): RequestProfile {
  return analyzeRequestProfile([
    siteSpec.project.description,
    ...siteSpec.requirements.features,
    ...siteSpec.requirements.pages.map((page) => `${page.name} ${page.purpose}`),
  ].join("\n"));
}
