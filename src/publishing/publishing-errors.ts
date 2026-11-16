/**
 * User-safe publishing failures. Codes are stable; messages never contain
 * tokens, workspace paths or raw provider responses. `metadata` is bounded
 * diagnostic data that may be persisted on a preparation record.
 */
export type PublishingErrorCode =
  | "PUBLISH_VERSION_NOT_CURRENT"
  | "PUBLISH_VERSION_NOT_VERIFIED"
  | "PUBLISH_SOURCE_UNAVAILABLE"
  | "PUBLISH_SOURCE_INVALID"
  | "PUBLISH_DEPENDENCY_INSTALL_FAILED"
  | "PUBLISH_BUILD_FAILED"
  | "PUBLISH_BUILD_TIMEOUT"
  | "PUBLISH_ARTIFACT_INVALID"
  | "PUBLISH_ARTIFACT_UNAVAILABLE"
  | "PUBLISH_PREPARATION_BUSY"
  | "PUBLISH_RETRY_LIMIT_REACHED"
  | "PUBLISH_PREPARATION_FAILED"
  | "PUBLISH_PREPARATION_NOT_FOUND"
  | "PUBLISH_SITE_NOT_TRUSTED"
  | "PUBLISH_ISOLATION_UNAVAILABLE"
  | "PUBLISH_BUILD_QUOTA_EXCEEDED"
  | "PUBLISH_BUILD_WORKER_FAILED"
  | "PUBLISH_LIVE_DISABLED"
  | "PUBLISH_IN_PROGRESS"
  | "PUBLISH_LIMIT_EXCEEDED"
  | "PUBLISH_VERIFICATION_FAILED"
  | "PUBLISH_PUBLIC_URL_PROTECTED"
  | "PUBLISH_INTERRUPTED"
  | "VERCEL_UPLOAD_FAILED"
  | "VERCEL_DEPLOYMENT_FAILED"
  | "VERCEL_DEPLOYMENT_TIMEOUT"
  | "VERCEL_DEPLOYMENT_UNCONFIRMED"
  | "PUBLISH_PROMOTION_UNCONFIRMED"
  | "PUBLISH_REQUEST_BUDGET_EXCEEDED"
  | "PUBLISH_PRODUCTION_CHANGED"
  | "PUBLISH_UPDATE_ROLLED_BACK"
  | "VERCEL_PROJECT_UNAVAILABLE"
  | "VERCEL_INTEGRATION_NOT_CONFIGURED"
  | "VERCEL_NOT_CONNECTED"
  | "VERCEL_TOKEN_UNAVAILABLE"
  | "VERCEL_TOKEN_REVOKED"
  | "VERCEL_INTEGRATION_DISABLED"
  | "VERCEL_ACCOUNT_MISMATCH"
  | "VERCEL_PROJECT_ACCESS_RESTRICTED"
  | "VERCEL_PROJECT_SCOPE_MISSING"
  | "VERCEL_PROJECT_LINK_IN_PROGRESS"
  | "VERCEL_PLAN_LIMIT"
  | "VERCEL_RATE_LIMITED"
  | "VERCEL_UNAVAILABLE"
  | "VERCEL_REQUEST_REJECTED";

const STATUS: Readonly<Record<PublishingErrorCode, number>> = {
  PUBLISH_VERSION_NOT_CURRENT: 409,
  PUBLISH_VERSION_NOT_VERIFIED: 422,
  PUBLISH_SOURCE_UNAVAILABLE: 422,
  PUBLISH_SOURCE_INVALID: 422,
  PUBLISH_DEPENDENCY_INSTALL_FAILED: 502,
  PUBLISH_BUILD_FAILED: 422,
  PUBLISH_BUILD_TIMEOUT: 504,
  PUBLISH_ARTIFACT_INVALID: 422,
  PUBLISH_ARTIFACT_UNAVAILABLE: 422,
  PUBLISH_PREPARATION_BUSY: 429,
  PUBLISH_RETRY_LIMIT_REACHED: 409,
  PUBLISH_PREPARATION_FAILED: 500,
  PUBLISH_PREPARATION_NOT_FOUND: 404,
  PUBLISH_SITE_NOT_TRUSTED: 403,
  PUBLISH_ISOLATION_UNAVAILABLE: 503,
  PUBLISH_BUILD_QUOTA_EXCEEDED: 429,
  PUBLISH_BUILD_WORKER_FAILED: 502,
  PUBLISH_LIVE_DISABLED: 403,
  PUBLISH_IN_PROGRESS: 409,
  PUBLISH_LIMIT_EXCEEDED: 422,
  PUBLISH_VERIFICATION_FAILED: 502,
  PUBLISH_PUBLIC_URL_PROTECTED: 502,
  PUBLISH_INTERRUPTED: 503,
  VERCEL_UPLOAD_FAILED: 502,
  VERCEL_DEPLOYMENT_FAILED: 502,
  VERCEL_DEPLOYMENT_TIMEOUT: 504,
  VERCEL_DEPLOYMENT_UNCONFIRMED: 504,
  PUBLISH_PROMOTION_UNCONFIRMED: 504,
  PUBLISH_REQUEST_BUDGET_EXCEEDED: 504,
  PUBLISH_PRODUCTION_CHANGED: 409,
  PUBLISH_UPDATE_ROLLED_BACK: 502,
  VERCEL_PROJECT_UNAVAILABLE: 409,
  VERCEL_INTEGRATION_NOT_CONFIGURED: 503,
  VERCEL_NOT_CONNECTED: 409,
  VERCEL_TOKEN_UNAVAILABLE: 409,
  VERCEL_TOKEN_REVOKED: 409,
  VERCEL_INTEGRATION_DISABLED: 403,
  VERCEL_ACCOUNT_MISMATCH: 409,
  VERCEL_PROJECT_ACCESS_RESTRICTED: 403,
  VERCEL_PROJECT_SCOPE_MISSING: 403,
  VERCEL_PROJECT_LINK_IN_PROGRESS: 409,
  VERCEL_PLAN_LIMIT: 402,
  VERCEL_RATE_LIMITED: 429,
  VERCEL_UNAVAILABLE: 502,
  VERCEL_REQUEST_REJECTED: 502,
};

