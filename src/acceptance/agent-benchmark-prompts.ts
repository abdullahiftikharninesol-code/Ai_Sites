import { ProductAcceptanceScenarioRegistry } from "./product-acceptance-scenarios.js";
const registry = new ProductAcceptanceScenarioRegistry();
export const AGENT_BENCHMARK_PROMPT_SET_V1 = {
  id: "sites-agent-product-prompts-v1",
  version: 1,
  fixedExecutionProvider: "local",
  scenarioIds: [
    "static-portfolio",
    "business-landing",
    "restaurant",
    "saas-marketing",
    "member-portal",
    "complex-multipage",
  ] as const,
  prompts: [
    "static-portfolio",
    "business-landing",
    "restaurant",
    "saas-marketing",
    "member-portal",
    "complex-multipage",
  ].map((id) => ({ id, prompt: registry.get(id).prompt })),
  targetedEdit: registry.get("version-stress").edits[0],
} as const;
