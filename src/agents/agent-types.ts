export type AgentRole = "system" | "user" | "assistant" | "tool";
/** Narrow, provider-neutral image input contract. Screenshots only; never arbitrary SVG/HTML. */
export type AgentImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface AgentImagePart {
  readonly mimeType: AgentImageMimeType;
  readonly data: Uint8Array;
  /** Artifact identity for traceability. Never a local filesystem path. */
  readonly sourceRef?: string;
}
export interface AgentMessage {
  readonly role: AgentRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly AgentToolCall[];
  /** Provider-neutral image attachments carried alongside `content`. Empty/absent for text-only messages. */
  readonly imageParts?: readonly AgentImagePart[];
  /** Opaque provider continuation parts; never expose in user telemetry. */
  readonly geminiParts?: readonly Record<string, unknown>[];
}
export type AgentToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "search_files"
  | "run_command"
  | "run_build"
  | "start_preview"
  | "read_logs"
  | "finalize_generation";
export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface AgentToolCall {
  readonly id: string;
  readonly name: AgentToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface AgentCapabilities {
  readonly models: readonly string[];
  /** Model-level modalities. Optional on legacy adapters for backwards compatibility. */
  readonly text?: boolean;
  readonly tools?: boolean;
  readonly vision?: boolean;
  /** Image MIME types this provider/model actually accepts. Absent/empty means vision must be treated as unsupported. */
  readonly visionInputMimeTypes?: readonly AgentImageMimeType[];
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly cachedInput: boolean;
  readonly parallelToolCalling?: boolean;
  readonly promptCaching?: boolean;
  readonly reasoning?: boolean;
  readonly structuredOutput?: boolean;
  readonly structuredOutputCapability?: StructuredOutputCapability;
  readonly maxInputTokens?: number;
}
export interface RateLimitMetadata {
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly requestLimit?: number;
  readonly requestsRemaining?: number;
  readonly tokenLimit?: number;
  readonly tokensRemaining?: number;
  readonly requestResetAt?: string;
  readonly tokenResetAt?: string;
}

export interface TransportHook {
  beforePhysicalAttempt(attempt: number): Promise<void> | void;
  afterPhysicalAttempt?(attempt: number, error?: unknown, response?: unknown): Promise<void> | void;
}

export type ReasoningPolicy = "NONE" | "LOW" | "MEDIUM" | "AUTO";

export type NormalizedTerminationReason =
  | "SUCCESS"
  | "OUTPUT_TRUNCATED"
  | "MODEL_TOOL_PROTOCOL_FAILURE"
  | "CONTENT_FILTER"
  | "ERROR";

export type StructuredOutputCapability = "NATIVE_SCHEMA" | "JSON_MODE" | "FALLBACK_TEXT";

export type AgentResponseContract =
  | { readonly type: "TEXT" }
  | {
      readonly type: "JSON_SCHEMA";
      readonly name: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
    };

export interface ProviderBoundaryTelemetry {
  readonly systemInstructionCharacters: number;
  readonly contentsCharacters: number;
  readonly toolSchemaCharacters: number;
  readonly responseSchemaCharacters: number;
  readonly responseSchemaEstimatedTokens: number;
  readonly otherMappedContextCharacters: number;
  readonly providerBoundaryCharacters: number;
  readonly providerBoundaryEstimatedTokens: number;
}

export type StructuredResponseFailureReason =
  | "STRUCTURED_RESPONSE_EMPTY"
  | "STRUCTURED_RESPONSE_PARSE_FAILED"
  | "STRUCTURED_RESPONSE_SCHEMA_INVALID";

export interface StructuredResponseTelemetry {
  readonly responseContractType: "TEXT" | "JSON_SCHEMA";
  readonly structuredOutputMode: StructuredOutputCapability;
  readonly structuredOutputValidated: boolean;
  readonly fallbackParserUsed: boolean;
  readonly responseParseFailureReason?: StructuredResponseFailureReason;
}

export interface AgentRequest {
  readonly model: string;
  readonly systemInstructions?: string;
  readonly messages: readonly AgentMessage[];
  readonly tools?: readonly AgentToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly transportHook?: TransportHook;
  readonly reasoningPolicy?: ReasoningPolicy;
  readonly responseContract?: AgentResponseContract;
  /** Routes requests that share a prefix to the same prompt cache. */
  readonly promptCacheKey?: string;
  /**
   * Length in characters of the leading, request-stable portion of the first user
   * message. Providers that support explicit cache breakpoints may split there;
   * the rest ignore it and send the message unchanged.
   */
  readonly cachePrefixChars?: number;
}
export interface AgentResponse {
  readonly id: string;
  readonly model: string;
  readonly message: AgentMessage;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number;
    readonly totalTokens?: number;
    readonly retryCount?: number;
  };
  readonly latencyMs: number;
  readonly finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  readonly normalizedFinishReason?: NormalizedTerminationReason;
  readonly providerBoundaryTelemetry?: ProviderBoundaryTelemetry;
  readonly structuredOutputTelemetry?: StructuredResponseTelemetry;
}
