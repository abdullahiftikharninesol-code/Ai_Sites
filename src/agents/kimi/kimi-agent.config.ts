import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";
export type KimiAgentConfig = CommonAgentConfig;
export const loadKimiAgentConfig = (env: NodeJS.ProcessEnv = process.env): KimiAgentConfig =>
  loadCommonAgentConfig(env, "KIMI", "Kimi", "kimi-k2.6");
