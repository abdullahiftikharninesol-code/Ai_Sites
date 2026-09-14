import type { BenchmarkScenario } from "./benchmark-types.js";
export const CANONICAL_SITES_BENCHMARK_V1 = {
  id: "canonical-sites-benchmark-v1",
  prompt:
    "Create a modern members-only consulting portal for Acme Advisory with public services, testimonials and contact content, signup/login, a protected member dashboard, owner-scoped private project notes, and a protected company-insights action. Include responsive desktop, tablet, and mobile layouts.",
  customDomain: "portal.acme.test",
  v1Marker: "Member Workspace",
  v2Instruction:
    "Change the dashboard heading from 'Member Workspace' to 'Client Command Center' and add a status card without altering authentication, notes, or integration behavior.",
  v2Marker: "Client Command Center",
  expectedPages: ["/", "/services", "/dashboard"],
  expectedCollections: ["testimonials", "member_notes"],
  expectedAction: "companyInsights.get",
} as const;
export const BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "EXECUTION_PRIMITIVES",
    version: 1,
    tier: "STANDARD",
    description:
      "Environment, fixture upload, controlled build failure, repair, build, inspection and cleanup.",
  },
  {
    id: "SITE_GENERATION",
    version: 1,
    tier: "STANDARD",
    description: "Fixed prompt/context/profile generation with build and validation.",
    prompt: CANONICAL_SITES_BENCHMARK_V1.prompt,
  },
  {
    id: "TARGETED_EDIT",
    version: 1,
    tier: "STANDARD",
    description: "Restore and minimally edit a fixed existing source snapshot.",
    expected: { instruction: CANONICAL_SITES_BENCHMARK_V1.v2Instruction },
  },
  {
    id: "FULL_PRODUCT_E2E",
    version: 1,
    tier: "FULL",
    description: "Complete persistent local Sites lifecycle through rollback and cleanup.",
    prompt: CANONICAL_SITES_BENCHMARK_V1.prompt,
  },
];
