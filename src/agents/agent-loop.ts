import { createHash } from "node:crypto";
import { ApplicationError } from "../app/errors/application-error.js";
import type { AgentProvider } from "./agent-provider.js";
import type {
  AgentMessage,
  AgentToolDefinition,
  ReasoningPolicy,
  NormalizedTerminationReason,
} from "./agent-types.js";
import type { SitesToolExecutor } from "./tool-executor.js";
import { getStageAgentTools } from "./tool-catalog.js";
import { SITES_CODING_AGENT_PROMPT } from "./prompts/sites-coding-agent.prompt.js";
import {
  GenerationCompletionValidator,
  formatCompletionIssues,
  type GenerationCompletionRequirements,
  type GenerationCompletionManifest,
  type CompletionIssue,
  type GenerationCompletionTelemetry,
} from "./validation/generation-completion.js";

export interface AgentLoopResult {
  readonly turns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly latencyMs: number;
  readonly reasoningTokens?: number | undefined;
  readonly retryCount?: number | undefined;
  readonly providerId: string;
  readonly model: string;
  readonly limitReached?: boolean | undefined;
  readonly completionAccepted?: boolean | undefined;
  readonly completionIssues?: readonly CompletionIssue[] | undefined;
  readonly generationCompletion?: GenerationCompletionTelemetry | undefined;
  readonly normalizedFinishReason?: NormalizedTerminationReason | undefined;
}

export interface AgentLoopOptions {
  readonly maxTurns?: number | undefined;
  readonly maxToolCalls?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly finalizeOnMaxTurns?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly requireFilesWritten?: boolean | undefined;
  readonly finalizeOnWrite?: boolean | undefined;
  readonly stage?: string | undefined;
  readonly tools?: readonly AgentToolDefinition[] | undefined;
  readonly completionRequirements?: GenerationCompletionRequirements | undefined;
  readonly reasoningPolicy?: ReasoningPolicy | undefined;
  readonly compactHistory?: boolean | undefined;
}

export class AgentCodingLoop {
  readonly #options: AgentLoopOptions;

  constructor(
    private readonly agent: AgentProvider,
    private readonly tools: SitesToolExecutor,
    options: number | AgentLoopOptions = 10,
  ) {
    this.#options = typeof options === "number" ? { maxTurns: options } : options;
  }

