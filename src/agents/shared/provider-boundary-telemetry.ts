/**
 * @file provider-boundary-telemetry.ts
 *
 * Component-safe provider-boundary request measurement.
 * Measures non-sensitive request components individually right before provider invocation.
 * Never stringifies client objects, credentials, auth headers, or secrets.
 */

import type { ProviderBoundaryTelemetry } from "../agent-types.js";
import { estimateTokens } from "../budget/token-estimator.js";

export interface MeasureProviderBoundaryParams {
  readonly systemInstruction?: string | unknown | undefined;
  readonly contents?: readonly unknown[] | undefined;
  readonly tools?: readonly unknown[] | undefined;
  readonly responseSchema?: Readonly<Record<string, unknown>> | unknown | undefined;
  readonly otherMappedContext?: unknown;
}

/**
 * Derives component-safe request size telemetry at the final adapter boundary.
 */
export function measureProviderBoundary(
  params: MeasureProviderBoundaryParams,
): ProviderBoundaryTelemetry {
  const systemInstructionCharacters =
    typeof params.systemInstruction === "string"
      ? params.systemInstruction.length
      : params.systemInstruction
        ? JSON.stringify(params.systemInstruction).length
        : 0;

  let contentsCharacters = 0;
  if (Array.isArray(params.contents)) {
    for (const item of params.contents) {
      if (typeof item === "string") {
        contentsCharacters += item.length;
      } else if (item && typeof item === "object") {
        // Safe measure of message parts / content structures without secrets
        contentsCharacters += JSON.stringify(item).length;
      }
    }
  }

  const toolSchemaCharacters =
    params.tools && Array.isArray(params.tools) && params.tools.length > 0
      ? JSON.stringify(params.tools).length
      : 0;

  const responseSchemaCharacters = params.responseSchema
    ? JSON.stringify(params.responseSchema).length
    : 0;

  const responseSchemaEstimatedTokens = estimateTokens(
    params.responseSchema ? JSON.stringify(params.responseSchema) : "",
  );

  let otherMappedContextCharacters = 0;
  if (params.otherMappedContext) {
    otherMappedContextCharacters = JSON.stringify(params.otherMappedContext).length;
  }

  const providerBoundaryCharacters =
    systemInstructionCharacters +
    contentsCharacters +
    toolSchemaCharacters +
    responseSchemaCharacters +
    otherMappedContextCharacters;

  // Derive estimated tokens from the known non-secret components
  const providerBoundaryEstimatedTokens =
    estimateTokens(
      (typeof params.systemInstruction === "string" ? params.systemInstruction : "") +
        (params.responseSchema ? JSON.stringify(params.responseSchema) : ""),
    ) +
    estimateTokens(params.contents ? JSON.stringify(params.contents) : "") +
    estimateTokens(params.tools ? JSON.stringify(params.tools) : "") +
    estimateTokens(params.otherMappedContext ? JSON.stringify(params.otherMappedContext) : "");

  return {
    systemInstructionCharacters,
    contentsCharacters,
    toolSchemaCharacters,
    responseSchemaCharacters,
    responseSchemaEstimatedTokens,
    otherMappedContextCharacters,
    providerBoundaryCharacters,
    providerBoundaryEstimatedTokens,
  };
}
