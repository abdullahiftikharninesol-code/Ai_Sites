import type { Connection } from "mongoose";
import { createVercelDeploymentsClient } from "../integrations/vercel/vercel-deployments-client.js";
import { VercelPublishService, isLivePublishingEnabled, isPublishReconcileEnabled, type VercelPublishServiceOptions } from "../publishing/vercel-publish-service.js";
import { PublishReconcileScheduler, loadReconcileSchedule, type PublishReconcileSchedulerOptions } from "../publishing/publish-reconcile-scheduler.js";
import { loadVercelIntegrationConfig } from "../integrations/vercel/vercel-integration-config.js";
import { MongoVercelPublishRepository } from "../publishing/vercel-publish-repository.js";
import { PublishingError, isPublishingErrorCode } from "../publishing/publishing-errors.js";
import { validSiteId } from "./production-website-reads.js";
import type { ProductionRoute } from "./production-http-routes.js";
import type { productionPublishPreparation } from "./production-publish-preparation.js";
import type { InitializationState } from "./production-readiness.js";

export interface ProductionPublishingDependencies {
  readonly repository?: VercelPublishServiceOptions["repository"] & { ready?(): Promise<void> };
  readonly deployments?: VercelPublishServiceOptions["deployments"];
  readonly verify?: VercelPublishServiceOptions["verify"];
  readonly limits?: VercelPublishServiceOptions["limits"];
  readonly sleep?: VercelPublishServiceOptions["sleep"];
  readonly now?: VercelPublishServiceOptions["now"];
  readonly reconcileLimits?: VercelPublishServiceOptions["reconcileLimits"];
  readonly scheduler?: Pick<PublishReconcileSchedulerOptions, "schedule" | "log">;
}

/** Existing publisher/scheduler only; no development product or cloud integration. */
export function productionVercelPublishing(connection: Connection, preparation: ReturnType<typeof productionPublishPreparation>, env: NodeJS.ProcessEnv, dependencies: ProductionPublishingDependencies = {}, observe?: (state: InitializationState) => void, observeReconciliation?: (state: InitializationState) => void) {
  let stopping = false, service: VercelPublishService | undefined, initializing: Promise<VercelPublishService> | undefined;
  const pending = new Set<Promise<void>>();
  const shutdown = new AbortController();
  let scheduler: PublishReconcileScheduler | undefined, initialized: Promise<void> | undefined;
  const getService = () => initializing ??= (async () => {
    observe?.("initializing");
    const ports = await preparation.publishing();
    const repository = dependencies.repository ?? new MongoVercelPublishRepository(connection);
    // Includes the unique active-operation and publication indexes before any admission.
    await repository.ready?.();
    if (stopping) throw new PublishingError("PUBLISH_INTERRUPTED", "Publishing is shutting down.");
    const concurrent = Number(env.SITES_PUBLISH_MAX_CONCURRENT_DEPLOYS ?? 1);
    service = new VercelPublishService({ ...ports, repository, deployments: dependencies.deployments ?? createVercelDeploymentsClient(undefined, undefined, shutdown.signal),
      liveEnabled: isLivePublishingEnabled(env), reconcileEnabled: isPublishReconcileEnabled(env), shutdownSignal: shutdown.signal,
      ...(dependencies.reconcileLimits ? { reconcileLimits: dependencies.reconcileLimits } : {}),
      limits: { maxConcurrentPublishes: Number.isInteger(concurrent) ? Math.min(4, Math.max(1, concurrent)) : 1, ...dependencies.limits },
      ...(dependencies.verify ? { verify: dependencies.verify } : {}), ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}), ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    return service;
  })().then(value => { observe?.("ready"); return value; }, (error: unknown) => { observe?.("failed"); throw error; });
  const route: ProductionRoute = { access: "authenticated", method: "POST", path: "/api/dev/sites/:siteId/versions/:versionId/publish/vercel", body: "json", handle: context => {
    const task = (async () => {
      if (stopping) throw Object.assign(new Error("Service unavailable"), { code: "SERVICE_UNAVAILABLE" });
      const { siteId, versionId } = context.params;
      if (!siteId || !validSiteId(siteId) || !versionId || !new RegExp(`^${siteId}:v[1-9][0-9]*$`).test(versionId)) throw Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
      if (context.body && (context.body instanceof Uint8Array || Object.keys(context.body).length)) throw Object.assign(new Error("No publishing body fields are supported"), { code: "INVALID_REQUEST" });
      try {
        await preparation.assertAllowed(context.ownerId, siteId, versionId);
        if (!isLivePublishingEnabled(env)) throw new PublishingError("PUBLISH_LIVE_DISABLED", "Live publishing is disabled.");
        const view = await (await getService()).publish(context.ownerId, siteId, versionId);
        const failure = view.operation?.failure;
        const publish = failure ? { ...view, operation: { ...view.operation, failure: {
          code: isPublishingErrorCode(failure.code) ? failure.code : "PUBLISH_VERIFICATION_FAILED", message: "Publishing could not be confirmed. Check the connection and try again.", retryable: failure.retryable === true,
        } } } : view;
        context.response.writeHead(202, { "content-type": "application/json; charset=utf-8" }); context.response.end(JSON.stringify({ publish }));
      } catch (error) {
        if (!(error instanceof PublishingError)) throw error;
        context.response.writeHead(error.httpStatus, { "content-type": "application/json; charset=utf-8" });
        context.response.end(JSON.stringify({ error: { code: error.code, message: "Publishing was refused or could not complete. Check the saved version, Vercel connection and publishing configuration.", retryable: error.retryable } }));
      }
    })();
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => undefined); return task;
  } };
  return { route, initialize: () => initialized ??= (async () => {
    if (!isLivePublishingEnabled(env) || !isPublishReconcileEnabled(env)) return;
    observeReconciliation?.("initializing");
    if (!loadVercelIntegrationConfig(env).configured) throw new PublishingError("VERCEL_INTEGRATION_NOT_CONFIGURED", "Reconciliation requires complete Vercel integration configuration.");
    const publisher = await getService();
    if (stopping) throw new PublishingError("PUBLISH_INTERRUPTED", "Publishing is shutting down.");
    scheduler = new PublishReconcileScheduler({ enabled: publisher.reconcileEnabled, pass: options => publisher.reconcilePass(options), ...loadReconcileSchedule(env), ...dependencies.scheduler });
    scheduler.start();
  })().then(() => { if (scheduler) observeReconciliation?.("ready"); }, (error: unknown) => { observeReconciliation?.("failed"); throw error; }), close: async () => {
    stopping = true;
    const scheduled = scheduler?.stop(); // Cancels the cadence synchronously, before closing/draining the publisher.
    shutdown.abort();
    const draining = service?.close();
    await Promise.allSettled([...pending]); await initialized?.catch(() => undefined); await initializing?.catch(() => undefined); await draining; await scheduled; await service?.close();
  } };
}
