import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";
export type GeminiAgentConfig = CommonAgentConfig & {
  readonly minRequestIntervalMs?: number;
  readonly thinkingBudget?: number;
  readonly maxOutputTokens?: number;
};
export const loadGeminiAgentConfig = (env: NodeJS.ProcessEnv = process.env): GeminiAgentConfig => {
  const base = loadCommonAgentConfig(env, "GEMINI", "Gemini", "gemini-3.6-flash");
  return {
    ...base,
    timeoutMs: env.GEMINI_AGENT_TIMEOUT_MS ? base.timeoutMs : 120_000,
    minRequestIntervalMs: Math.max(0, Number(env.GEMINI_AGENT_MIN_REQUEST_INTERVAL_MS) || 0),
    thinkingBudget:
      env.GEMINI_AGENT_THINKING_BUDGET !== undefined
        ? Number(env.GEMINI_AGENT_THINKING_BUDGET)
        : 1024,
    maxOutputTokens:
      env.GEMINI_AGENT_MAX_OUTPUT_TOKENS !== undefined
        ? Number(env.GEMINI_AGENT_MAX_OUTPUT_TOKENS)
        : 16384,
  };
};
