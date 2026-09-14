import { ApplicationError } from "../../app/errors/application-error.js";
import { defaultCircuitBreaker, CircuitBreaker } from "../resilience/circuit-breaker.js";
import { abortable } from "./abort.js";
import type { RateLimitMetadata, TransportHook } from "../agent-types.js";
export { defaultCircuitBreaker, CircuitBreaker };

function record(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {};
}

function quotaInfo(cause: unknown) {
  const value = record(cause);
  let payload = value;
  try {
    if (typeof value.message === "string") payload = record(JSON.parse(value.message));
  } catch {
    /* Not a JSON SDK error. */
  }
  payload = record(payload.error ?? payload);
  const details = Array.isArray(payload.details) ? payload.details.map(record) : [];
  const violations = details.flatMap((item) =>
    Array.isArray(item.violations) ? item.violations.map(record) : [],
  );
  const ids = [
    ...new Set(
      violations
        .map((item) => (typeof item.quotaId === "string" ? item.quotaId : ""))
        .filter(Boolean),
    ),
  ];
  const zero = violations.some((item) => item.quotaValue === 0 || item.quotaValue === "0");
  // Google can return several simultaneous violations (e.g. daily AND per-minute
  // quotas both exhausted in one 429). Picking a single headline category is still
  // useful for the primary message, but every violated quota id is kept in `ids` so
  // callers never lose the rest of the picture.
  const category =
    value.status === 402
      ? "BILLING"
      : zero
        ? "NO_QUOTA"
        : ids.some((id) => /PerDay/.test(id))
          ? "DAILY_QUOTA"
          : violations.length
            ? "RATE_LIMIT"
            : value.status === 403
              ? "MODEL_ACCESS_DENIED"
              : undefined;
  const retry = details.find((item) => typeof item.retryDelay === "string")?.retryDelay;
  const retryAfterSeconds =
    typeof retry === "string" && /^\d+(\.\d+)?s$/.test(retry)
      ? Number(retry.slice(0, -1))
      : undefined;
  return { category, retryAfterSeconds, violatedQuotaIds: ids };
}

export function isTransientProviderError(error: unknown): boolean {
  const value = record(error);
  const quota = quotaInfo(error);
  if (quota.category && quota.category !== "RATE_LIMIT") return false;
  const meta = record(value.metadata);
  const status =
    typeof value.status === "number"
      ? value.status
      : typeof meta.status === "number"
        ? (meta.status as number)
        : undefined;
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const name = typeof value.name === "string" ? value.name : "";
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  if ([400, 401, 403, 404, 422].includes(status ?? 0)) return false;
  // Hard quota/billing failures do not recover within a request. Retrying these
  // immediately only consumes more request allowance and obscures the real error.
  if (
    /quota|billing|credit|insufficient|resource_exhausted/.test(code) ||
    /quota exceeded|quota exhausted|resource exhausted|insufficient (quota|credit)|billing/.test(
      message,
    )
  )
    return false;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    /connection|timeout|abort/i.test(name)
  );
}

