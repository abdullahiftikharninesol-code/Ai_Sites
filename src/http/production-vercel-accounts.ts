import type { Connection } from "mongoose";
import { MongoVercelIntegrationRepository, type VercelIntegrationRepository } from "../integrations/vercel/vercel-connection-repository.js";
import { VercelConnectionService, VercelIntegrationError, VERCEL_DISCONNECT_CONFIRMATION } from "../integrations/vercel/vercel-connection-service.js";
import { loadVercelIntegrationConfig, VERCEL_CALLBACK_PATH } from "../integrations/vercel/vercel-integration-config.js";
import { handleVercelCallback } from "../integrations/vercel/vercel-integration-routes.js";
import { createVercelOAuthClient, type VercelOAuthClient } from "../integrations/vercel/vercel-oauth-client.js";
import { createVercelProjectsClient } from "../integrations/vercel/vercel-projects-client.js";
import { productionProviderFetch } from "./production-provider-fetch.js";
import { createVercelAccountVerifier, type VercelAccountVerifier } from "../integrations/vercel/vercel-account-verifier.js";
import { countVercelPublishingActivity } from "../integrations/vercel/vercel-publishing-activity.js";
import { readProductionBody, type ProductionRoute, type ProductionRouteContext } from "./production-http-routes.js";
import type { InitializationState } from "./production-readiness.js";

export interface ProductionVercelDependencies {
  readonly repository?: VercelIntegrationRepository & { ready?(): Promise<void> };
  readonly oauth?: VercelOAuthClient;
  readonly verifier?: VercelAccountVerifier;
  readonly now?: () => Date;
}
export function productionVercelAccounts(connection: Connection, env: NodeJS.ProcessEnv, dependencies: ProductionVercelDependencies = {}, shutdownSignal?: AbortSignal, observe?: (state: InitializationState) => void) {
  const providerFetch = shutdownSignal ? productionProviderFetch(shutdownSignal) : globalThis.fetch;
  let repository = dependencies.repository;
  const repo = () => repository ??= new MongoVercelIntegrationRepository(connection);
  let initialized = false;
  const ready = async () => {
    if (!initialized) observe?.("initializing");
    try { await repo().ready?.(); initialized = true; observe?.("ready"); }
    catch (error) { observe?.("failed"); throw error; }
  };
  // Lazy delegation keeps disabled integrations from initializing models during ordinary startup.
  const service = new VercelConnectionService({ repository: {
    createState: record => repo().createState(record), consumeState: (hash, now) => repo().consumeState(hash, now),
    expireOpenStates: (owner, now) => repo().expireOpenStates(owner, now),
    beginAuthorization: (owner, fence, now) => repo().beginAuthorization(owner, fence, now),
    isCurrentAuthorization: (owner, fence) => repo().isCurrentAuthorization(owner, fence),
    invalidatePendingAuthorization: owner => repo().invalidatePendingAuthorization(owner),
    findActiveConnection: owner => repo().findActiveConnection(owner), findConnectionByConfiguration: id => repo().findConnectionByConfiguration(id),
    saveConnection: (record, fence) => repo().saveConnection(record, fence),
    markDisconnected: (owner, id, now, token) => repo().markDisconnected(owner, id, now, token),
    saveVerification: (owner, id, verification, token) => repo().saveVerification(owner, id, verification, token),
  }, config: () => loadVercelIntegrationConfig(env),
    oauth: dependencies.oauth ?? createVercelOAuthClient(providerFetch),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    verifier: dependencies.verifier ?? createVercelAccountVerifier(createVercelProjectsClient(providerFetch)),
    siteOwnership: async (ownerId, siteId) => !!(await connection.db?.collection<{ _id: string; ownerId: string }>("sites_projects").findOne({ _id: siteId, ownerId }, { projection: { _id: 1 }, maxTimeMS: 5_000 })),
    activePublishes: ownerId => countVercelPublishingActivity(connection, ownerId),
  });
  const pending = new Set<Promise<void>>();
  let stopping = false;
  const tracked = (handle: () => Promise<void>): Promise<void> => {
    if (stopping) return Promise.reject(Object.assign(new Error("Service unavailable"), { code: "SERVICE_UNAVAILABLE" }));
    const task = handle(); pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => undefined);
    return task;
  };
  const json = (context: ProductionRouteContext, status: number, value: unknown) => {
    context.response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); context.response.end(JSON.stringify(value));
  };
  const authenticated = (method: "GET" | "POST" | "DELETE", path: string, handle: (context: ProductionRouteContext) => Promise<void>): ProductionRoute => ({
    access: "authenticated", method, path, handle: context => tracked(async () => {
      try { await handle(context); } catch (error) {
        if (!(error instanceof VercelIntegrationError)) throw error;
        const status = error.code === "VERCEL_SITE_NOT_FOUND" ? 404 : error.code === "VERCEL_DISCONNECT_BLOCKED" ? 409
          : ["VERCEL_INTEGRATION_NOT_CONFIGURED", "VERCEL_DISCONNECT_UNAVAILABLE"].includes(error.code) ? 503 : 500;
        json(context, status, { error: { code: error.code === "VERCEL_SITE_NOT_FOUND" ? "SITE_NOT_FOUND" : error.code, message: error.message } });
      }
    }),
  });
  const smallBody = async (context: ProductionRouteContext, disconnect = false) => {
    try { return await readProductionBody(context.request, "json", 4_096) as Readonly<Record<string, unknown>>; }
    catch { json(context, 400, { error: disconnect ? { code: "CONFIRMATION_REQUIRED", message: "Confirm disconnecting Vercel." }
      : { code: "INVALID_REQUEST", message: "Request body must be a small JSON object" } }); return undefined; }
  };
  const routes: ProductionRoute[] = [
    authenticated("POST", "/api/integrations/vercel/connect", async context => {
      const body = await smallBody(context); if (!body) return;
      if (!service.configuration().configured) throw new VercelIntegrationError("VERCEL_INTEGRATION_NOT_CONFIGURED");
      await ready(); json(context, 201, await service.start(context.ownerId, "siteId" in body ? { siteId: body.siteId } : {}));
    }),
    { access: "oauth-callback", method: "GET", path: VERCEL_CALLBACK_PATH, handle: context => tracked(async () => {
      if (service.configuration().configured) await ready();
      await handleVercelCallback(context.url, context.response, service);
    }) },
    authenticated("GET", "/api/integrations/vercel/status", async context => {
      json(context, 200, await service.status(context.ownerId, { refresh: context.url.searchParams.get("refresh") === "1" }));
    }),
    authenticated("DELETE", "/api/integrations/vercel/connection", async context => {
      const body = await smallBody(context, true); if (!body) return;
      if (body.confirm !== VERCEL_DISCONNECT_CONFIRMATION) { json(context, 400, { error: { code: "CONFIRMATION_REQUIRED", message: "Confirm disconnecting Vercel." } }); return; }
      await ready(); json(context, 200, await service.disconnect(context.ownerId, { allowActivePublishing: body.allowActivePublishing === true }));
    }),
  ];
  return { routes, credentials: (ownerId: string) => service.credentials(ownerId), ready,
    initialize: async () => { if (service.configuration().configured) await ready(); }, close: async () => {
    stopping = true; await Promise.allSettled([...pending]);
  } };
}
