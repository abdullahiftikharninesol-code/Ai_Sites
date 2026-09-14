import { randomUUID } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  AgentRequest,
  AgentResponse,
  AgentToolCall,
  StructuredOutputCapability,
} from "../agent-types.js";
import { isApprovedAgentTool } from "../tool-catalog.js";
import { projectOpenAISchema } from "../../sites/domain/site-plan-schema.js";

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly tools: readonly Record<string, unknown>[];
  readonly parallel_tool_calls: boolean;
  readonly max_tokens?: number;
  readonly stream: false;
  readonly response_format?: Record<string, unknown>;
  readonly [key: string]: unknown;
}
export interface ChatCompletionLike {
  readonly id: string;
  readonly model: string;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
  };
}
export interface ChatCompletionsClient {
  create(
    request: ChatCompletionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ChatCompletionLike>;
}

export function mapChatCompletionRequest(
  request: AgentRequest,
  additions: Readonly<Record<string, unknown>> = {},
  capability?: StructuredOutputCapability,
): ChatCompletionRequest {
  const messages: Record<string, unknown>[] = [];
  if (request.systemInstructions)
    messages.push({ role: "system", content: request.systemInstructions });
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ApplicationError("AGENT_FAILED", "Tool observation is missing its call ID");
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
    } else messages.push({ role: message.role, content: message.content });
  }

  let responseFormat: Record<string, unknown> | undefined;
  if (request.responseContract?.type === "JSON_SCHEMA") {
    if (capability === "NATIVE_SCHEMA") {
      responseFormat = {
        type: "json_schema",
        json_schema: {
          name: request.responseContract.name,
          schema: projectOpenAISchema(request.responseContract.schema),
          strict: true,
        },
      };
    } else if (capability === "JSON_MODE") {
      responseFormat = { type: "json_object" };
    }
  }

  return {
    model: request.model,
    messages,
    tools: (request.tools ?? []).map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })),
    parallel_tool_calls: true,
    stream: false,
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...additions,
  };
}

export function normalizeChatCompletion(
  provider: string,
  response: ChatCompletionLike,
  latencyMs: number,
): AgentResponse {
  const choice = response.choices?.[0];
  if (!choice?.message)
    throw new ApplicationError("AGENT_FAILED", `${provider} returned no response choice`);
  const toolCalls: AgentToolCall[] = (choice.message.tool_calls ?? []).map((call, index) => {
    // A per-response array index would collide across turns once the index resets
    // to 0 on each new response, misattributing a later tool result to an earlier
    // call of the same position. A random id is unique across the whole job.
    const id = call.id ?? `${provider}-tool-${randomUUID()}`;
    const reportedName = call.function?.name;
    const raw = call.function?.arguments;
    if (!reportedName || raw === undefined) {
      console.warn(
        `[sites] provider=${logValue(provider)} invalid tool call index=${index} reason=missing-name-or-arguments`,
      );
      throw new ApplicationError("AGENT_FAILED", `${provider} returned an invalid tool call`);
    }
    let args: unknown;
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
      // Some OpenAI-compatible routers double-encode function arguments.
      if (typeof args === "string") args = JSON.parse(args);
    } catch {
      console.warn(
        `[sites] provider=${logValue(provider)} invalid tool call index=${index} tool=${logValue(reportedName)} reason=malformed-arguments`,
      );
      throw new ApplicationError("AGENT_FAILED", `${provider} returned malformed tool arguments`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new ApplicationError("AGENT_FAILED", `${provider} returned non-object tool arguments`);
    // Coding models commonly request a generic command tool even though this
    // runtime exposes a narrower build tool. Normalize only the one command
    // that the local executor already allow-lists; arbitrary commands remain rejected.
    const normalizedBuildCommand =
      reportedName === "run_command" &&
      (args as Record<string, unknown>).executable === "npm" &&
      JSON.stringify((args as Record<string, unknown>).args) === JSON.stringify(["run", "build"]);
    const name = normalizedBuildCommand ? "run_build" : reportedName;
    if (!isApprovedAgentTool(name)) {
      console.warn(
        `[sites] provider=${logValue(provider)} invalid tool call index=${index} tool=${logValue(reportedName)} reason=unapproved-tool`,
      );
      throw new ApplicationError("AGENT_FAILED", `${provider} returned an invalid tool call`, {
        metadata: { provider, toolName: reportedName, reason: "UNAPPROVED_TOOL" },
      });
    }
    return {
      id,
      name,
      arguments: normalizedBuildCommand ? {} : (args as Readonly<Record<string, unknown>>),
    };
  });
  const usage = response.usage;
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    id: response.id,
    model: response.model,
    message: { role: "assistant", content: choice.message.content ?? "" },
    toolCalls,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    },
    latencyMs,
    finishReason: mapFinish(choice.finish_reason, toolCalls.length),
  };
}

function logValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]/g, "_").slice(0, 100);
}

function mapFinish(
  reason: string | null | undefined,
  calls: number,
): AgentResponse["finishReason"] {
  if (calls || reason === "tool_calls") return "tool_calls";
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "content_filter" || reason === "safety") return "content_filter";
  return reason === "stop" || reason === null || reason === undefined ? "stop" : "error";
}