export function extractRateLimitMetadata(causeOrHeaders: unknown): RateLimitMetadata | undefined {
  const val = record(causeOrHeaders);
  const headers = record(val.headers ?? val);
  const status = typeof val.status === "number" ? val.status : undefined;
  const providerCode = typeof val.code === "string" ? val.code : undefined;

  const quota = quotaInfo(causeOrHeaders);
  let retryAfterMs = quota.retryAfterSeconds !== undefined ? quota.retryAfterSeconds * 1000 : undefined;
  if (retryAfterMs === undefined) {
    const headerRetry = headers["retry-after"] ?? headers["Retry-After"];
    const sec =
      typeof headerRetry === "string"
        ? Number(headerRetry)
        : typeof headerRetry === "number"
          ? headerRetry
          : undefined;
    if (typeof sec === "number" && Number.isFinite(sec)) {
      retryAfterMs = sec * 1000;
    }
  }

  const reqLimit = parseHeaderInt(headers["x-ratelimit-limit-requests"] ?? headers["ratelimit-limit-requests"]);
  const reqRemaining = parseHeaderInt(
    headers["x-ratelimit-remaining-requests"] ?? headers["ratelimit-remaining-requests"],
  );
  const tokenLimit = parseHeaderInt(headers["x-ratelimit-limit-tokens"] ?? headers["ratelimit-limit-tokens"]);
  const tokenRemaining = parseHeaderInt(
    headers["x-ratelimit-remaining-tokens"] ?? headers["ratelimit-remaining-tokens"],
  );
  const reqResetAt =
    typeof headers["x-ratelimit-reset-requests"] === "string"
      ? headers["x-ratelimit-reset-requests"]
      : undefined;
  const tokenResetAt =
    typeof headers["x-ratelimit-reset-tokens"] === "string"
      ? headers["x-ratelimit-reset-tokens"]
      : undefined;

  const result: RateLimitMetadata = {
    ...(status !== undefined ? { status } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(reqLimit !== undefined ? { requestLimit: reqLimit } : {}),
    ...(reqRemaining !== undefined ? { requestsRemaining: reqRemaining } : {}),
    ...(tokenLimit !== undefined ? { tokenLimit } : {}),
    ...(tokenRemaining !== undefined ? { tokensRemaining: tokenRemaining } : {}),
    ...(reqResetAt ? { requestResetAt: reqResetAt } : {}),
    ...(tokenResetAt ? { tokenResetAt: tokenResetAt } : {}),
  };

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseHeaderInt(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const parsed = parseInt(val, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function extractProviderErrorDetails(cause: unknown): {
  readonly message?: string;
  readonly reason?: string;
  readonly rpcStatus?: string;
} {
  const value = record(cause);
  let payload = value;
  let parsedProviderPayload = false;
  try {
    if (typeof value.message === "string") {
      const parsed = JSON.parse(value.message);
      if (parsed && typeof parsed === "object") {
        payload = record(parsed);
        parsedProviderPayload = true;
      }
    }
  } catch {
    /* Not a JSON SDK error */
  }
  payload = record(payload.error ?? payload);
  const details = Array.isArray(payload.details) ? payload.details.map(record) : [];
  const errorInfo = details.find((d) => typeof d.reason === "string");
  const rawMsg = parsedProviderPayload && typeof payload.message === "string" ? payload.message : undefined;
  const sanitizedMsg = rawMsg
    ?.replace(/key=[^&\s]+/gi, "key=[REDACTED]")
    ?.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  const reason = typeof errorInfo?.reason === "string" ? errorInfo.reason : undefined;
  const rpcStatus = typeof payload.status === "string" ? payload.status : undefined;
  return {
    ...(sanitizedMsg ? { message: sanitizedMsg } : {}),
    ...(reason ? { reason } : {}),
    ...(rpcStatus ? { rpcStatus } : {}),
  };
}

export function normalizeProviderError(provider: string, cause: unknown): ApplicationError {
  const value = record(cause);
  const quota = quotaInfo(cause);
  const rateLimit = extractRateLimitMetadata(cause);
  const providerDetails = extractProviderErrorDetails(cause);
  let explanation =
    quota.category === "BILLING"
      ? ": check available credits and billing"
      : quota.category === "NO_QUOTA"
        ? ": this model has no available quota; check model access and billing"
        : quota.category === "DAILY_QUOTA"
          ? ": daily quota unavailable or exhausted; check this model's quota in your provider project"
          : quota.category === "RATE_LIMIT"
            ? ": request or token rate limit reached"
            : quota.category === "MODEL_ACCESS_DENIED"
              ? ": this model is not available for your account, region, or API key; verify model access and billing for this project"
            : "";

  // Keep the stable provider-prefixed error text used by callers, while adding
  // the provider's sanitized diagnostic when one is available. This makes
  // authentication and structured provider failures actionable without ever
  // exposing the original error object or credentials.
  const detailSuffix = [providerDetails.message, providerDetails.reason]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  if (detailSuffix) explanation += `: ${detailSuffix}`;

  return new ApplicationError("AGENT_FAILED", `${provider} agent request failed${explanation}`, {
    retryable: isTransientProviderError(cause),
    cause,
    metadata: {
      provider,
      ...(quota.category ? { quotaCategory: quota.category } : {}),
      ...(quota.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: quota.retryAfterSeconds }
        : {}),
      ...(quota.violatedQuotaIds.length ? { violatedQuotaIds: quota.violatedQuotaIds } : {}),
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      ...(typeof value.code === "string" ? { providerCode: value.code } : {}),
      ...(typeof value.request_id === "string" ? { requestId: value.request_id } : {}),
      ...(providerDetails.reason ? { errorReason: providerDetails.reason } : {}),
      ...(providerDetails.rpcStatus ? { rpcStatus: providerDetails.rpcStatus } : {}),
      ...(providerDetails.message ? { providerMessage: providerDetails.message } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    },
  });
}

export async function withProviderRetries<T>(options: {
  provider: string;
  maxRetries: number;
  signal?: AbortSignal | undefined;
  sleep: (milliseconds: number) => Promise<void>;
  operation: () => Promise<T>;
  transportHook?: TransportHook | undefined;
}): Promise<{ value: T; retryCount: number }> {
  defaultCircuitBreaker.assertAvailable(options.provider);
  const allowedRetries = Math.min(Math.max(0, options.maxRetries), 1);
  for (let attempt = 0; attempt <= allowedRetries; attempt += 1) {
    if (options.signal?.aborted)
      throw new ApplicationError("JOB_CANCELLED", `${options.provider} request was cancelled`);

    // Check circuit breaker before each physical attempt so breaker rejections consume zero physical requests
    defaultCircuitBreaker.assertAvailable(options.provider);

    // Atomic physical reservation immediately before the actual SDK attempt
    await options.transportHook?.beforePhysicalAttempt(attempt);

    try {
      const value = await options.operation();
      await options.transportHook?.afterPhysicalAttempt?.(attempt, undefined, value);
      return { value, retryCount: attempt };
    } catch (cause) {
      await options.transportHook?.afterPhysicalAttempt?.(attempt, cause, undefined);
      if (options.signal?.aborted)
        throw new ApplicationError("JOB_CANCELLED", `${options.provider} request was cancelled`);
      const quota = quotaInfo(cause);
      if (quota.category && quota.category !== "RATE_LIMIT") {
        defaultCircuitBreaker.trip(options.provider, quota.category);
      }
      if (attempt < allowedRetries && isTransientProviderError(cause)) {
        await abortable(options.sleep(retryDelayMs(cause, attempt)), options.signal);
        continue;
      }
      throw normalizeProviderError(options.provider, cause);
    }
  }
  throw new ApplicationError("AGENT_FAILED", `${options.provider} agent request failed`);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const quota = quotaInfo(error);
  if (quota.retryAfterSeconds !== undefined)
    return Math.min(300_000, quota.retryAfterSeconds * 1000);
  const value = record(error);
  const headers = record(value.headers);
  const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  const seconds = typeof retryAfter === "string" ? Number(retryAfter) : retryAfter;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0)
    return Math.min(30_000, Math.max(1_000, seconds * 1_000));
  // Rate limits generally need a longer cool-down than connection/5xx errors.
  return value.status === 429 ? 1_000 * 2 ** attempt : 250 * 2 ** attempt;
}
