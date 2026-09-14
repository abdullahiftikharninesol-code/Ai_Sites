import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";
export type XaiAgentConfig = CommonAgentConfig;
export const loadXaiAgentConfig = (env: NodeJS.ProcessEnv = process.env): XaiAgentConfig =>
  loadCommonAgentConfig(env, "XAI", "xAI", "grok-4.6");
