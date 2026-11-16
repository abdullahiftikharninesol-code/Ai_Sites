import { VercelApiError, type VercelAuth } from "../integrations/vercel/vercel-projects-client.js";
import type { VercelDeploymentsClient } from "../integrations/vercel/vercel-deployments-client.js";
import { PublishingError } from "./publishing-errors.js";

export interface VercelApiGuardOptions {
  /** Hard cap on Vercel requests for one attempt (every retry counts). */
  readonly budget: number;
  /** Extra attempts for idempotent reads after 429 / 5xx / network failures. */
  readonly readRetries: number;
  /** Longest wait honored from Retry-After (longer waits fail instead). */
  readonly maxRetryAfterMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs before requests (also cancel when checkCancellation is set); throws when the connection cannot be used. */
  readonly beforeRequest?: (auth: VercelAuth) => Promise<void>;
  /** Background reconciliation must also authorize cancellation against its pinned connection. */
  readonly checkCancellation?: boolean;
}

/** The request budget of one attempt ran out: stop and leave the outcome to reconciliation. */
export class VercelRequestBudgetError extends PublishingError {
  constructor(budget: number) {
    super("PUBLISH_REQUEST_BUDGET_EXCEEDED", `Publishing stopped after ${budget} Vercel requests without a final answer. Publish again to check; nothing will be deployed twice.`);
  }
}

const transient = (error: unknown) =>
  error instanceof VercelApiError && (error.status === undefined || error.status === 429 || error.status >= 500);

/**
 * A per-attempt view of the deployments client:
 *   - every request except file uploads (bounded by the artifact) counts
 *     against a fixed budget (no unbounded polling);
 *   - only idempotent reads are retried, a bounded number of times, waiting
 *     for Retry-After (capped) or a short backoff;
 *   - writes (upload, create, promote, rollback, cancel) are never retried
 *     here: their callers reconcile instead of repeating them blindly.
 */
export function guardVercelDeployments(client: VercelDeploymentsClient, options: VercelApiGuardOptions): VercelDeploymentsClient & { readonly used: () => number } {
  let used = 0;
  const spend = () => {
    if (used >= options.budget) throw new VercelRequestBudgetError(options.budget);
    used++;
  };
  const write = <A extends [VercelAuth, ...unknown[]], R>(call: (...args: A) => Promise<R>, checked = true) => async (...args: A) => {
    if (checked) await options.beforeRequest?.(args[0]);
    spend();
    return call(...args);
  };
  const read = <A extends [VercelAuth, ...unknown[]], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      await options.beforeRequest?.(args[0]);
      spend();
      try {
        return await call(...args);
      } catch (error) {
        if (!transient(error) || attempt >= options.readRetries) throw error;
        const hinted = (error as VercelApiError).retryAfterMs;
        if (hinted !== undefined && hinted > options.maxRetryAfterMs) throw error;
        await options.sleep(hinted ?? 1_000 * 2 ** attempt);
      }
    }
  };
  return {
    // Uploads are bounded by the artifact's file count and per-file retries, not by this budget.
    uploadFile: async (...args: Parameters<VercelDeploymentsClient["uploadFile"]>) => (await options.beforeRequest?.(args[0]), client.uploadFile(...args)),
    createDeployment: write((...args: Parameters<VercelDeploymentsClient["createDeployment"]>) => client.createDeployment(...args)),
    promoteDeployment: write((...args: Parameters<VercelDeploymentsClient["promoteDeployment"]>) => client.promoteDeployment(...args)),
    rollbackDeployment: write((...args: Parameters<VercelDeploymentsClient["rollbackDeployment"]>) => client.rollbackDeployment(...args)),
    // Foreground safety cancellation keeps its existing policy; reconciliation explicitly rechecks its connection.
    cancelDeployment: write((...args: Parameters<VercelDeploymentsClient["cancelDeployment"]>) => client.cancelDeployment(...args), options.checkCancellation ?? false),
    getDeployment: read((...args: Parameters<VercelDeploymentsClient["getDeployment"]>) => client.getDeployment(...args)),
    listProjectDeployments: read((...args: Parameters<VercelDeploymentsClient["listProjectDeployments"]>) => client.listProjectDeployments(...args)),
    getProductionDeploymentId: read((...args: Parameters<VercelDeploymentsClient["getProductionDeploymentId"]>) => client.getProductionDeploymentId(...args)),
    getAliasDeploymentId: read((...args: Parameters<VercelDeploymentsClient["getAliasDeploymentId"]>) => client.getAliasDeploymentId(...args)),
    used: () => used,
  };
}
