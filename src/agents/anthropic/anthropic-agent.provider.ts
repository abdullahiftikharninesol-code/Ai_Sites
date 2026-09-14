import Anthropic from "@anthropic-ai/sdk";
import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest, AgentResponse } from "../agent-types.js";
import { withProviderRetries } from "../shared/provider-errors.js";
import {
  mapAnthropicRequest,
  normalizeAnthropicResponse,
  type AnthropicMessagesClient,
} from "./anthropic-agent.mapper.js";
import type { AnthropicAgentConfig } from "./anthropic-agent.config.js";
import { measureProviderBoundary } from "../shared/provider-boundary-telemetry.js";

export interface AnthropicProviderDependencies {
  readonly client?: AnthropicMessagesClient;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}
export class AnthropicAgentProvider implements AgentProvider {
  readonly id = "anthropic";
  readonly #client: AnthropicMessagesClient;
  constructor(
    readonly config: AnthropicAgentConfig,
    readonly dependencies: AnthropicProviderDependencies = {},
  ) {
    this.#client =
      dependencies.client ??
      (new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 0 })
        .messages as unknown as AnthropicMessagesClient);
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
      reasoning: true,
      structuredOutput: true,
      structuredOutputCapability: "FALLBACK_TEXT" as const,
    };
  }
  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const now = this.dependencies.now ?? Date.now;
    const started = now();
    const sleep =
      this.dependencies.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const mapped = mapAnthropicRequest({ ...request, model: request.model || this.config.model });
    const boundaryTelemetry = measureProviderBoundary({
      systemInstruction: mapped.system,
      contents: mapped.messages,
      tools: mapped.tools,
      otherMappedContext: { max_tokens: mapped.max_tokens },
    });
    const result = await withProviderRetries({
      provider: this.id,
      maxRetries: this.config.maxRetries,
      ...(request.signal ? { signal: request.signal } : {}),
      sleep,
      transportHook: request.transportHook,
      operation: () =>
        this.#client.create(mapped, request.signal ? { signal: request.signal } : undefined),
    });
    const normalized = normalizeAnthropicResponse(result.value, now() - started);
    return {
      ...normalized,
      usage: { ...normalized.usage, retryCount: result.retryCount },
      providerBoundaryTelemetry: boundaryTelemetry,
      ...(request.responseContract?.type === "JSON_SCHEMA"
        ? {
            structuredOutputTelemetry: {
              responseContractType: "JSON_SCHEMA" as const,
              structuredOutputMode: "FALLBACK_TEXT" as const,
              structuredOutputValidated: true,
              fallbackParserUsed: false,
            },
          }
        : {}),
    };
  }
}
