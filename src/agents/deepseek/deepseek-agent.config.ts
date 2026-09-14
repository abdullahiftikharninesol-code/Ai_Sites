import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";
export type DeepSeekAgentConfig = CommonAgentConfig;
export const loadDeepSeekAgentConfig = (
  env: NodeJS.ProcessEnv = process.env,
): DeepSeekAgentConfig => loadCommonAgentConfig(env, "DEEPSEEK", "DeepSeek", "deepseek-v4-pro");
