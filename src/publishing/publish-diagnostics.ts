/**
 * Structured, bounded publishing diagnostics (Stage 5D.3).
 *
 * One JSON line per lifecycle event, prefixed `[sites][publish][diag]`, on
 * the existing console logs. No external service, no polling, no per-file
 * events. Every field is an allow-listed identifier, enum, count or duration:
 * never a token, header, message, prompt, source, URL or owner identity.
 *
 * Volume is bounded by construction: one event per build attempt, publish
 * attempt and reconciled item (itself capped per pass); admission rejections
 * are throttled per reason. Disabled with SITES_PUBLISH_DIAGNOSTICS=false.
 */

/** Per-attempt Vercel request counters (see guardVercelDeployments). */
export interface VercelRequestStats {
  /** Budgeted requests (everything except file uploads). */
  readonly requests: number;
  readonly uploads: number;
  /** Idempotent reads repeated by the guard. */
  readonly retries: number;
  /** Failed responses seen, by kind (including those that were retried). */
  readonly rateLimited: number;
  readonly serverErrors: number;
  readonly timeouts: number;
  readonly networkErrors: number;
  /** Total time spent waiting before read retries (Retry-After or backoff). */
  readonly retryWaitMs: number;
}

export interface ProcessResources {
  readonly rssMb: number;
  readonly heapUsedMb: number;
}

export type AdmissionRejectReason = "CAPACITY" | "DUPLICATE" | "CLOSED";

export type PublishDiagnosticEvent =
  | {
      readonly event: "build_admission_rejected" | "publish_admission_rejected";
      readonly reason: AdmissionRejectReason;
      readonly active: number;
      readonly admitting: number;
      readonly maxConcurrent: number;
      /** Identical rejections dropped since the previous event of this kind. */
      readonly suppressed?: number;
    }
  | {
      readonly event: "build_finished";
      readonly preparationId: string;
      readonly siteId: string;
      readonly attempt: number;
      readonly outcome: "READY" | "FAILED";
      /** Phase in progress when it ended: BUILD, ARTIFACT, LINK or COMPLETE. */
      readonly stage: string;
      /** The builder's own stage (INSTALL, BUILD, CLOUD, ...) when it reported one. */
      readonly buildStage?: string;
      readonly exitCode?: number;
      readonly code?: string;
      readonly retryable?: boolean;
      readonly reused: boolean;
      readonly durationMs: number;
      readonly installMs?: number;
      readonly buildMs?: number;
      readonly active: number;
      readonly maxConcurrent: number;
      readonly resources?: ProcessResources;
    }
  | {
      readonly event: "publish_finished";
      readonly operationId: string;
      readonly preparationId: string;
      readonly siteId: string;
      readonly attempt: number;
      /** PUBLISHED, FAILED, VERIFICATION_INCONCLUSIVE, or STALE_ATTEMPT (fenced out by a newer attempt). */
      readonly status: string;
      /** Operation stage when the attempt ended (PREPARING, UPLOADING, DEPLOYING). */
      readonly stage: string;
      readonly code?: string;
      readonly durationMs: number;
      readonly pendingDeployment?: boolean;
      /** A create was requested and Vercel never confirmed it: how long ago. */
      readonly unconfirmedAgeMs?: number;
      readonly vercel?: VercelRequestStats;
      readonly resources?: ProcessResources;
    }
  | {
      readonly event: "reconcile_item";
      readonly operationId: string;
      readonly attempt: number;
      readonly outcome: "PUBLISHED" | "FAILED" | "CANCELLED" | "UNVERIFIED";
      /** Recorded reconciliation checks including this one (a failed Vercel read records none). */
      readonly checks: number;
      readonly ageMs: number;
      readonly unconfirmedAgeMs?: number;
      readonly code?: string;
      readonly error?: string;
      readonly vercel: VercelRequestStats;
    }
  | {
      readonly event: "reconcile_publication_unchecked";
      readonly siteId: string;
      readonly operationId: string;
      readonly code?: string;
      readonly error?: string;
    };

export type PublishDiagnosticsSink = (event: PublishDiagnosticEvent) => void;

