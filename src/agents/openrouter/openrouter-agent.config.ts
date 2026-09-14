import { loadCommonAgentConfig, type CommonAgentConfig } from "../shared/provider-config.js";

export interface OpenRouterAgentConfig extends CommonAgentConfig {
  readonly appUrl?: string;
  readonly appName?: string;
}

export const loadOpenRouterAgentConfig = (
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterAgentConfig => ({
  ...loadCommonAgentConfig(env, "OPENROUTER", "OpenRouter", "google/gemini-2.5-flash"),
  ...(env.OPENROUTER_APP_URL?.trim() ? { appUrl: env.OPENROUTER_APP_URL.trim() } : {}),
  ...(env.OPENROUTER_APP_NAME?.trim() ? { appName: env.OPENROUTER_APP_NAME.trim() } : {}),
});
