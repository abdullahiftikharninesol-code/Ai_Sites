import { ApplicationError } from "../../app/errors/application-error.js";
import type { ErrorCode } from "../../app/errors/application-error.js";

export class DaytonaConfigurationError extends ApplicationError {
  constructor(message: string) {
    super("PROVIDER_CONFIGURATION_ERROR", message);
  }
}

export class DaytonaExecutionError extends ApplicationError {
  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(code, message, { cause });
  }
}
