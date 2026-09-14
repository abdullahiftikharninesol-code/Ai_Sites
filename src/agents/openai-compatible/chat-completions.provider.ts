import OpenAI from "openai";
import type { AgentRequest, AgentResponse, StructuredOutputCapability } from "../agent-types.js";
import { withProviderRetries } from "../shared/provider-errors.js";
import type { CommonAgentConfig } from "../shared/provider-config.js";
import { measureProviderBoundary } from "../shared/provider-boundary-telemetry.js";
import {
  mapChatCompletionRequest,
  normalizeChatCompletion,
  type ChatCompletionsClient,
} from "./chat-completions.mapper.js";

export interface CompatibleProviderDependencies {
  readonly client?: ChatCompletionsClient;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export function createCompatibleClient(
  config: CommonAgentConfig,
  baseURL: string,
): ChatCompletionsClient {
  return new OpenAI({ apiKey: config.apiKey, baseURL, timeout: config.timeoutMs, maxRetries: 0 })
    .chat.completions as unknown as ChatCompletionsClient;
}

export async function requestCompatibleResponse(options: {
  provider: string;
  config: CommonAgentConfig;
  client: ChatCompletionsClient;
  request: AgentRequest;
  additions?: Readonly<Record<string, unknown>>;
  capability?: StructuredOutputCapability;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<AgentResponse> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const started = now();
  const capability =
    options.capability ?? options.config.structuredOutputCapability ?? "JSON_MODE";
  const mapped = mapChatCompletionRequest(
    { ...options.request, model: options.request.model || options.config.model },
    options.additions,
    capability,
  );
  const boundaryTelemetry = measureProviderBoundary({
    systemInstruction: mapped.messages.find((m) => m.role === "system")?.content,
    contents: mapped.messages.filter((m) => m.role !== "system"),
    tools: mapped.tools,
    otherMappedContext: mapped.response_format
      ? { response_format: mapped.response_format }
      : undefined,
  });
  const { value, retryCount } = await withProviderRetries({
    provider: options.provider,
    maxRetries: options.config.maxRetries,
    ...(options.request.signal ? { signal: options.request.signal } : {}),
    sleep,
    transportHook: options.request.transportHook,
    operation: () =>
      options.client.create(
        mapped,
        options.request.signal ? { signal: options.request.signal } : undefined,
      ),
  });
  const result = normalizeChatCompletion(options.provider, value, now() - started);
  return {
    ...result,
    usage: { ...result.usage, retryCount },
    providerBoundaryTelemetry: boundaryTelemetry,
    ...(options.request.responseContract?.type === "JSON_SCHEMA"
      ? {
          structuredOutputTelemetry: {
            responseContractType: "JSON_SCHEMA" as const,
            structuredOutputMode: capability,
            structuredOutputValidated: true,
            fallbackParserUsed: false,
          },
        }
      : {}),
  };
}

