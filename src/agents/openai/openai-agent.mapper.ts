import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  AgentRequest,
  AgentResponse,
  AgentToolCall,
  AgentToolDefinition,
} from "../agent-types.js";
import { isApprovedAgentTool } from "../tool-catalog.js";
import { projectOpenAISchema } from "../../sites/domain/site-plan-schema.js";

export interface OpenAIFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}
export type OpenAIInputItem = Readonly<Record<string, unknown>>;
export interface OpenAIResponseRequest {
  readonly model: string;
  readonly instructions?: string;
  readonly input: readonly OpenAIInputItem[];
  readonly tools: readonly OpenAIFunctionTool[];
  readonly store: false;
  readonly parallel_tool_calls: true;
  readonly prompt_cache_key?: string;
  readonly max_output_tokens?: number;
  readonly reasoning?: { readonly effort: string };
  readonly text?: {
    readonly format?: {
      readonly type: "json_schema" | "json_object" | "text";
      readonly name?: string;
      readonly schema?: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
    };
  };
}
export interface OpenAIResponseLike {
  readonly id: string;
  readonly model: string;
  readonly output?: readonly unknown[];
  readonly output_text?: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
    readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  };
}

export function mapToolDefinition(tool: AgentToolDefinition): OpenAIFunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  };
}
/**
 * Splits the first user message at the caller's stable/variable boundary and
 * marks it with an explicit cache breakpoint, so the reusable prefix ends exactly
 * where the prompt stops being stable instead of wherever the implicit
 * breakpoint lands. Falls back to a plain message when there is nothing to split.
 */
function userInputItem(
  message: AgentRequest["messages"][number],
  request: AgentRequest,
  position: number,
): OpenAIInputItem {
  if (message.imageParts?.length) {
    return {
      role: message.role,
      content: [
        ...message.imageParts.map((part) => ({
          type: "input_image",
          image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`,
        })),
        ...(message.content ? [{ type: "input_text", text: message.content }] : []),
      ],
    };
  }
  const boundary = request.cachePrefixChars;
  if (
    position !== 0 ||
    message.role !== "user" ||
    boundary === undefined ||
    boundary <= 0 ||
    boundary >= message.content.length
  )
    return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: [
      {
        type: "input_text",
        text: message.content.slice(0, boundary),
        prompt_cache_breakpoint: { mode: "explicit" },
      },
      { type: "input_text", text: message.content.slice(boundary) },
    ],
  };
}

export function mapAgentRequest(
  request: AgentRequest,
  reasoningEffort?: string,
): OpenAIResponseRequest {
  const input: OpenAIInputItem[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ApplicationError("AGENT_FAILED", "Tool observation is missing its call ID");
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) input.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls)
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      continue;
    }
    if (message.role !== "system") input.push(userInputItem(message, request, input.length));
  }
  return {
    model: request.model,
    ...(request.systemInstructions ? { instructions: request.systemInstructions } : {}),
    input,
    tools: (request.tools ?? []).map(mapToolDefinition),
    store: false,
    parallel_tool_calls: true,
    ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(request.responseContract?.type === "JSON_SCHEMA"
      ? {
          text: {
            format: {
              type: "json_schema" as const,
              name: request.responseContract.name,
              schema: projectOpenAISchema(request.responseContract.schema),
              ...(request.responseContract.strict !== undefined
                ? { strict: request.responseContract.strict }
                : {}),
            },
          },
        }
      : {}),
  };
}

export function normalizeOpenAIResponse(
  response: OpenAIResponseLike,
  latencyMs: number,
): AgentResponse {
  const toolCalls: AgentToolCall[] = [];
  for (const candidate of response.output ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    if (item.type !== "function_call") continue;
    if (
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string" ||
      !isApprovedAgentTool(item.name)
    )
      throw new ApplicationError("AGENT_FAILED", "OpenAI returned an invalid tool call");
    let args: unknown;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      throw new ApplicationError("AGENT_FAILED", "OpenAI returned malformed tool arguments");
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new ApplicationError("AGENT_FAILED", "OpenAI returned non-object tool arguments");
    toolCalls.push({
      id: item.call_id,
      name: item.name,
      arguments: args as Readonly<Record<string, unknown>>,
    });
  }
  const usage = response.usage;
  const incomplete = response.status === "incomplete";
  return {
    id: response.id,
    model: response.model,
    message: { role: "assistant", content: response.output_text ?? "" },
    toolCalls,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      ...(usage?.input_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
        : {}),
      outputTokens: usage?.output_tokens ?? 0,
      ...(usage?.output_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
        : {}),
      ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    },
    latencyMs,
    finishReason: incomplete
      ? response.incomplete_details?.reason === "max_output_tokens"
        ? "length"
        : "error"
      : toolCalls.length
        ? "tool_calls"
        : "stop",
  };
}
