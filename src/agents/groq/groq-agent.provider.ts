import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest } from "../agent-types.js";
import {
  createCompatibleClient,
  requestCompatibleResponse,
  type CompatibleProviderDependencies,
} from "../openai-compatible/chat-completions.provider.js";
import type { ChatCompletionsClient } from "../openai-compatible/chat-completions.mapper.js";
import type { GroqAgentConfig } from "./groq-agent.config.js";

export class GroqAgentProvider implements AgentProvider {
  readonly id = "groq";
  readonly #client: ChatCompletionsClient;

  constructor(
    readonly config: GroqAgentConfig,
    readonly dependencies: CompatibleProviderDependencies = {},
  ) {
    this.#client =
      dependencies.client ?? createCompatibleClient(config, "https://api.groq.com/openai/v1");
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
      parallelToolCalling: this.config.parallelToolCalling ?? true,
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
      additions: { parallel_tool_calls: this.config.parallelToolCalling ?? true },
      ...this.dependencies,
    });
  }
}
