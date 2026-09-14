import { ApplicationError } from "../../app/errors/application-error.js";
import type { StructuredOutputCapability } from "../agent-types.js";

export interface CommonAgentConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly parallelToolCalling?: boolean;
  readonly structuredOutputCapability?: StructuredOutputCapability;
}

export function isPlaceholderApiKey(key: string): boolean {
  const trimmed = key.trim();
  return (
    /^(your[_-]|todo|changeme|placeholder|<)/i.test(trimmed) ||
    /^(your[_-]?api[_-]?key|your[_-]?fresh[_-]?key|api[_-]?key[_-]?here)/i.test(trimmed) ||
    trimmed.endsWith(">")
  );
}

export function loadCommonAgentConfig(
  env: NodeJS.ProcessEnv,
  prefix: string,
  providerName: string,
  defaultModel: string,
): CommonAgentConfig {
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  if (!apiKey)
    throw new ApplicationError(
      "PROVIDER_NOT_AVAILABLE",
      `${prefix}_API_KEY is required for the ${providerName} agent provider`,
    );
  if (isPlaceholderApiKey(apiKey))
    throw new ApplicationError(
      "PROVIDER_NOT_AVAILABLE",
      `${prefix}_API_KEY is not configured: found placeholder credential. Please supply a valid API key.`,
    );
  return {
    apiKey,
    model: env[`${prefix}_AGENT_MODEL`]?.trim() || defaultModel,
    timeoutMs: integer(env[`${prefix}_AGENT_TIMEOUT_MS`], 60_000, 1, `${prefix}_AGENT_TIMEOUT_MS`),
    // Keep retries conservative: every agent turn is already a separate model request.
    // A default of two retries could triple all requests in a multi-turn coding session.
    maxRetries: integer(env[`${prefix}_AGENT_MAX_RETRIES`], 1, 0, `${prefix}_AGENT_MAX_RETRIES`),
  };
}

function integer(value: string | undefined, fallback: number, minimum: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be an integer >= ${minimum}`);
  return parsed;
}
