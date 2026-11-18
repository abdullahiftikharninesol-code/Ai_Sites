import type { PublishReconcileSummary } from "./vercel-publish-service.js";

/**
 * Invokes the observation/recovery pass (VercelPublishService.reconcilePass)
 * on a fixed cadence inside the server process. Internal only: there is no
 * HTTP entry point, so nothing outside the process can trigger it.
 *
 * - Disabled unless the publisher reports reconciliation enabled
 *   (SITES_PUBLISH_RECONCILE_ENABLED=true and live publishing enabled).
 * - At most one pass at a time in this process; the next pass is scheduled
 *   only after the previous one finished (no overlap, no pile-up).
 * - Each pass gets a time bound; reconcilePass stops starting new items once
 *   it is reached, and each item is bounded by its own Vercel request budget.
 * - Never throws: failures are recorded and the schedule continues.
 *
 * Recovery may persist a verified publication or cancel a stale unfinished deployment;
 * it never creates, promotes or rolls back deployments. Across instances, operation
 * and publication checks use token-fenced leases. Already-issued provider actions
 * cannot be recalled atomically when a lease expires.
 */

export type PublishReconcileTrigger = "schedule" | "manual";

export interface PublishReconcileRun {
  readonly trigger: PublishReconcileTrigger;
  readonly status: "COMPLETED" | "FAILED" | "SKIPPED_OVERLAP" | "DISABLED" | "STOPPED";
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly summary?: PublishReconcileSummary;
  /** The error's name only (never its message, which could carry provider details). */
  readonly error?: string;
}

export interface PublishReconcileSchedulerOptions {
  readonly enabled: boolean;
  readonly pass: (options: { readonly timeoutMs: number }) => Promise<PublishReconcileSummary>;
  readonly intervalMs?: number;
  readonly passTimeoutMs?: number;
  readonly now?: () => Date;
  /** Schedules `run` after `ms`; returns a cancel function. Defaults to an unref'd setTimeout. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly log?: (run: PublishReconcileRun) => void;
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_RECONCILE_PASS_TIMEOUT_MS = 2 * 60_000;

const intEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const value = Number(env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

/** Cadence and per-pass time bound (bounded even when configured). */
export const loadReconcileSchedule = (env: NodeJS.ProcessEnv = process.env) => ({
  intervalMs: intEnv(env, "SITES_PUBLISH_RECONCILE_INTERVAL_MS", DEFAULT_RECONCILE_INTERVAL_MS, 60_000, 60 * 60_000),
  passTimeoutMs: intEnv(env, "SITES_PUBLISH_RECONCILE_PASS_TIMEOUT_MS", DEFAULT_RECONCILE_PASS_TIMEOUT_MS, 10_000, 10 * 60_000),
});

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

const defaultLog = (run: PublishReconcileRun) => {
  if (run.status === "DISABLED") return;
  const s = run.summary;
  const counts = s
    ? ` examined=${s.operationsChecked} recovered=${s.published} failed=${s.failed} cancelled=${s.cancelled} uncertain=${s.unverified} publications=${s.publicationsChecked} changed=${s.publicationsChanged} requests=${s.requests} truncated=${s.truncated}`
    : "";
  const line = `[sites][publish] reconcile trigger=${run.trigger} status=${run.status.toLowerCase()} durationMs=${run.durationMs}${counts}${run.error ? ` error=${run.error}` : ""}`;
  if (run.status === "FAILED") console.warn(line);
  else console.info(line);
};

export class PublishReconcileScheduler {
  readonly #o: PublishReconcileSchedulerOptions;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  readonly #passTimeoutMs: number;
  #current: Promise<PublishReconcileRun> | undefined;
  #cancelTimer: (() => void) | undefined;
  #started = false;
  #stopped = false;
  #lastRun: PublishReconcileRun | undefined;

  constructor(options: PublishReconcileSchedulerOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.#passTimeoutMs = options.passTimeoutMs ?? DEFAULT_RECONCILE_PASS_TIMEOUT_MS;
  }

  get enabled() {
    return this.#o.enabled;
  }
  /** Whether a timer-driven schedule is active. */
  get scheduled() {
    return this.#started && !this.#stopped;
  }
  get running() {
    return !!this.#current;
  }
  get lastRun() {
    return this.#lastRun;
  }

  /** Starts the cadence (first pass after one interval). No-op when disabled, stopped or already started. */
  start() {
    if (!this.#o.enabled || this.#started || this.#stopped) return;
    this.#started = true;
    this.#scheduleNext();
  }

  /** Runs one pass now unless one is already running (internal callers and tests only). */
  async runOnce(trigger: PublishReconcileTrigger = "manual"): Promise<PublishReconcileRun> {
    const startedAt = this.#now();
    if (!this.#o.enabled) return this.#record({ trigger, status: "DISABLED", startedAt, durationMs: 0 });
    if (this.#stopped) return this.#record({ trigger, status: "STOPPED", startedAt, durationMs: 0 });
    if (this.#current) return this.#record({ trigger, status: "SKIPPED_OVERLAP", startedAt, durationMs: 0 });
    const current = this.#pass(trigger, startedAt);
    this.#current = current;
    try {
      return await current;
    } finally {
      this.#current = undefined;
    }
  }

  /** Stops the cadence and waits for a pass in flight (it stops at its next item once the publisher closes). */
  async stop() {
    this.#stopped = true;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    await this.#current?.catch(() => undefined);
  }

  async #pass(trigger: PublishReconcileTrigger, startedAt: Date): Promise<PublishReconcileRun> {
    try {
      const summary = await this.#o.pass({ timeoutMs: this.#passTimeoutMs });
      return this.#record({ trigger, status: "COMPLETED", startedAt, durationMs: this.#elapsed(startedAt), summary });
    } catch (error) {
      return this.#record({ trigger, status: "FAILED", startedAt, durationMs: this.#elapsed(startedAt), error: (error as Error)?.name ?? "Error" });
    }
  }

  #scheduleNext() {
    if (this.#stopped) return;
    this.#cancelTimer = this.#o.schedule
      ? this.#o.schedule(() => this.#tick(), this.#intervalMs)
      : defaultSchedule(() => this.#tick(), this.#intervalMs);
  }

  #tick() {
    this.#cancelTimer = undefined;
    // runOnce never rejects; the next pass is scheduled only after this one finished.
    void this.runOnce("schedule").then(() => this.#scheduleNext());
  }

  #elapsed(startedAt: Date) {
    return Math.max(0, this.#now().getTime() - startedAt.getTime());
  }

  #record(run: PublishReconcileRun): PublishReconcileRun {
    if (run.status !== "SKIPPED_OVERLAP") this.#lastRun = run;
    try {
      (this.#o.log ?? defaultLog)(run);
    } catch {
      // Logging must never break the schedule.
    }
    return run;
  }
}
