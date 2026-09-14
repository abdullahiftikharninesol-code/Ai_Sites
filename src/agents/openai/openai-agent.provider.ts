import OpenAI from "openai";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest, AgentResponse } from "../agent-types.js";
import { defaultCircuitBreaker } from "../shared/provider-errors.js";
import { measureProviderBoundary } from "../shared/provider-boundary-telemetry.js";
import type { OpenAIAgentConfig } from "./openai-agent.config.js";
import {
  mapAgentRequest,
  normalizeOpenAIResponse,
  type OpenAIResponseLike,
  type OpenAIResponseRequest,
} from "./openai-agent.mapper.js";

export interface OpenAIResponsesClient {
  create(
    request: OpenAIResponseRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<OpenAIResponseLike>;
}
export interface OpenAIAgentProviderDependencies {
  readonly client?: OpenAIResponsesClient;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}
export class OpenAIAgentProvider implements AgentProvider {
  readonly id = "openai";
  readonly #client: OpenAIResponsesClient;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  constructor(
    readonly config: OpenAIAgentConfig,
    dependencies: OpenAIAgentProviderDependencies = {},
  ) {
    this.#client =
      dependencies.client ??
      (new OpenAI({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 0 })
        .responses as unknown as OpenAIResponsesClient);
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = dependencies.now ?? Date.now;
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
      structuredOutput: true,
      structuredOutputCapability: "NATIVE_SCHEMA" as const,
    };
  }
  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const model = request.model || this.config.model;
    const supportsReasoning = /^(o[1-9]|gpt-5)/i.test(model);
    let reasoningEffort: OpenAIAgentConfig["reasoningEffort"] | undefined;
    if (supportsReasoning) {
      if (request.reasoningPolicy === "NONE") {
        reasoningEffort = "none";
      } else if (request.reasoningPolicy === "LOW") {
        reasoningEffort = "low";
      } else if (request.reasoningPolicy === "MEDIUM") {
        reasoningEffort = "medium";
      } else {
        reasoningEffort = this.config.reasoningEffort ?? "medium";
      }
    }
    const mapped = mapAgentRequest(
      { ...request, model },
      reasoningEffort,
    );
    const boundaryTelemetry = measureProviderBoundary({
      systemInstruction: mapped.instructions,
      contents: mapped.input,
      tools: mapped.tools,
      responseSchema: mapped.text?.format?.schema,
      otherMappedContext: mapped.reasoning,
    });
    const started = this.#now();
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (request.signal?.aborted)
        throw new ApplicationError("JOB_CANCELLED", "OpenAI request was cancelled");

      // Circuit breaker check occurs before physical reservation
      defaultCircuitBreaker.assertAvailable(this.id);

      // Atomic physical reservation immediately before SDK attempt
      await request.transportHook?.beforePhysicalAttempt(attempt);

      try {
        const response = await this.#client.create(
          mapped,
          request.signal ? { signal: request.signal } : undefined,
        );
        await request.transportHook?.afterPhysicalAttempt?.(attempt, undefined, response);
        const normalized = normalizeOpenAIResponse(response, this.#now() - started);
        return {
          ...normalized,
          usage: { ...normalized.usage, retryCount: attempt },
          providerBoundaryTelemetry: boundaryTelemetry,
          ...(request.responseContract?.type === "JSON_SCHEMA"
            ? {
                structuredOutputTelemetry: {
                  responseContractType: "JSON_SCHEMA" as const,
                  structuredOutputMode: "NATIVE_SCHEMA" as const,
                  structuredOutputValidated: true,
                  fallbackParserUsed: false,
                },
              }
            : {}),
        };
      } catch (cause) {
        await request.transportHook?.afterPhysicalAttempt?.(attempt, cause, undefined);
        if (request.signal?.aborted)
          throw new ApplicationError("JOB_CANCELLED", "OpenAI request was cancelled");
        if (attempt < this.config.maxRetries && isRetryable(cause)) {
          await this.#sleep(100 * 2 ** attempt);
          continue;
        }
        throw new ApplicationError("AGENT_FAILED", "OpenAI agent request failed", {
          retryable: isRetryable(cause),
          metadata: safeErrorMetadata(cause),
          cause,
        });
      }
    }
    throw new ApplicationError("AGENT_FAILED", "OpenAI agent request failed");
  }
}
function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {};
}
function isRetryable(error: unknown): boolean {
  const value = errorRecord(error);
  const status = typeof value.status === "number" ? value.status : undefined;
  const code = typeof value.code === "string" ? value.code : undefined;
  const name = typeof value.name === "string" ? value.name : "";
  if (
    status === 401 ||
    status === 400 ||
    code?.includes("quota") ||
    code?.includes("spend") ||
    code === "insufficient_quota"
  )
    return false;
  return (
    status === 429 ||
    (status !== undefined && status >= 500) ||
    ["APIConnectionError", "APIConnectionTimeoutError", "TimeoutError"].includes(name)
  );
}
function safeErrorMetadata(error: unknown): Readonly<Record<string, unknown>> {
  const value = errorRecord(error);
  return {
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(typeof value.code === "string" ? { providerCode: value.code } : {}),
    ...(typeof value.request_id === "string" ? { requestId: value.request_id } : {}),
  };
}
