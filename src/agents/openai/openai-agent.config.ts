import { ApplicationError } from "../../app/errors/application-error.js";

export interface OpenAIAgentConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";
  readonly timeoutMs: number;
  readonly maxRetries: number;
}
export function loadOpenAIAgentConfig(env: NodeJS.ProcessEnv = process.env): OpenAIAgentConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey)
    throw new ApplicationError(
      "PROVIDER_NOT_AVAILABLE",
      "OPENAI_API_KEY is required for the OpenAI agent provider",
    );
  return {
    apiKey,
    model: env.OPENAI_AGENT_MODEL?.trim() || "gpt-5.6",
    reasoningEffort: parseReasoning(env.OPENAI_AGENT_REASONING_EFFORT),
    timeoutMs: positiveInteger(env.OPENAI_AGENT_TIMEOUT_MS, 60_000, "OPENAI_AGENT_TIMEOUT_MS"),
    maxRetries: nonNegativeInteger(env.OPENAI_AGENT_MAX_RETRIES, 2, "OPENAI_AGENT_MAX_RETRIES"),
  };
}
function parseReasoning(value: string | undefined): OpenAIAgentConfig["reasoningEffort"] {
  const result = value?.trim() || "medium";
  if (!["none", "low", "medium", "high", "xhigh"].includes(result))
    throw new ApplicationError(
      "VALIDATION_FAILED",
      `Invalid OPENAI_AGENT_REASONING_EFFORT: ${result}`,
    );
  return result as OpenAIAgentConfig["reasoningEffort"];
}
function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result <= 0)
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be a positive integer`);
  return result;
}
function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 0)
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be a non-negative integer`);
  return result;
}
