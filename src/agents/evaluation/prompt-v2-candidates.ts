import type { AgentId } from "../contracts/agent-contract.js";
import { estimateTokensConservative } from "../budget/token-estimator.js";
import {
  comparePromptEvalRuns,
  runOfflinePromptEval,
  type PromptEvalComparison,
  type PromptEvalRun,
} from "./prompt-evaluation.js";
import { CORE_PROMPT_EVAL_SUITES } from "./core-prompt-eval-suites.js";
import { PROMPT_REGISTRY, type PromptDefinition } from "../prompts/prompt-registry.js";

export const CANDIDATE_PROMPT_IDS = Object.freeze([
  "sites.site-planner",
  "sites.site-coder",
  "sites.build-repair",
  "sites.targeted-edit",
] as const satisfies readonly AgentId[]);

export interface PromptSizeMetrics {
  readonly promptId: AgentId;
  readonly v1Characters: number;
  readonly v1EstimatedTokens: number;
  readonly v2Characters: number;
  readonly v2EstimatedTokens: number;
  readonly characterDelta: number;
  readonly estimatedTokenDelta: number;
  readonly v1Hash: string;
  readonly v2Hash: string;
}

export interface CandidatePromptEvalReport {
  readonly agentId: AgentId;
  readonly baseline: PromptEvalRun;
  readonly candidate: PromptEvalRun;
  readonly comparison: PromptEvalComparison;
  readonly promptSize: PromptSizeMetrics;
  readonly externalProviderCalls: 0;
}

/** Compact, testable coverage anchors derived from the 3A.9 specifications. */
export const CANDIDATE_PROMPT_COVERAGE_REQUIREMENTS: Readonly<
  Record<(typeof CANDIDATE_PROMPT_IDS)[number], readonly string[]>
> = Object.freeze({
  "sites.build-repair": Object.freeze([
    "Build Repair Agent",
    "build diagnostics",
    "minimum safe correction",
    "preserve existing design and content",
    "dependency architecture",
    "managed-file",
    "deterministic rebuild",
  ]),
  "sites.targeted-edit": Object.freeze([
    "Targeted Edit Agent",
    "validated SiteEditPlan",
    "smallest safe change",
    "unrelated pages",
    "existing approved dependencies",
    "managed files",
    "localized patches",
  ]),
  "sites.site-coder": Object.freeze([
    "Site Coding Agent",
    "SiteSpec",
    "GeneratedAppProfile",
    "resolved capabilities",
    "Sites UI Registry",
    "approved dependencies",
    "managed-file",
    "responsive layouts",
    "finalize_generation",
    "deterministic completion validation",
  ]),
  "sites.site-planner": Object.freeze([
    "Site Planning Agent",
    "compact, valid SitePlan",
    "site's purpose",
    "required pages",
    "important sections",
    "explicitly requested functionality",
    "design direction",
    "conservative assumptions",
    "supported platform capabilities",
    "write source code",
    "select npm packages",
    "hidden reasoning",
  ]),
});

function promptPair(promptId: AgentId): { readonly v1: PromptDefinition; readonly v2: PromptDefinition } {
  return {
    v1: PROMPT_REGISTRY.getPrompt(promptId, 1),
    v2: PROMPT_REGISTRY.getPrompt(promptId, 2),
  };
}

export function getCandidatePromptSizes(): readonly PromptSizeMetrics[] {
  return Object.freeze(
    CANDIDATE_PROMPT_IDS.map((promptId) => {
      const { v1, v2 } = promptPair(promptId);
      const v1Characters = v1.systemPrompt.length;
      const v2Characters = v2.systemPrompt.length;
      const v1EstimatedTokens = estimateTokensConservative(v1.systemPrompt);
      const v2EstimatedTokens = estimateTokensConservative(v2.systemPrompt);
      return Object.freeze({
        promptId,
        v1Characters,
        v1EstimatedTokens,
        v2Characters,
        v2EstimatedTokens,
        characterDelta: v2Characters - v1Characters,
        estimatedTokenDelta: v2EstimatedTokens - v1EstimatedTokens,
        v1Hash: v1.promptHash,
        v2Hash: v2.promptHash,
      });
    }),
  );
}

export function getMissingCandidatePromptCoverage(prompt: PromptDefinition): readonly string[] {
  return Object.freeze(
    CANDIDATE_PROMPT_COVERAGE_REQUIREMENTS[prompt.promptId as (typeof CANDIDATE_PROMPT_IDS)[number]]?.filter(
      (requirement) => !prompt.systemPrompt.includes(requirement),
    ) ?? [],
  );
}

/** Run only the deterministic 3A.9 fixtures; this function has no provider/model input or dispatch path. */
export function runOfflineCandidatePromptEvals(): readonly CandidatePromptEvalReport[] {
  const sizes = new Map(getCandidatePromptSizes().map((metrics) => [metrics.promptId, metrics]));
  return Object.freeze(
    CANDIDATE_PROMPT_IDS.map((agentId) => {
      const suite = CORE_PROMPT_EVAL_SUITES.find(
        (item) => item.agentId === agentId && item.suiteId === `sites-core-agents.${agentId.replace("sites.", "")}`,
      );
      if (!suite) throw new Error(`No core offline prompt eval suite is registered for '${agentId}'`);
      const { v2 } = promptPair(agentId);
      const requestAccounting = { logicalRequests: 1, physicalRequests: 1 } as const;
      const v1 = promptPair(agentId).v1;
      const baseline = runOfflinePromptEval(suite, { prompt: v1, requestAccounting });
      const candidate = runOfflinePromptEval(suite, { prompt: v2, requestAccounting });
      return Object.freeze({
        agentId,
        baseline,
        candidate,
        comparison: comparePromptEvalRuns(baseline, candidate),
        promptSize: sizes.get(agentId)!,
        externalProviderCalls: 0 as const,
      });
    }),
  );
}

export const CANDIDATE_PROMPT_EVAL_REPORTS = runOfflineCandidatePromptEvals();
