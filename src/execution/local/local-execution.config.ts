import { resolve } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
export interface LocalExecutionConfig {
  readonly rootDirectory: string;
  readonly keepWorkspace: boolean;
  readonly previewHost: string;
  readonly previewStartTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly maxLogBytes: number;
}
export function loadLocalExecutionConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): LocalExecutionConfig {
  return {
    rootDirectory: resolve(cwd, env.LOCAL_EXECUTION_ROOT?.trim() || ".local-sandboxes"),
    keepWorkspace: booleanValue(env.LOCAL_EXECUTION_KEEP_WORKSPACE, false),
    previewHost: env.LOCAL_PREVIEW_HOST?.trim() || "127.0.0.1",
    previewStartTimeoutMs: integer(
      env.LOCAL_PREVIEW_START_TIMEOUT_MS,
      15_000,
      "LOCAL_PREVIEW_START_TIMEOUT_MS",
    ),
    commandTimeoutMs: integer(env.LOCAL_COMMAND_TIMEOUT_MS, 120_000, "LOCAL_COMMAND_TIMEOUT_MS"),
    maxLogBytes: integer(env.LOCAL_MAX_LOG_BYTES, 256_000, "LOCAL_MAX_LOG_BYTES"),
  };
}
function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApplicationError(
    "VALIDATION_FAILED",
    "LOCAL_EXECUTION_KEEP_WORKSPACE must be true or false",
  );
}
function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be a positive integer`);
  return parsed;
}
