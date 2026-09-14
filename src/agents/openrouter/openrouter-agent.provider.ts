import OpenAI from "openai";
import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest } from "../agent-types.js";
import type { ChatCompletionsClient } from "../openai-compatible/chat-completions.mapper.js";
import {
  requestCompatibleResponse,
  type CompatibleProviderDependencies,
} from "../openai-compatible/chat-completions.provider.js";
import type { OpenRouterAgentConfig } from "./openrouter-agent.config.js";

export class OpenRouterAgentProvider implements AgentProvider {
  readonly id = "openrouter";
  readonly #client: ChatCompletionsClient;

  constructor(
    readonly config: OpenRouterAgentConfig,
    readonly dependencies: CompatibleProviderDependencies = {},
  ) {
    this.#client =
      dependencies.client ??
      (new OpenAI({
        apiKey: config.apiKey,
        baseURL: "https://openrouter.ai/api/v1",
        timeout: config.timeoutMs,
        maxRetries: 0,
        defaultHeaders: {
          ...(config.appUrl ? { "HTTP-Referer": config.appUrl } : {}),
          ...(config.appName ? { "X-Title": config.appName } : {}),
        },
      }).chat.completions as unknown as ChatCompletionsClient);
  }

  getCapabilities() {
    return {
      models: [this.config.model],
      text: true,
      tools: true,
      vision: false,
      toolCalling: true,
      streaming: false,
      cachedInput: false,
      parallelToolCalling: true,
      promptCaching: false,
      reasoning: true,
      structuredOutput: true,
      structuredOutputCapability: this.config.structuredOutputCapability ?? ("JSON_MODE" as const),
    };
  }

  createResponse(request: AgentRequest) {
    return requestCompatibleResponse({
      provider: this.id,
      config: this.config,
      client: this.#client,
      request,
      additions: { parallel_tool_calls: true },
      ...this.dependencies,
    });
  }
}
