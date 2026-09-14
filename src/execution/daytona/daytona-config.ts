import { DaytonaConfigurationError } from "./daytona-errors.js";

export interface DaytonaConfig {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly target?: string;
  readonly cpu: number;
  readonly memoryGb: number;
  readonly diskGb: number;
  readonly sandboxTtlMinutes: number;
  readonly commandTimeoutMs: number;
  readonly previewStartTimeoutMs: number;
  readonly previewUrlTtlSeconds: number;
  readonly maxLogBytes: number;
}

function positive(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0)
    throw new DaytonaConfigurationError(`${key} must be a positive number`);
  return value;
}

export function loadDaytonaConfig(env: NodeJS.ProcessEnv = process.env): DaytonaConfig {
  const apiKey = env.DAYTONA_API_KEY?.trim();
  if (!apiKey)
    throw new DaytonaConfigurationError(
      "DAYTONA_API_KEY is required when EXECUTION_PROVIDER=daytona",
    );
  return {
    apiKey,
    ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
    ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}),
    cpu: positive(env, "DAYTONA_DEFAULT_CPU", 2),
    memoryGb: positive(env, "DAYTONA_DEFAULT_MEMORY_GB", 4),
    diskGb: positive(env, "DAYTONA_DEFAULT_DISK_GB", 10),
    sandboxTtlMinutes: positive(env, "DAYTONA_SANDBOX_TTL_MINUTES", 60),
    commandTimeoutMs: positive(env, "DAYTONA_COMMAND_TIMEOUT_MS", 180_000),
    previewStartTimeoutMs: positive(env, "DAYTONA_PREVIEW_START_TIMEOUT_MS", 30_000),
    previewUrlTtlSeconds: positive(env, "DAYTONA_PREVIEW_URL_TTL_SECONDS", 3600),
    maxLogBytes: positive(env, "DAYTONA_MAX_LOG_BYTES", 128_000),
  };
}
