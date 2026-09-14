import type { AgentMessage } from "../agent-types.js";
import type { InferenceStage } from "./agent-run-budget.js";
import type { ReasoningPolicy } from "./inference-context-policy.js";

/**
 * Standard token estimator for telemetry and display.
 * Uses 3.7 characters per token heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.7);
}

/**
 * Conservative token estimator for safety preflight checks.
 * Uses 3.0 characters per token heuristic to account for high-density
 * tokens in source code (TSX/CSS), JSON, punctuation, and tool schemas.
 */
export function estimateTokensConservative(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.0);
}

/**
 * Estimates tokens across a list of AgentMessages using standard estimator.
 */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (m.toolCalls) {
      for (const call of m.toolCalls) {
        total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments));
      }
    }
  }
  return total;
}

/**
 * Estimates tokens across a list of AgentMessages using conservative estimator.
 */
export function estimateMessagesTokensConservative(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokensConservative(m.content);
    if (m.toolCalls) {
      for (const call of m.toolCalls) {
        total +=
          estimateTokensConservative(call.name) +
          estimateTokensConservative(JSON.stringify(call.arguments));
      }
    }
  }
  return total;
}

export interface RequestSizeTelemetry {
  readonly stage: InferenceStage;
  readonly inputCharacters: number;
  readonly estimatedInputTokens: number;
  readonly conservativeEstimatedInputTokens: number;
  readonly systemPromptCharacters: number;
  readonly toolSchemaCharacters: number;
  readonly siteSpecCharacters: number;
  readonly workspaceContextCharacters: number;
  readonly conversationCharacters: number;
  readonly requestedMaxOutputTokens: number;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly risk: "LOW" | "MEDIUM" | "HIGH";
}

export function measureRequestSize(params: {
  readonly stage: InferenceStage;
  readonly systemInstructions?: string | undefined;
  readonly toolSchemas?: string | undefined;
  readonly siteSpecContent?: string | undefined;
  readonly workspaceContext?: string | undefined;
  readonly messages: readonly AgentMessage[];
  readonly requestedMaxOutputTokens: number;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly remainingRunBudgetTokens?: number | undefined;
}): RequestSizeTelemetry {
  const systemPromptCharacters = params.systemInstructions?.length ?? 0;
  const toolSchemaCharacters = params.toolSchemas?.length ?? 0;
  const siteSpecCharacters = params.siteSpecContent?.length ?? 0;
  const workspaceContextCharacters = params.workspaceContext?.length ?? 0;

  let conversationCharacters = 0;
  for (const msg of params.messages) {
    conversationCharacters += msg.content.length;
    if (msg.toolCalls) {
      for (const call of msg.toolCalls) {
        conversationCharacters += call.name.length + JSON.stringify(call.arguments).length;
      }
    }
  }

  const inputCharacters =
    systemPromptCharacters +
    toolSchemaCharacters +
    siteSpecCharacters +
    workspaceContextCharacters +
    conversationCharacters;

  const estimatedInputTokens = estimateTokens(
    (params.systemInstructions ?? "") +
      (params.toolSchemas ?? "") +
      (params.siteSpecContent ?? "") +
      (params.workspaceContext ?? ""),
  ) + estimateMessagesTokens(params.messages);

  const conservativeEstimatedInputTokens = estimateTokensConservative(
    (params.systemInstructions ?? "") +
      (params.toolSchemas ?? "") +
      (params.siteSpecContent ?? "") +
      (params.workspaceContext ?? ""),
  ) + estimateMessagesTokensConservative(params.messages);

  const totalProjectedDemand =
    conservativeEstimatedInputTokens + params.requestedMaxOutputTokens;
  const remaining = params.remainingRunBudgetTokens ?? Number.POSITIVE_INFINITY;

  let risk: "LOW" | "MEDIUM" | "HIGH" = "LOW";
  if (totalProjectedDemand > remaining) {
    risk = "HIGH";
  } else if (totalProjectedDemand > remaining * 0.75) {
    risk = "MEDIUM";
  }

  return {
    stage: params.stage,
    inputCharacters,
    estimatedInputTokens,
    conservativeEstimatedInputTokens,
    systemPromptCharacters,
    toolSchemaCharacters,
    siteSpecCharacters,
    workspaceContextCharacters,
    conversationCharacters,
    requestedMaxOutputTokens: params.requestedMaxOutputTokens,
    reasoningPolicy: params.reasoningPolicy,
    risk,
  };
}
