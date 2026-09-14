import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";
import { ApplicationError } from "../../app/errors/application-error.js";

export type GroqAgentConfig = CommonAgentConfig;

export const loadGroqAgentConfig = (env: NodeJS.ProcessEnv = process.env): GroqAgentConfig => ({
  ...loadCommonAgentConfig(env, "GROQ", "Groq", "openai/gpt-oss-120b"),
  parallelToolCalling: booleanValue(env.GROQ_AGENT_PARALLEL_TOOL_CALLS, true),
});

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApplicationError(
    "VALIDATION_FAILED",
    "GROQ_AGENT_PARALLEL_TOOL_CALLS must be true or false",
  );
}
