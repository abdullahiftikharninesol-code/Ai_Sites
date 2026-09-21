import type { InferenceRunSummary } from "../../agents/budget/inference-run-context.js";
import { ApplicationError } from "../../app/errors/application-error.js";

const display = (value: number | undefined): string =>
  value === undefined ? "N/A" : value.toLocaleString("en-US");

export function siteFailureStage(error: unknown): string {
  const applicationError = error instanceof ApplicationError ? error : undefined;
  if (applicationError?.metadata?.failureStage === "BROWSER_QA") return "BROWSER_QA";
  const code = applicationError?.code;
  if (code === "MODEL_OUTPUT_TRUNCATED") return "STRUCTURED_OUTPUT_TRUNCATED";
  if (code?.startsWith("STRUCTURED_RESPONSE_")) return "STRUCTURED_OUTPUT_PARSE";
  if (code === "GENERATION_INCOMPLETE") return "STRUCTURED_OUTPUT_VALIDATION";
  if (code === "ASSET_REFERENCE_INVALID" || code?.startsWith("ASSET_")) return "ASSET_VALIDATION";
  if (code === "BUILD_FAILED" || code === "REPAIR_LIMIT_REACHED" || code === "PREVIEW_FAILED") return "BUILD";
  if (code?.includes("BROWSER") || code?.includes("QA")) return "BROWSER_QA";
  if (code === "AGENT_FAILED" || code === "PROVIDER_NOT_AVAILABLE") return "PROVIDER";
  if (code === "UNSUPPORTED_SITE_REQUIREMENT" || code?.startsWith("CAPABILITY_")) return "REQUEST_VALIDATION";
  return "STATIC_VALIDATION";
}

export function formatSiteTokenUsage(
  operation: "generate" | "edit",
  provider: string,
  summary: InferenceRunSummary,
  error?: unknown,
): string {
  const usage = summary.providerUsage;
  return [
    "----------",
    "## SITES TOKEN USAGE",
    "",
    `Operation: ${operation}`,
    `Status: ${error === undefined ? "COMPLETED" : "FAILED"}`,
    ...(error === undefined ? [] : [`Failure Stage: ${siteFailureStage(error)}`]),
    `Provider: ${(summary.providersUsed.length ? summary.providersUsed : [provider]).map((id) => id === "groq" ? "Groq" : id === "openai" ? "OpenAI" : id).join(", ")}`,
    `Model: ${summary.modelsUsed.join(", ") || "N/A"}`,
    "",
    `Input Tokens: ${display(usage?.inputTokens)}`,
    `Cached Input Tokens: ${display(usage?.cachedInputTokens)}`,
    `Output Tokens: ${display(usage?.outputTokens)}`,
    `Reasoning Tokens: ${display(usage?.reasoningTokens)}`,
    `Total Tokens: ${display(usage?.totalTokens)}`,
    "",
    `Logical Calls: ${summary.logicalRequests}`,
    `Physical Requests: ${summary.physicalRequests}`,
    `Retries: ${summary.retries}`,
    "",
    `Model Output Received: ${
      error instanceof ApplicationError &&
      typeof error.metadata?.modelOutputReceived === "boolean"
        ? error.metadata.modelOutputReceived
          ? "YES"
          : "NO"
        : usage === undefined
          ? "NO"
          : "YES"
    }`,
    `Website Generated: ${error === undefined ? "YES" : "NO"}`,
    "----------",
  ].join("\n");
}

export function logSiteTokenUsage(
  operation: "generate" | "edit",
  provider: string,
  summary: InferenceRunSummary,
  error?: unknown,
): void {
  console.info(formatSiteTokenUsage(operation, provider, summary, error));
}