/** Failures a later explicit request may retry (environmental, not the site itself). */
const RETRYABLE = new Set<PublishingErrorCode>([
  "PUBLISH_DEPENDENCY_INSTALL_FAILED",
  "PUBLISH_BUILD_TIMEOUT",
  "PUBLISH_PREPARATION_FAILED",
  "PUBLISH_ISOLATION_UNAVAILABLE",
  "PUBLISH_BUILD_WORKER_FAILED",
  "VERCEL_PROJECT_ACCESS_RESTRICTED",
  "VERCEL_PROJECT_SCOPE_MISSING",
  "VERCEL_INTEGRATION_DISABLED",
  "VERCEL_TOKEN_REVOKED",
  "VERCEL_PROJECT_LINK_IN_PROGRESS",
  "VERCEL_PLAN_LIMIT",
  "VERCEL_RATE_LIMITED",
  "VERCEL_UNAVAILABLE",
  "VERCEL_REQUEST_REJECTED",
  "VERCEL_ACCOUNT_MISMATCH",
  "PUBLISH_VERIFICATION_FAILED",
  "PUBLISH_PUBLIC_URL_PROTECTED",
  "PUBLISH_INTERRUPTED",
  "VERCEL_UPLOAD_FAILED",
  "VERCEL_DEPLOYMENT_FAILED",
  "VERCEL_DEPLOYMENT_TIMEOUT",
  "VERCEL_DEPLOYMENT_UNCONFIRMED",
  "PUBLISH_PROMOTION_UNCONFIRMED",
  "PUBLISH_REQUEST_BUDGET_EXCEEDED",
  "VERCEL_PROJECT_UNAVAILABLE",
]);

/**
 * `instanceof` that survives duplicate module instances (seen on Windows when
 * one file is loaded under both `d:` and `D:`): a global Symbol.for brand is
 * checked for the branded class itself; subclasses keep ordinary semantics.
 */
export function brandedInstanceCheck(brand: symbol, base: abstract new (...args: never[]) => unknown) {
  return function (this: unknown, value: unknown): boolean {
    if (this !== base) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[brand] === true;
  };
}

const PUBLISHING_ERROR = Symbol.for("ai-sites.PublishingError");

export class PublishingError extends Error {
  readonly [PUBLISHING_ERROR] = true;
  static override [Symbol.hasInstance](value: unknown): boolean {
    return brandedInstanceCheck(PUBLISHING_ERROR, PublishingError).call(this, value);
  }
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  constructor(
    readonly code: PublishingErrorCode,
    message: string,
    options: { readonly metadata?: Readonly<Record<string, unknown>> | undefined } = {},
  ) {
    super(message);
    this.name = "PublishingError";
    this.httpStatus = STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.metadata = options.metadata;
  }
}

/** True for codes this module defines (e.g. a failure code read back from a stored record). */
export const isPublishingErrorCode = (code: unknown): code is PublishingErrorCode =>
  typeof code === "string" && Object.prototype.hasOwnProperty.call(STATUS, code);

/** Bounds diagnostic metadata before it is persisted or returned. */
export function boundedMetadata(metadata: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const text = JSON.stringify(metadata);
  if (text.length <= 4_000) return JSON.parse(text) as Record<string, unknown>;
  return { truncated: true, preview: text.slice(0, 3_500) };
}

/** Explains which account a published site's updates need, without exposing account IDs. */
export const accountMismatchError = (publication: { readonly accountId: string; readonly accountLabel?: string }) =>
  new PublishingError(
    "VERCEL_ACCOUNT_MISMATCH",
    `This website was published with ${publication.accountLabel ? `the Vercel account “${publication.accountLabel}”` : publication.accountId.startsWith("team_") ? "a Vercel team account" : "a different personal Vercel account"}, not the one connected now. Its live site is unchanged. Reconnect that account to update it; AI Sites won't move it to another account.`,
  );
