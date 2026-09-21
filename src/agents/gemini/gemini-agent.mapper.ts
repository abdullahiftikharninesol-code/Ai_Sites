import { ApplicationError } from "../../app/errors/application-error.js";
import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentRequest, AgentResponse, AgentToolCall } from "../agent-types.js";
import { isApprovedAgentTool } from "../tool-catalog.js";
import { projectGeminiSchema } from "../../sites/domain/site-plan-schema.js";

function geminiParts(message: AgentMessage): Record<string, unknown>[] {
  const imageParts = (message.imageParts ?? []).map((part) => ({
    inlineData: { mimeType: part.mimeType, data: Buffer.from(part.data).toString("base64") },
  }));
  return [...imageParts, ...(message.content ? [{ text: message.content }] : [])];
}
export interface GeminiRequest {
  readonly model: string;
  readonly contents: readonly Record<string, unknown>[];
  readonly config: Readonly<Record<string, unknown>>;
}
export interface GeminiResponseLike {
  readonly responseId?: string;
  readonly modelVersion?: string;
  readonly text?: string;
  readonly candidates?: readonly {
    readonly finishReason?: string;
    readonly content?: { readonly parts?: readonly unknown[] };
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly cachedContentTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly thoughtsTokenCount?: number;
    readonly totalTokenCount?: number;
  };
  readonly promptFeedback?: { readonly blockReason?: string };
}
export interface GeminiModelsClient {
  generateContent(request: GeminiRequest): Promise<GeminiResponseLike>;
}
export function mapGeminiRequest(
  request: AgentRequest,
  thinkingBudget?: number,
): GeminiRequest {
  const contents: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.geminiParts) {
      contents.push({ role: "model", parts: message.geminiParts });
      continue;
    }
    if (message.role === "tool") {
      if (!message.toolCallId)
        throw new ApplicationError("AGENT_FAILED", "Tool observation is missing its call ID");
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: message.toolCallId,
              name: toolNameFor(message.toolCallId, request),
              response: { output: message.content },
            },
          },
        ],
      });
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      contents.push({
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            functionCall: { id: call.id, name: call.name, args: call.arguments },
          })),
        ],
      });
    } else
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: geminiParts(message),
      });
  }
  return {
    model: request.model,
    contents,
    config: {
      ...(request.systemInstructions ? { systemInstruction: request.systemInstructions } : {}),
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: (request.tools ?? []).map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
      ...(request.responseContract?.type === "JSON_SCHEMA"
        ? {
            responseMimeType: "application/json",
            responseSchema: projectGeminiSchema(request.responseContract.schema),
          }
        : {}),
    },
  };
}
function toolNameFor(id: string, request: AgentRequest): string {
  for (const message of [...request.messages].reverse())
    for (const call of message.toolCalls ?? []) if (call.id === id) return call.name;
  throw new ApplicationError("AGENT_FAILED", `No tool call found for observation ${id}`);
}
export function normalizeGeminiResponse(
  response: GeminiResponseLike,
  fallbackModel: string,
  latencyMs: number,
): AgentResponse {
  const candidate = response.candidates?.[0];
  if (response.promptFeedback?.blockReason || !candidate)
    return {
      id: response.responseId ?? "gemini-blocked",
      model: response.modelVersion ?? fallbackModel,
      message: { role: "assistant", content: "" },
      toolCalls: [],
      usage: usage(response),
      latencyMs,
      finishReason: response.promptFeedback?.blockReason ? "content_filter" : "error",
    };
  const calls: AgentToolCall[] = [];
  const texts: string[] = [];
  const parts: Record<string, unknown>[] = [];
  for (const part of candidate.content?.parts ?? []) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    parts.push(value);
    if (typeof value.text === "string") texts.push(value.text);
    if (value.functionCall && typeof value.functionCall === "object") {
      const call = value.functionCall as Record<string, unknown>;
      const name = call.name;
      if (
        typeof name !== "string" ||
        !isApprovedAgentTool(name) ||
        !call.args ||
        typeof call.args !== "object" ||
        Array.isArray(call.args)
      )
        throw new ApplicationError("AGENT_FAILED", "gemini returned an invalid tool call");
      calls.push({
        id: typeof call.id === "string" ? call.id : `gemini-${randomUUID()}`,
        name,
        arguments: call.args as Readonly<Record<string, unknown>>,
      });
      parts[parts.length - 1] = { ...value, functionCall: { ...call, id: calls.at(-1)!.id } };
    }
  }
  const finish = candidate.finishReason;
  return {
    id: response.responseId ?? "gemini-response",
    model: response.modelVersion ?? fallbackModel,
    message: {
      role: "assistant",
      content: texts.join("\n") || response.text || "",
      geminiParts: parts,
    },
    toolCalls: calls,
    usage: usage(response),
    latencyMs,
    finishReason: calls.length
      ? "tool_calls"
      : finish === "MAX_TOKENS"
        ? "length"
        : ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(finish ?? "")
          ? "content_filter"
          : finish === "STOP" || finish === undefined
            ? "stop"
            : "error",
  };
}
function usage(response: GeminiResponseLike): AgentResponse["usage"] {
  const value = response.usageMetadata;
  return {
    inputTokens: value?.promptTokenCount ?? 0,
    outputTokens: value?.candidatesTokenCount ?? 0,
    ...(value?.cachedContentTokenCount !== undefined
      ? { cachedInputTokens: value.cachedContentTokenCount }
      : {}),
    ...(value?.thoughtsTokenCount !== undefined
      ? { reasoningTokens: value.thoughtsTokenCount }
      : {}),
    ...(value?.totalTokenCount !== undefined ? { totalTokens: value.totalTokenCount } : {}),
  };
}
