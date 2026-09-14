import type { AppConfig } from "../../app/config/environment.js";
import { MockAgentProvider } from "../mock-agent-provider.js";
import { OpenAIAgentProvider } from "../openai/openai-agent.provider.js";
import { loadOpenAIAgentConfig } from "../openai/openai-agent.config.js";
import { AgentProviderRegistry } from "./agent-provider-registry.js";
import { AnthropicAgentProvider } from "../anthropic/anthropic-agent.provider.js";
import { loadAnthropicAgentConfig } from "../anthropic/anthropic-agent.config.js";
import { GeminiAgentProvider } from "../gemini/gemini-agent.provider.js";
import { loadGeminiAgentConfig } from "../gemini/gemini-agent.config.js";
import { DeepSeekAgentProvider } from "../deepseek/deepseek-agent.provider.js";
import { loadDeepSeekAgentConfig } from "../deepseek/deepseek-agent.config.js";
import { XaiAgentProvider } from "../xai/xai-agent.provider.js";
import { loadXaiAgentConfig } from "../xai/xai-agent.config.js";
import { KimiAgentProvider } from "../kimi/kimi-agent.provider.js";
import { loadKimiAgentConfig } from "../kimi/kimi-agent.config.js";
import { GroqAgentProvider } from "../groq/groq-agent.provider.js";
import { loadGroqAgentConfig } from "../groq/groq-agent.config.js";
import { OpenRouterAgentProvider } from "../openrouter/openrouter-agent.provider.js";
import { loadOpenRouterAgentConfig } from "../openrouter/openrouter-agent.config.js";

export function createAgentProviderRegistry(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): AgentProviderRegistry {
  const registry = new AgentProviderRegistry();
  registry.register(new MockAgentProvider());
  const selected = config.defaultAgentProvider;
  if (selected === "openai") registry.register(new OpenAIAgentProvider(loadOpenAIAgentConfig(env)));
  else if (selected === "anthropic")
    registry.register(new AnthropicAgentProvider(loadAnthropicAgentConfig(env)));
  else if (selected === "gemini")
    registry.register(new GeminiAgentProvider(loadGeminiAgentConfig(env)));
  else if (selected === "deepseek")
    registry.register(new DeepSeekAgentProvider(loadDeepSeekAgentConfig(env)));
  else if (selected === "xai") registry.register(new XaiAgentProvider(loadXaiAgentConfig(env)));
  else if (selected === "kimi") registry.register(new KimiAgentProvider(loadKimiAgentConfig(env)));
  else if (selected === "groq") registry.register(new GroqAgentProvider(loadGroqAgentConfig(env)));
  else if (selected === "openrouter")
    registry.register(new OpenRouterAgentProvider(loadOpenRouterAgentConfig(env)));
  else if (selected && selected !== "mock" && selected !== "mock-agent") registry.get(selected);
  else if (!selected && env.OPENAI_API_KEY?.trim())
    registry.register(new OpenAIAgentProvider(loadOpenAIAgentConfig(env)));
  if (config.defaultAgentProvider)
    registry.get(
      config.defaultAgentProvider === "mock" ? "mock-agent" : config.defaultAgentProvider,
    );
  return registry;
}
