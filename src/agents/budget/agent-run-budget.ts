export type InferenceStage =
  | "SITE_PLANNING"
  | "GENERATE_SITE"
  | "BUILD_REPAIR"
  | "MOTION_REPAIR"
  | "EDIT_PLANNING"
  | "TARGETED_EDIT"
  | "VISUAL_REVIEW"
  | "VISUAL_REPAIR"
  | "ASSET_PLANNING";

export type BudgetExhaustedReason =
  | "LOGICAL_REQUEST_LIMIT"
  | "PHYSICAL_REQUEST_LIMIT"
  | "INPUT_TOKEN_LIMIT"
  | "OUTPUT_TOKEN_LIMIT"
  | "REASONING_TOKEN_LIMIT"
  | "TOTAL_TOKEN_LIMIT"
  | "RUN_DURATION_LIMIT"
  | "CONTEXT_BYTES_LIMIT";

export interface InferenceBudgetLimits {
  readonly maxLogicalRequests: number;
  readonly maxPhysicalRequests: number;
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly maxReasoningTokens?: number | undefined;
  readonly maxTotalTokens: number;
  readonly maxRunDurationMs?: number | undefined;
  readonly maxContextBytes?: number | undefined;
}

export interface InferenceBudgetUsage {
  readonly logicalRequests: number;
  readonly physicalRequests: number;
  readonly retries: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly budgetExceeded: boolean;
  readonly exhaustedReason?: BudgetExhaustedReason | undefined;
}

export const DEFAULT_INFERENCE_BUDGET_LIMITS: InferenceBudgetLimits = {
  maxLogicalRequests: 4, // 1 planning + 2 generation + 1 repair (maps from legacy maxModelRequests: 3 + 1 for planning)
  maxPhysicalRequests: 6, // allows at least 2 retries across the run
  maxTotalTokens: 100_000,
  maxContextBytes: 128_000,
  maxRunDurationMs: 600_000,
};

/**
 * Resolves budget limits from explicit or legacy options.
 *
 * NOTE on legacy mapping:
 * Previous `maxModelRequests` defaults to 3 and only covered generation and repair.
 * When translating legacy `maxModelRequests`, we add 1 to accommodate site planning
 * (e.g. legacy 3 -> global logical 4).
 * Physical limits remain independently configured and are NOT permanently derived via `maxLogicalRequests * 2`.
 */
export function resolveBudgetLimits(input?: {
  readonly maxLogicalRequests?: number | undefined;
  readonly maxPhysicalRequests?: number | undefined;
  readonly maxModelRequests?: number | undefined;
  readonly maxTotalTokens?: number | undefined;
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly maxReasoningTokens?: number | undefined;
  readonly maxRunDurationMs?: number | undefined;
  readonly maxContextBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}): InferenceBudgetLimits {
  const maxLogicalRequests =
    input?.maxLogicalRequests ??
    (input?.maxModelRequests !== undefined
      ? input.maxModelRequests + 1
      : DEFAULT_INFERENCE_BUDGET_LIMITS.maxLogicalRequests);

  const maxPhysicalRequests =
    input?.maxPhysicalRequests ?? DEFAULT_INFERENCE_BUDGET_LIMITS.maxPhysicalRequests;

  const maxContextBytes = input?.maxContextBytes ?? DEFAULT_INFERENCE_BUDGET_LIMITS.maxContextBytes;
  const maxRunDurationMs =
    input?.maxRunDurationMs ?? input?.timeoutMs ?? DEFAULT_INFERENCE_BUDGET_LIMITS.maxRunDurationMs;

  return {
    maxLogicalRequests,
    maxPhysicalRequests,
    maxTotalTokens: input?.maxTotalTokens ?? DEFAULT_INFERENCE_BUDGET_LIMITS.maxTotalTokens,
    ...(maxContextBytes !== undefined ? { maxContextBytes } : {}),
    ...(maxRunDurationMs !== undefined ? { maxRunDurationMs } : {}),
    ...(input?.maxInputTokens !== undefined ? { maxInputTokens: input.maxInputTokens } : {}),
    ...(input?.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input?.maxReasoningTokens !== undefined
      ? { maxReasoningTokens: input.maxReasoningTokens }
      : {}),
  };
}

/** Legacy interface maintained for backward compatibility. */
export interface AgentRunBudget {
  readonly maxProviderRequests: number;
  readonly maxRepairAttempts: number;
  readonly maxToolIterations: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxContextBytes?: number;
}

export const DEFAULT_AGENT_RUN_BUDGET: AgentRunBudget = {
  maxProviderRequests: 3,
  maxRepairAttempts: 1,
  maxToolIterations: 5,
  maxTotalTokens: 100_000,
  maxContextBytes: 128_000,
};