const SAFE_TOKEN = /[^A-Za-z0-9_.:-]/g;
const MAX_TOKEN = 128;
const STRING_FIELDS = new Set(["event", "reason", "preparationId", "operationId", "siteId", "outcome", "stage", "buildStage", "code", "status", "error"]);
const NUMBER_FIELDS = new Set([
  "active", "admitting", "maxConcurrent", "suppressed", "attempt", "exitCode", "durationMs", "installMs", "buildMs",
  "unconfirmedAgeMs", "checks", "ageMs",
]);
const BOOLEAN_FIELDS = new Set(["retryable", "reused", "pendingDeployment"]);
const NESTED_FIELDS = new Set(["vercel", "resources"]);

const safeNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);
const safeToken = (value: unknown) => (typeof value === "string" ? value.replace(SAFE_TOKEN, "").slice(0, MAX_TOKEN) : undefined);

/**
 * Re-builds an event from allow-listed fields only: identifiers are reduced
 * to [A-Za-z0-9_.:-] (max 128 chars), numbers rounded, unknown keys dropped.
 * A caller passing extra data by mistake cannot leak it.
 */
export function sanitizeDiagnostic(event: PublishDiagnosticEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;
    if (STRING_FIELDS.has(key)) {
      const token = safeToken(value);
      if (token) out[key] = token;
    } else if (NUMBER_FIELDS.has(key)) {
      const number = safeNumber(value);
      if (number !== undefined) out[key] = number;
    } else if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value === "boolean") out[key] = value;
    } else if (NESTED_FIELDS.has(key) && value && typeof value === "object") {
      const nested: Record<string, number> = {};
      for (const [k, v] of Object.entries(value as object)) {
        const number = safeNumber(v);
        if (number !== undefined && /^[A-Za-z]{1,32}$/.test(k)) nested[k] = number;
      }
      out[key] = nested;
    }
  }
  return out;
}

const FAILURE_EVENT = (event: PublishDiagnosticEvent) =>
  event.event.endsWith("rejected") ||
  event.event === "reconcile_publication_unchecked" ||
  ("outcome" in event && (event.outcome === "FAILED" || event.outcome === "UNVERIFIED")) ||
  (event.event === "publish_finished" && event.status !== "PUBLISHED");

/** Writes one JSON line per event to the console (warn for failures). */
export const consoleDiagnostics: PublishDiagnosticsSink = (event) => {
  const line = `[sites][publish][diag] ${JSON.stringify(sanitizeDiagnostic(event))}`;
  if (FAILURE_EVENT(event)) console.warn(line);
  else console.info(line);
};

const noop: PublishDiagnosticsSink = () => undefined;

export const resolveDiagnosticsSink = (sink: PublishDiagnosticsSink | false | undefined, env: NodeJS.ProcessEnv = process.env): PublishDiagnosticsSink =>
  sink === false ? noop : (sink ?? (env.SITES_PUBLISH_DIAGNOSTICS === "false" ? noop : consoleDiagnostics));

/** Emits through a sink that can never throw into publishing. */
export const emitDiagnostic = (sink: PublishDiagnosticsSink, event: PublishDiagnosticEvent) => {
  try {
    sink(event);
  } catch {
    // Diagnostics must never change a publishing outcome.
  }
};

/**
 * Per-key throttle for repeatable events (admission rejections): at most one
 * event per key per window; the next one reports how many were dropped. Keys
 * are a fixed set of event/reason pairs, so the map stays tiny.
 */
export class DiagnosticThrottle {
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #state = new Map<string, { last: number; suppressed: number }>();

  constructor(windowMs = 60_000, now: () => number = Date.now) {
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Undefined when the event should be dropped; otherwise the count dropped since the last one. */
  admit(key: string): number | undefined {
    const now = this.#now();
    const state = this.#state.get(key);
    if (state && now - state.last < this.#windowMs) {
      state.suppressed++;
      return undefined;
    }
    const suppressed = state?.suppressed ?? 0;
    this.#state.set(key, { last: now, suppressed: 0 });
    return suppressed;
  }
}

const MB = 1024 * 1024;

/** Cheap process memory snapshot (no polling: read once per finished attempt). */
export const processResources = (): ProcessResources | undefined => {
  try {
    const usage = process.memoryUsage();
    return { rssMb: Math.round(usage.rss / MB), heapUsedMb: Math.round(usage.heapUsed / MB) };
  } catch {
    return undefined;
  }
};

/** `{ resources }` when measurable, for spreading into an event. */
export const resources = (): { resources?: ProcessResources } => {
  const measured = processResources();
  return measured ? { resources: measured } : {};
};

/** A PublishingError-like code, or undefined. */
export const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
};
