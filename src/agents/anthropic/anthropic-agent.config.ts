import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";
export type AnthropicAgentConfig = CommonAgentConfig;
export const loadAnthropicAgentConfig = (
  env: NodeJS.ProcessEnv = process.env,
): AnthropicAgentConfig => loadCommonAgentConfig(env, "ANTHROPIC", "Anthropic", "claude-opus-4-6");
