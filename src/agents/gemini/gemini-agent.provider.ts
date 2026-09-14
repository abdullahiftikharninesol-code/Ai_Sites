import { GoogleGenAI } from "@google/genai";
import type { AgentProvider } from "../agent-provider.js";
import type { AgentRequest, AgentResponse } from "../agent-types.js";
import { withProviderRetries } from "../shared/provider-errors.js";
import {
  mapGeminiRequest,
  normalizeGeminiResponse,
  type GeminiModelsClient,
} from "./gemini-agent.mapper.js";
import type { GeminiAgentConfig } from "./gemini-agent.config.js";
import { abortable, delay } from "../shared/abort.js";
import { measureProviderBoundary } from "../shared/provider-boundary-telemetry.js";
export interface GeminiProviderDependencies {
  readonly client?: GeminiModelsClient;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}
export class GeminiAgentProvider implements AgentProvider {
  readonly id = "gemini";
  readonly #client: GeminiModelsClient;
  #queue: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;
  constructor(
    readonly config: GeminiAgentConfig,
    readonly dependencies: GeminiProviderDependencies = {},
  ) {
    this.#client =
      dependencies.client ??
      (new GoogleGenAI({
        apiKey: config.apiKey,
        httpOptions: { timeout: config.timeoutMs, retryOptions: { attempts: 1 } },
      }).models as unknown as GeminiModelsClient);
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
      structuredOutputCapability: "NATIVE_SCHEMA" as const,
    };
  }
  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const now = this.dependencies.now ?? Date.now;
    const started = now();
    const sleep =
      this.dependencies.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("Gemini request timed out")),
      this.config.timeoutMs,
    );
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    const maxOutputTokens = request.maxOutputTokens || this.config.maxOutputTokens;
    let thinkingBudget: number | undefined;
    if (request.reasoningPolicy === "NONE") {
      thinkingBudget = 0;
    } else if (request.reasoningPolicy === "LOW") {
      thinkingBudget = 512;
    } else if (request.reasoningPolicy === "MEDIUM") {
      thinkingBudget = 1024;
    } else {
      thinkingBudget = this.config.thinkingBudget;
    }
    const mapped = mapGeminiRequest(
      {
        ...request,
        model: request.model || this.config.model,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        signal,
      },
      thinkingBudget,
    );
    const configRecord = mapped.config as Record<string, unknown>;
    const configured = {
      ...mapped,
      config: {
        ...mapped.config,
        httpOptions: { timeout: this.config.timeoutMs, retryOptions: { attempts: 1 } },
      },
    };
    const boundaryTelemetry = measureProviderBoundary({
      systemInstruction: configRecord.systemInstruction,
      contents: mapped.contents,
      tools: configRecord.tools as readonly unknown[] | undefined,
      responseSchema: configRecord.responseSchema as Readonly<Record<string, unknown>> | undefined,
      otherMappedContext: {
        thinkingConfig: configRecord.thinkingConfig,
        maxOutputTokens: configRecord.maxOutputTokens,
      },
    });
    try {
      const result = await withProviderRetries({
        provider: this.id,
        maxRetries: this.config.maxRetries,
        signal,
        sleep,
        transportHook: request.transportHook,
        operation: () => {
          const next = this.#queue.then(async () => {
            signal.throwIfAborted();
            await delay(
              Math.max(
                0,
                this.#lastRequestAt + (this.config.minRequestIntervalMs ?? 0) - Date.now(),
              ),
              signal,
            );
            signal.throwIfAborted();
            this.#lastRequestAt = Date.now();
            return abortable(this.#client.generateContent(configured), signal);
          });
          this.#queue = next.then(
            () => undefined,
            () => undefined,
          );
          return abortable(next, signal);
        },
      });
      const normalized = normalizeGeminiResponse(result.value, mapped.model, now() - started);
      return {
        ...normalized,
        usage: { ...normalized.usage, retryCount: result.retryCount },
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
    } finally {
      clearTimeout(timer);
    }
  }
}
