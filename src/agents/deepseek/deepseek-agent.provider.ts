import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest } from "../agent-types.js";
import {
  createCompatibleClient,
  requestCompatibleResponse,
  type CompatibleProviderDependencies,
} from "../openai-compatible/chat-completions.provider.js";
import type { ChatCompletionsClient } from "../openai-compatible/chat-completions.mapper.js";
import type { DeepSeekAgentConfig } from "./deepseek-agent.config.js";
export class DeepSeekAgentProvider implements AgentProvider {
  readonly id = "deepseek";
  readonly #client: ChatCompletionsClient;
  constructor(
    readonly config: DeepSeekAgentConfig,
    readonly dependencies: CompatibleProviderDependencies = {},
  ) {
    this.#client =
      dependencies.client ?? createCompatibleClient(config, "https://api.deepseek.com");
  }
  getCapabilities() {
    return {
      models: [this.config.model],
      text: true,
      tools: true,
      vision: false,
      toolCalling: true,
      streaming: false,
      cachedInput: true,
      parallelToolCalling: true,
      promptCaching: true,
      reasoning: false,
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
      additions: { thinking: { type: "disabled" } },
      ...this.dependencies,
    });
  }
}
