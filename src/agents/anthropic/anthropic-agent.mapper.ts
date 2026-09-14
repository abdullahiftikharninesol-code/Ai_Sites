import { ApplicationError } from "../../app/errors/application-error.js";
import type { AgentRequest, AgentResponse, AgentToolCall } from "../agent-types.js";
import { isApprovedAgentTool } from "../tool-catalog.js";

export interface AnthropicMessageRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly tools: readonly Record<string, unknown>[];
}
export interface AnthropicMessageLike {
  readonly id: string;
  readonly model: string;
  readonly content: readonly unknown[];
  readonly stop_reason?: string | null;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
}
export interface AnthropicMessagesClient {
  create(
    request: AnthropicMessageRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AnthropicMessageLike>;
}
export function mapAnthropicRequest(request: AgentRequest): AnthropicMessageRequest {
  const messages: Record<string, unknown>[] = [];
  let pendingResults: Record<string, unknown>[] = [];
  const flush = () => {
    if (pendingResults.length) {
      messages.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ApplicationError("AGENT_FAILED", "Tool observation is missing its call ID");
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    flush();
    if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        ],
      });
    } else messages.push({ role: message.role, content: message.content });
  }
  flush();
  return {
    model: request.model,
    max_tokens: Math.min(request.maxOutputTokens ?? 8_192, 8_192),
    ...(request.systemInstructions ? { system: request.systemInstructions } : {}),
    messages,
    tools: (request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  };
}
export function normalizeAnthropicResponse(
  response: AnthropicMessageLike,
  latencyMs: number,
): AgentResponse {
  const calls: AgentToolCall[] = [];
  const text: string[] = [];
  for (const block of response.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") text.push(item.text);
    if (item.type === "tool_use") {
      if (
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        !isApprovedAgentTool(item.name) ||
        !item.input ||
        typeof item.input !== "object" ||
        Array.isArray(item.input)
      )
        throw new ApplicationError("AGENT_FAILED", "anthropic returned an invalid tool call");
      calls.push({
        id: item.id,
        name: item.name,
        arguments: item.input as Readonly<Record<string, unknown>>,
      });
    }
  }
  const cached = response.usage?.cache_read_input_tokens;
  return {
    id: response.id,
    model: response.model,
    message: { role: "assistant", content: text.join("\n") },
    toolCalls: calls,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    },
    latencyMs,
    finishReason:
      calls.length || response.stop_reason === "tool_use"
        ? "tool_calls"
        : response.stop_reason === "max_tokens"
          ? "length"
          : response.stop_reason === "refusal"
            ? "content_filter"
            : response.stop_reason === "end_turn" ||
                response.stop_reason === "stop_sequence" ||
                response.stop_reason == null
              ? "stop"
              : "error",
  };
}