  async run(environmentId: string, instruction: string): Promise<AgentLoopResult> {
    const messages: AgentMessage[] = [{ role: "user", content: instruction }];
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let latencyMs = 0;
    let reasoningTokens = 0;
    let retryCount = 0;

    let completionAttempts = 0;
    let rejectedAttempts = 0;
    let completionAccepted = false;
    let lastIssues: readonly CompletionIssue[] | undefined;

    const maxTurns = this.#options.maxTurns ?? 10;
    const maxToolCalls = this.#options.maxToolCalls ?? 40;

    const availableTools =
      this.#options.tools ??
      getStageAgentTools(this.#options.stage, this.#options.completionRequirements);

    const validator = this.#options.completionRequirements
      ? new GenerationCompletionValidator(this.tools.executionProvider)
      : undefined;

    let normalizedFinishReason: NormalizedTerminationReason = "SUCCESS";

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      this.#assertActive();
      const messagesToSend =
        turn > 1 && this.#options.compactHistory !== false
          ? compactConversationHistory(messages)
          : messages;

      const response = await this.agent.createResponse({
        model: this.agent.getCapabilities().models[0] ?? "mock",
        systemInstructions: SITES_CODING_AGENT_PROMPT,
        messages: messagesToSend,
        tools: availableTools,
        maxOutputTokens: this.#options.maxOutputTokens ?? 8_192,
        ...(this.#options.reasoningPolicy ? { reasoningPolicy: this.#options.reasoningPolicy } : {}),
        ...(this.#options.signal ? { signal: this.#options.signal } : {}),
      });

      normalizedFinishReason =
        response.normalizedFinishReason ??
        (response.finishReason === "length"
          ? "OUTPUT_TRUNCATED"
          : response.finishReason === "content_filter"
            ? "CONTENT_FILTER"
            : response.finishReason === "error"
              ? "ERROR"
              : response.toolCalls.length === 0 &&
                  this.#options.requireFilesWritten &&
                  this.tools.filesWritten === 0
                ? "MODEL_TOOL_PROTOCOL_FAILURE"
                : "SUCCESS");

      inputTokens += response.usage.inputTokens;
      cachedInputTokens += response.usage.cachedInputTokens ?? 0;
      outputTokens += response.usage.outputTokens;
      reasoningTokens += response.usage.reasoningTokens ?? 0;
      retryCount += response.usage.retryCount ?? 0;
      latencyMs += response.latencyMs;

      messages.push({ ...response.message, toolCalls: response.toolCalls });

      // Handle 0 tool calls
      if (response.toolCalls.length === 0) {
        if (this.#options.completionRequirements && turn < maxTurns) {
          messages.push({
            role: "user",
            content:
              "Generation is not complete. You must implement all required site artifacts, ensure structural markers (data-sites-page, data-sites-section) are present, and call the finalize_generation tool with your completion manifest.",
          });
          continue;
        }

        if (this.#options.requireFilesWritten && this.tools.filesWritten === 0 && turn < maxTurns) {
          if (response.finishReason === "length") {
            messages.push({
              role: "user",
              content:
                "Your previous response was truncated because it reached the token limit. Do not output large conversational text or huge monolithic files. Please call the write_file tool to save the necessary code (starting by replacing src/App.tsx) in concise, modular files now.",
            });
          } else {
            messages.push({
              role: "user",
              content:
                "You have not created or modified any files in the workspace yet. Chat messages or markdown code blocks do NOT modify files on disk. You must invoke the write_file tool to replace src/App.tsx and create required components/styles. Call write_file now.",
            });
          }
          continue;
        }

        return {
          turns: turn,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          toolCalls,
          latencyMs,
          reasoningTokens,
          retryCount,
          providerId: this.agent.id,
          model: response.model,
          limitReached:
            this.#options.requireFilesWritten === true && this.tools.filesWritten === 0,
          completionAccepted: this.#options.completionRequirements ? false : undefined,
          normalizedFinishReason,
          ...(lastIssues ? { completionIssues: lastIssues } : {}),
          ...(this.#options.completionRequirements
            ? {
                generationCompletion: {
                  attempts: completionAttempts,
                  accepted: false,
                  rejectedAttempts,
                  ...(lastIssues ? { lastIssues } : {}),
                },
              }
            : {}),
        };
      }

      toolCalls += response.toolCalls.length;
      if (toolCalls > maxToolCalls) {
        throw new ApplicationError(
          "AGENT_FAILED",
          `Agent exceeded maximum of ${maxToolCalls} tool calls`,
        );
      }

      // Partition tool calls: non-finalization mutations vs finalization control calls
      const standardCalls = response.toolCalls.filter(
        (call) => call.name !== "finalize_generation",
      );
      const finalizeCalls = response.toolCalls.filter(
        (call) => call.name === "finalize_generation",
      );

      // 1. Execute all standard mutation/inspection calls in order
      const standardObservations = new Map<string, { toolCallId: string; output: string }>();
      const readOnly = new Set(["list_files", "read_file", "search_files", "read_logs"]);
      if (standardCalls.length > 0) {
        if (standardCalls.every((call) => readOnly.has(call.name))) {
          const results = await Promise.all(
            standardCalls.map((call) => this.tools.executeSafe(environmentId, call)),
          );
          for (const res of results) standardObservations.set(res.toolCallId, res);
        } else {
          for (const call of standardCalls) {
            const res = await this.tools.executeSafe(environmentId, call);
            standardObservations.set(res.toolCallId, res);
          }
        }
      }

      // 2. Evaluate finalization control call(s) AFTER mutations
      const finalizeObservations = new Map<string, { toolCallId: string; output: string }>();
      if (finalizeCalls.length > 0) {
        completionAttempts += 1;

        // If multiple finalize_generation calls exist, mark earlier ones superseded
        for (let i = 0; i < finalizeCalls.length - 1; i++) {
          const call = finalizeCalls[i]!;
          finalizeObservations.set(call.id, {
            toolCallId: call.id,
            output: "Superseded by later finalize_generation call in the same response.",
          });
        }

        // Evaluate the final finalize_generation call against the post-mutation workspace
        const effectiveFinalizeCall = finalizeCalls[finalizeCalls.length - 1]!;
        if (validator && this.#options.completionRequirements) {
          const validationResult = await validator.validate(
            environmentId,
            this.#options.completionRequirements,
            effectiveFinalizeCall.arguments as unknown as GenerationCompletionManifest,
          );
          if (validationResult.valid) {
            completionAccepted = true;
            lastIssues = undefined;
            finalizeObservations.set(effectiveFinalizeCall.id, {
              toolCallId: effectiveFinalizeCall.id,
              output:
                "Generation completion accepted. All requirements and structural markers verified.",
            });
          } else {
            rejectedAttempts += 1;
            lastIssues = validationResult.issues;
            finalizeObservations.set(effectiveFinalizeCall.id, {
              toolCallId: effectiveFinalizeCall.id,
              output: formatCompletionIssues(validationResult.issues),
            });
          }
        } else {
          completionAccepted = true;
          finalizeObservations.set(effectiveFinalizeCall.id, {
            toolCallId: effectiveFinalizeCall.id,
            output: "Generation completion accepted.",
          });
        }
      }

      // 3. Assemble observations in the exact order of the original toolCalls
      for (const call of response.toolCalls) {
        const obs =
          standardObservations.get(call.id) ?? finalizeObservations.get(call.id);
        if (obs) {
          this.#assertActive();
          messages.push({
            role: "tool",
            toolCallId: obs.toolCallId,
            content: obs.output,
          });
        }
      }

      // 4. If finalization was accepted, finish immediately
      if (completionAccepted) {
        return {
          turns: turn,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          toolCalls,
          latencyMs,
          reasoningTokens,
          retryCount,
          providerId: this.agent.id,
          model: response.model,
          limitReached: false,
          completionAccepted: true,
          normalizedFinishReason,
          ...(this.#options.completionRequirements
            ? {
                generationCompletion: {
                  attempts: completionAttempts,
                  accepted: true,
                  rejectedAttempts,
                },
              }
            : {}),
        };
      }

      // 5. If finalizeOnWrite is enabled (e.g. EDIT_SITE or BUILD_REPAIR) and no completion requirements
      if (
        !this.#options.completionRequirements &&
        this.#options.finalizeOnWrite &&
        this.tools.filesWritten > 0
      ) {
        return {
          turns: turn,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          toolCalls,
          latencyMs,
          reasoningTokens,
          retryCount,
          providerId: this.agent.id,
          model: response.model,
          limitReached: false,
          normalizedFinishReason,
        };
      }

      // 6. If completion requirements were active but model did NOT call finalize_generation, prompt continuation
      if (this.#options.completionRequirements && finalizeCalls.length === 0 && turn < maxTurns) {
        messages.push({
          role: "user",
          content:
            "Generation is not complete. You have modified files but did not call finalize_generation. Complete all required site artifacts, ensure structural markers (data-sites-page, data-sites-section) are present, and call finalize_generation with your completion manifest.",
        });
      }

      if (turn === maxTurns && this.#options.finalizeOnMaxTurns) {
        return {
          turns: turn,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          toolCalls,
          latencyMs,
          reasoningTokens,
          retryCount,
          providerId: this.agent.id,
          model: response.model,
          limitReached: true,
          completionAccepted: false,
          normalizedFinishReason,
          ...(lastIssues ? { completionIssues: lastIssues } : {}),
          ...(this.#options.completionRequirements
            ? {
                generationCompletion: {
                  attempts: completionAttempts,
                  accepted: false,
                  rejectedAttempts,
                  ...(lastIssues ? { lastIssues } : {}),
                },
              }
            : {}),
        };
      }
    }

    throw new ApplicationError("AGENT_FAILED", `Agent exceeded maximum of ${maxTurns} turns`);
  }

  #assertActive(): void {
    if (this.#options.signal?.aborted)
      throw new ApplicationError("JOB_CANCELLED", "Sites job was cancelled");
  }
}

/**
 * Compacts historical conversation turns to avoid blowing up context on continuation turns.
 * Persists receipts instead of duplicating large file contents in tool calls.
 * Preserves tool_call_id pairing and latest turn resolution.
 */
export function compactConversationHistory(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  let latestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      latestAssistantIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const isLatest = idx === latestAssistantIdx;
      const compactedCalls = msg.toolCalls.map((call) => {
        if (call.name === "write_file") {
          const content = typeof call.arguments.content === "string" ? call.arguments.content : "";
          const path = typeof call.arguments.path === "string" ? call.arguments.path : "unknown";
          if (call.arguments.persistedReceipt) {
            return call;
          }
          const bytes = Buffer.byteLength(content, "utf8");
          const sha256 = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
          const receipt = isLatest
            ? [
                "PERSISTED TOOL ACTION",
                "tool: write_file",
                `path: ${path}`,
                `bytes: ${bytes}`,
                `sha256: ${sha256}`,
                "status: success",
                "full historical content omitted",
                "current file remains available through read_file",
              ].join("\n")
            : `PERSISTED HISTORICAL ACTION: write_file to ${path} (${bytes} bytes, sha256: ${sha256})`;

          return {
            ...call,
            arguments: {
              path,
              persistedReceipt: receipt,
            },
          };
        }
        return call;
      });

      return {
        ...msg,
        toolCalls: compactedCalls,
      };
    }

    return msg;
  });
}
