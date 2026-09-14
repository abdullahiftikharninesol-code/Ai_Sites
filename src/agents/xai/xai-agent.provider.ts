import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest } from "../agent-types.js";
import {
  createCompatibleClient,
  requestCompatibleResponse,
  type CompatibleProviderDependencies,
} from "../openai-compatible/chat-completions.provider.js";
import type { ChatCompletionsClient } from "../openai-compatible/chat-completions.mapper.js";
import type { XaiAgentConfig } from "./xai-agent.config.js";
export class XaiAgentProvider implements AgentProvider {
  readonly id = "xai";
  readonly #client: ChatCompletionsClient;
  constructor(
    readonly config: XaiAgentConfig,
    readonly dependencies: CompatibleProviderDependencies = {},
  ) {
    this.#client = dependencies.client ?? createCompatibleClient(config, "https://api.x.ai/v1");
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
      ...this.dependencies,
    });
  }
}
export { XaiAgentProvider as XAIAgentProvider };
