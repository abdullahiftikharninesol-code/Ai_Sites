import { ApplicationError } from "../../app/errors/application-error.js";
import { readImageInfo } from "./image-dimensions.js";
import { ASSET_LIMITS } from "./media-store.js";
import type { AssetProviderBudget, DownloadedStockImage } from "./source-adapters.js";

/**
 * Shared, provider-neutral HTTP pieces for stock photo providers: bounded
 * retries, sanitized errors and a host-locked, validated image download.
 */

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_REDIRECTS = 2;

/** Carries a status and a fixed reason only: never a URL, query or key. */
export class StockRequestError extends Error {
  constructor(readonly status: number | undefined, readonly retryable: boolean, message: string) {
    super(message);
    this.name = "StockRequestError";
  }
}

export const isRetryableStatus = (status: number) => status === 429 || status >= 500;

const retryable = (cause: unknown) => cause instanceof StockRequestError
  ? cause.retryable
  : cause instanceof TypeError || (cause as { name?: string } | undefined)?.name === "TimeoutError" || (cause as { name?: string } | undefined)?.name === "AbortError";

export const cleanText = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

export const positiveInt = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** An https URL without credentials or a custom port on an allowed host, else undefined. */
export function safeHttpsUrl(value: unknown, host: (hostname: string) => boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && host(url.hostname) ? url.toString() : undefined;
  } catch { return undefined; }
}

/**
 * Replaces anything that is not already a sanitized StockRequestError or a
 * budget ApplicationError, so request URLs (which may carry an API key) never
 * travel up in an error message.
 */
export function sanitizeStockError(cause: unknown): Error {
  if (cause instanceof StockRequestError || cause instanceof ApplicationError) return cause;
  const name = (cause as { name?: string } | undefined)?.name;
  return new StockRequestError(undefined, retryable(cause), name === "TimeoutError" || name === "AbortError" ? "Request timed out" : "Network error");
}

export interface RetryPolicy {
  readonly retries: number;
  readonly retryDelayMs: number;
}

/** Runs `run` with a fresh timeout per attempt, retrying only timeouts, network errors, 429 and 5xx. */
export async function withRetries<T>(timeoutMs: number, policy: RetryPolicy, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(AbortSignal.timeout(timeoutMs));
    } catch (cause) {
      if (cause instanceof ApplicationError || attempt >= policy.retries || !retryable(cause)) throw cause;
      if (policy.retryDelayMs) await new Promise((resolve) => setTimeout(resolve, policy.retryDelayMs * (attempt + 1)));
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new StockRequestError(response.status, false, "Stock image is too large");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new StockRequestError(response.status, false, "Stock image is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export interface StockDownloadRequest extends RetryPolicy {
  readonly fetch: typeof fetch;
  readonly url: string;
  /** Normalizes a URL (including every redirect hop) or rejects it with undefined. */
  readonly allowUrl: (url: string) => string | undefined;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly budget: AssetProviderBudget;
}

/**
 * Downloads an image server-side. Redirects are followed by hand so every hop
 * stays on the provider's image host; the declared type, length, real format
 * and dimensions are all checked before the bytes are accepted.
 */
export async function downloadStockImage(request: StockDownloadRequest): Promise<DownloadedStockImage> {
  const first = request.allowUrl(request.url);
  if (!first) throw new StockRequestError(undefined, false, "Stock image URL is not on the provider image host");
  const maxBytes = Math.min(request.maxBytes, ASSET_LIMITS.maxBytes);
  return withRetries(request.timeoutMs, request, async (signal) => {
    let url = first;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await request.fetch(url, { headers: { Accept: "image/webp,image/jpeg,image/png" }, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        let next: string | undefined;
        try { next = request.allowUrl(new URL(response.headers.get("location") ?? "", url).toString()); } catch { next = undefined; }
        if (!next) throw new StockRequestError(response.status, false, "Stock image redirected off the provider image host");
        url = next;
        continue;
      }
      if (!response.ok) throw new StockRequestError(response.status, isRetryableStatus(response.status), "Stock image download failed");
      const declaredType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!IMAGE_TYPES.has(declaredType)) throw new StockRequestError(response.status, false, "Stock image has an unsupported type");
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > maxBytes) throw new StockRequestError(response.status, false, "Stock image is too large");
      request.budget.reserve("DOWNLOAD", Number.isFinite(declaredLength) ? declaredLength : 0);
      const bytes = await readCapped(response, maxBytes);
      const info = readImageInfo(bytes);
      if (!info || info.mimeType !== declaredType) throw new StockRequestError(response.status, false, "Stock image content does not match its type");
      if (info.width > ASSET_LIMITS.maxWidth || info.height > ASSET_LIMITS.maxHeight) throw new StockRequestError(response.status, false, "Stock image dimensions exceed the limit");
      return { bytes, contentType: info.mimeType, width: info.width, height: info.height };
    }
    throw new StockRequestError(undefined, false, "Stock image redirected too many times");
  });
}

/** A one-line warning with the stage, HTTP status and fixed reason only. */
export function stockWarning(provider: string, stage: "search" | "download", cause: unknown): string | undefined {
  if (cause instanceof ApplicationError) return undefined; // budget limits are expected, not provider faults
  const status = cause instanceof StockRequestError && cause.status !== undefined ? ` status=${cause.status}` : "";
  const reason = cause instanceof StockRequestError ? cause.message : (cause as { name?: string } | undefined)?.name ?? "error";
  return `[sites] ${provider} ${stage} unavailable:${status} ${reason}`;
}
