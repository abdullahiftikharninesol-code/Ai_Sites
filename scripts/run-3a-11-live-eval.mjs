import {
  AGENT_CONTRACT_REGISTRY,
  canaryCasesFor,
  createAgentProviderRegistry,
  loadConfig,
  runLivePromptEvaluation,
} from "../dist/index.js";
import { getInferenceContextPolicy } from "../dist/agents/budget/inference-context-policy.js";

const providerName = (process.env.SITES_DEV_AGENT_PROVIDER ?? process.env.DEFAULT_AGENT_PROVIDER ?? "")
  .trim()
  .toLowerCase();
const env = { ...process.env, DEFAULT_AGENT_PROVIDER: providerName };
const config = loadConfig(env);
const provider = createAgentProviderRegistry(config, env).get(providerName);
const model = provider.getCapabilities().models[0] ?? "";
const agents = [
  "sites.site-planner",
  "sites.site-coder",
  "sites.build-repair",
  "sites.edit-planner",
  "sites.targeted-edit",
];

for (const agentId of agents) {
  const contract = AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(agentId);
  const evalRunId = `3a11-recovery-20260915-${agentId.replaceAll(".", "-")}`;
  try {
    const result = await runLivePromptEvaluation({
      agentId,
      baselinePromptVersion: 1,
      candidatePromptVersion: 2,
      suiteId: `sites-core-agents.${agentId.replace("sites.", "")}`,
      suiteVersion: 1,
      caseIds: canaryCasesFor(agentId),
      provider,
      model,
      reasoningPolicy: getInferenceContextPolicy(contract.stage).reasoningPolicy,
      budget: {
        maxCases: 4,
        maxLogicalRequests: 4,
        maxPhysicalRequests: 4,
        maxInputTokens: 2_000,
        maxOutputTokens: 2_048,
        timeoutMs: 30_000,
      },
      evalRunId,
      resume: true,
    });
    console.log(JSON.stringify({
      agentId,
      evalRunId,
      status: "COMPLETED",
      baseline: result.baseline.cases.map(({ caseId, classification, errorClassification }) => ({ caseId, classification, errorClassification })),
      candidate: result.candidate.cases.map(({ caseId, classification, errorClassification }) => ({ caseId, classification, errorClassification })),
    }));
  } catch (error) {
    console.log(JSON.stringify({ agentId, evalRunId, status: "BLOCKED", errorClass: error?.code ?? error?.name ?? "ERROR" }));
    break;
  }
}
