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
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
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
    if (!dependencies.client)
      console.info(
        `[sites][openai] configured model=${config.model} timeoutMs=${config.timeoutMs}`,
      );
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
          {
            ...(request.signal ? { signal: request.signal } : {}),
            timeout: this.config.timeoutMs,
          },
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
        const timedOut = isTimeoutError(cause);
        if (attempt < this.config.maxRetries && isRetryable(cause) && !timedOut) {
          await this.#sleep(100 * 2 ** attempt);
          continue;
        }
        if (timedOut) {
          console.error(
            `[sites][openai] request timed out\nprovider=${this.id}\nmodel=${model}\ntimeoutMs=${this.config.timeoutMs}\nmessage=Request timed out`,
          );
          throw new ApplicationError("AGENT_FAILED", openAIErrorMessage(cause), {
            retryable: false,
            metadata: {
              ...safeErrorMetadata(cause),
              provider: this.id,
              model,
              timeoutMs: this.config.timeoutMs,
              failureStage: "PROVIDER",
            },
            cause,
          });
        }
        const detail = errorRecord(cause);
        console.error("[sites][openai] request failed", {
          provider: this.id,
          model,
          ...(typeof detail.status === "number" ? { status: detail.status } : {}),
          ...(safeDiagnosticIdentifier(detail.type) ? { type: detail.type } : {}),
          ...(safeDiagnosticIdentifier(detail.code) ? { code: detail.code } : {}),
          message: safeProviderMessage(detail.message, this.config.apiKey, request),
          retryable: isRetryable(cause),
        });
        throw new ApplicationError("AGENT_FAILED", openAIErrorMessage(cause), {
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
function safeDiagnosticIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
}
function safeProviderMessage(value: unknown, apiKey: string, request: AgentRequest): string {
  if (typeof value !== "string") return "N/A";
  let message = value;
  if (apiKey) message = message.replaceAll(apiKey, "[REDACTED]");
  if (request.systemInstructions) message = message.replaceAll(request.systemInstructions, "[REQUEST_REDACTED]");
  for (const item of request.messages) {
    if (item.content.length > 0) message = message.replaceAll(item.content, "[REQUEST_REDACTED]");
    const userRequest = item.content.split("User request: ").at(-1)?.trim();
    if (userRequest && userRequest !== item.content) message = message.replaceAll(userRequest, "[REQUEST_REDACTED]");
  }
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|authorization|secret|token)\s*[:=]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(["']).{120,}?\1/g, "[LONG_CONTENT_REDACTED]")
    .slice(0, 600);
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
function isTimeoutError(error: unknown): boolean {
  const value = errorRecord(error);
  const name = typeof value.name === "string" ? value.name : "";
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  return (
    ["APIConnectionTimeoutError", "TimeoutError"].includes(name) ||
    /ETIMEDOUT|ERR_REQUEST_TIMEOUT/i.test(code) ||
    /request timed out|request timeout|timed out waiting/i.test(message)
  );
}
function safeErrorMetadata(error: unknown): Readonly<Record<string, unknown>> {
  const value = errorRecord(error);
  return {
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(safeDiagnosticIdentifier(value.code) ? { providerCode: value.code } : {}),
    ...(safeDiagnosticIdentifier(value.request_id) ? { requestId: value.request_id } : {}),
    ...(typeof value.param === "string" && /^[a-zA-Z0-9_.]{1,100}$/.test(value.param)
      ? { providerParam: value.param }
      : {}),
  };
}

// Do not expose the SDK's raw message: it can contain request fragments or secrets.
function openAIErrorMessage(error: unknown): string {
  const value = errorRecord(error);
  const status = typeof value.status === "number" ? value.status : undefined;
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const name = typeof value.name === "string" ? value.name : "";
  if (code === "insufficient_quota" || /quota|spend|billing/.test(code))
    return "OpenAI quota or billing is unavailable. Check your API account limits.";
  if (status === 400 || status === 422)
    return "OpenAI rejected the request format. Check the provider code and parameter shown below.";
  if (status === 401)
    return "OpenAI authentication failed. Check the configured API key.";
  if (status === 403)
    return "OpenAI denied access to this request. Check model access and account permissions.";
  if (status === 404)
    return "OpenAI could not find the configured model or endpoint. Check the model setting.";
  if (status === 429)
    return "OpenAI rate limit reached. Try again after the account's reset window.";
  if (/Timeout/.test(name))
    return "OpenAI request timed out. Try again or increase OPENAI_AGENT_TIMEOUT_MS.";
  if (name === "APIConnectionError")
    return "Could not connect to OpenAI. Check the backend network connection.";
  if (status !== undefined && status >= 500)
    return "OpenAI service is temporarily unavailable. Try again shortly.";
  return "OpenAI agent request failed. Check the backend run details for the provider status.";
}
