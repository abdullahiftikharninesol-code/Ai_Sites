/**
 * @file structured-response-parser.ts
 *
 * Centralized deterministic parser and runtime validator for structured model responses.
 * Implements strict Markdown code fence stripping without broad regex extraction or guessing.
 */

import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  AgentResponseContract,
  StructuredOutputCapability,
  StructuredResponseTelemetry,
} from "../agent-types.js";

export interface ParseStructuredResponseOptions<T> {
  readonly content: string;
  readonly contract?: AgentResponseContract;
  readonly capability?: StructuredOutputCapability;
  readonly validate: (parsed: unknown) => T;
  readonly errorContext?: string;
}

export interface StructuredResponseParseResult<T> {
  readonly value: T;
  readonly telemetry: StructuredResponseTelemetry;
}

/**
 * Strips the outer markdown fence if and only if the ENTIRE payload is enclosed by a single code fence.
 * Does NOT extract arbitrary JSON blocks embedded in prose.
 */
export function stripOuterMarkdownFence(raw: string): { content: string; stripped: boolean } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return { content: trimmed, stripped: false };
  }

  // Must match opening fence: 3 or more backticks followed by optional language tag
  const openMatch = trimmed.match(/^(`{3,})([^\n]*)\n/);
  if (!openMatch) {
    return { content: trimmed, stripped: false };
  }

  const fenceTicks = openMatch[1] ?? "```";
  // Must end with matching closing fence line (and optional trailing whitespace)
  const closeRegex = new RegExp(`\\n${fenceTicks}\\s*$`);
  if (!closeRegex.test(trimmed)) {
    return { content: trimmed, stripped: false };
  }

  // Remove the opening fence line and closing fence line
  const afterOpen = trimmed.slice(openMatch[0].length);
  const closingIndex = afterOpen.lastIndexOf(fenceTicks);
  const inner = afterOpen.slice(0, closingIndex).trim();

  return { content: inner, stripped: true };
}

/**
 * Parses and validates structured model response according to the provider-neutral response contract.
 */
export function parseStructuredResponse<T>(
  options: ParseStructuredResponseOptions<T>,
): StructuredResponseParseResult<T> {
  const { content, contract, capability = "FALLBACK_TEXT", validate, errorContext = "Agent" } = options;
  const trimmed = content.trim();

  const responseContractType = contract?.type === "JSON_SCHEMA" ? "JSON_SCHEMA" : "TEXT";

  if (!trimmed) {
    throw new ApplicationError(
      "STRUCTURED_RESPONSE_EMPTY",
      `${errorContext} returned an empty structured response`,
      {
        metadata: {
          reason: "STRUCTURED_RESPONSE_EMPTY",
          responseContractType,
          structuredOutputMode: capability,
        },
      },
    );
  }

  const { content: cleanContent, stripped } = stripOuterMarkdownFence(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanContent);
  } catch (cause) {
    throw new ApplicationError(
      "STRUCTURED_RESPONSE_PARSE_FAILED",
      `${errorContext} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        metadata: {
          reason: "STRUCTURED_RESPONSE_PARSE_FAILED",
          responseContractType,
          structuredOutputMode: capability,
          fallbackParserUsed: stripped,
        },
      },
    );
  }

  let validatedValue: T;
  try {
    validatedValue = validate(parsed);
  } catch (cause) {
    throw new ApplicationError(
      "STRUCTURED_RESPONSE_SCHEMA_INVALID",
      `${errorContext} structured response failed schema validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        metadata: {
          reason: "STRUCTURED_RESPONSE_SCHEMA_INVALID",
          responseContractType,
          structuredOutputMode: capability,
          fallbackParserUsed: stripped,
        },
      },
    );
  }

  return {
    value: validatedValue,
    telemetry: {
      responseContractType,
      structuredOutputMode: capability,
      structuredOutputValidated: true,
      fallbackParserUsed: stripped,
    },
  };
}
