import { productionDiagnostics, productionStartupFailure, type ProductionDiagnosticSink } from "./production-readiness.js";

/**
 * Process lifecycle around the production composition (createSitesVersionApi):
 *   - SIGINT/SIGTERM handlers are installed before any asynchronous startup work, so a
 *     signal during startup stops it through the normal drain instead of killing the
 *     process mid-initialization;
 *   - handlers stay installed (never `once`), so a repeated or concurrent signal cannot
 *     fall back to Node's default handler and kill the process while it drains;
 *   - shutdown is requested once; later signals share the same close;
 *   - a startup that ends because shutdown was requested is reported as interrupted,
 *     not as a startup failure.
 * Ordering, the drain deadline and the Mongo-retaining failure path are the composition's
 * (stop admission, stop scheduling, drain, then disconnect); this module only invokes it.
 * Diagnostics are the allowlisted `sites.production` events; errors are never logged.
 */
export const PRODUCTION_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type ProductionSignal = typeof PRODUCTION_SIGNALS[number];

export interface ProductionProcessApi {
  start(): Promise<string>;
  close(): Promise<void>;
}

export interface ProductionProcessHost {
  on(signal: ProductionSignal, listener: () => void): unknown;
  setExitCode(code: number): void;
}

const nodeHost: ProductionProcessHost = {
  on: (signal, listener) => process.on(signal, listener),
  setExitCode: (code) => { process.exitCode = code; },
};

export interface ProductionProcess {
  /** Settles when startup succeeded, failed or was interrupted (never rejects). */
  readonly started: Promise<"ready" | "failed" | "interrupted">;
  /** Requests shutdown (idempotent); settles when it completed or failed (never rejects). */
  shutdown(): Promise<void>;
}

export function runProductionProcess(api: ProductionProcessApi, host: ProductionProcessHost = nodeHost, log?: ProductionDiagnosticSink): ProductionProcess {
  let closing: Promise<void> | undefined;
  // The composition already reports DRAIN_FAILED / DATABASE_DISCONNECT_FAILED; a failed close only sets the exit code.
  const shutdown = () => closing ??= Promise.resolve().then(() => api.close()).catch(() => { host.setExitCode(1); });
  for (const signal of PRODUCTION_SIGNALS) host.on(signal, () => { void shutdown(); });
  const started = Promise.resolve().then(() => api.start()).then(() => "ready" as const, (error: unknown) => {
    if (closing) {
      // Shutdown was requested during startup: the composition already stopped and drained it.
      productionDiagnostics(log).report("startup", "stopped", "STARTUP_INTERRUPTED");
      return "interrupted" as const;
    }
    productionStartupFailure(error, log);
    host.setExitCode(1);
    return "failed" as const;
  });
  return { started, shutdown };
}
