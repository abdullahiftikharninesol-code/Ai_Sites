import { MongoIdentityRepository, type IdentityRepository } from "../auth/identity-repository.js";
import { loadPersistenceConfig, requireMongoDatabaseUri } from "../persistence/persistence-config.js";
import { MongoConnectionManager } from "../persistence/mongodb/mongo-connection.js";
import { SitesVersionHttpServer } from "./sites-version-http-server.js";
import { mongoWebsiteReads, productionWebsiteRoutes, type WebsiteReadRepository } from "./production-website-reads.js";
import { mongoWebsiteRenames, productionWebsiteRenameRoute, type WebsiteRenameRepository } from "./production-website-rename.js";
import { mongoSavedSourceRepository, productionSavedSourceRoute, type SavedSourceRepository } from "./production-saved-source.js";
import { savedSourceArtifactReader, type SavedSourceArtifactReader } from "./saved-source-artifact-reader.js";
import { loadProductionConfig, requireProductionDataRoot } from "./production-config.js";
import { productionVercelAccounts, type ProductionVercelDependencies } from "./production-vercel-accounts.js";
import { mongoPublishingStatusReads, productionPublishingStatusRoutes, type PublishingStatusReads } from "./production-publishing-status.js";
import { productionPublishPreparation, type ProductionPreparationDependencies } from "./production-publish-preparation.js";
import { productionVercelPublishing, type ProductionPublishingDependencies } from "./production-vercel-publishing.js";
import { isLivePublishingEnabled } from "../publishing/vercel-publish-service.js";
import { loadVercelIntegrationConfig } from "../integrations/vercel/vercel-integration-config.js";
import { productionDiagnostics, productionReadiness, type ProductionReadinessDependencies } from "./production-readiness.js";

interface ProductionHttpDependencies {
  readonly database: Pick<MongoConnectionManager, "connection" | "connect" | "disconnect" | "status">;
  readonly identities: IdentityRepository;
  readonly websites?: WebsiteReadRepository;
  readonly websiteRenames?: WebsiteRenameRepository;
  readonly savedSources?: SavedSourceRepository;
  readonly sourceArtifacts?: SavedSourceArtifactReader;
  readonly vercel?: ProductionVercelDependencies;
  readonly publishingStatus?: PublishingStatusReads;
  readonly preparation?: ProductionPreparationDependencies;
  readonly publishing?: ProductionPublishingDependencies;
  readonly readiness?: ProductionReadinessDependencies;
  /** Testable bounded drain; production defaults to 30 seconds. No forced DB disconnect on timeout. */
  readonly shutdownTimeoutMs?: number;
}

/** Explicit production routes; the existing scheduler initializes only under its explicit flags. */
export function createSitesVersionApi(env: NodeJS.ProcessEnv = process.env, dependencies?: ProductionHttpDependencies) {
  const diagnostics = productionDiagnostics(dependencies?.readiness?.log);
  if (!env.JWTKEY?.trim()) { diagnostics.report("authentication", "failed", "AUTHENTICATION_UNAVAILABLE"); throw new Error("JWTKEY is required for the Sites HTTP API"); }
  const config = (() => { try { return loadProductionConfig(env); } catch (error) { diagnostics.report("configuration", "failed", "CONFIGURATION_INVALID"); throw error; } })();
  const databaseUri = (() => { try { return requireMongoDatabaseUri(loadPersistenceConfig(env)); } catch (error) { diagnostics.report("database", "failed", "CONFIGURATION_UNAVAILABLE"); throw error; } })();
  const readiness = productionReadiness(config, loadVercelIntegrationConfig(env).configured, diagnostics, dependencies?.readiness);
  const database = dependencies?.database ?? new MongoConnectionManager(databaseUri);
  const identities = dependencies?.identities ?? new MongoIdentityRepository(database.connection);
  const shutdown = new AbortController();
  const accounts = productionVercelAccounts(database.connection, env, dependencies?.vercel, shutdown.signal, readiness.observe("oauth"));
  const preparation = productionPublishPreparation(database.connection, accounts, env, dependencies?.preparation, shutdown.signal, config, readiness.observe("preparation"));
  const publishing = productionVercelPublishing(database.connection, preparation, env, dependencies?.publishing, readiness.observe("publishing"), readiness.observe("reconciliation"));
  let ready = false, started = false, stopping = false;
  let starting: Promise<string> | undefined, closing: Promise<void> | undefined, disconnected: Promise<void> | undefined;
  const disconnect = () => disconnected ??= database.disconnect().catch((error: unknown) => {
    diagnostics.report("database", "failed", "DATABASE_DISCONNECT_FAILED"); diagnostics.report("shutdown", "failed", "DATABASE_DISCONNECT_FAILED"); throw error;
  });
  const drain = async (tasks: readonly Promise<unknown>[]) => {
    const timeoutMs = Math.min(30_000, Math.max(1, dependencies?.shutdownTimeoutMs ?? 30_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(tasks), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { shutdown.abort(); reject(Object.assign(new Error("Service shutdown did not drain"), { name: "ServiceShutdownTimeout" })); }, timeoutMs);
      })]);
    } catch (error) { readiness.drainFailed(); throw error; }
    finally { if (timer) clearTimeout(timer); }
  };
  const server = new SitesVersionHttpServer({
    host: config.host,
    port: config.port,
    allowedOrigins: config.allowedOrigins,
    identities,
    jwtKey: () => { if (!env.JWTKEY?.trim()) diagnostics.report("authentication", "unavailable", "AUTHENTICATION_UNAVAILABLE"); return env.JWTKEY; },
    isReady: async () => {
      try { return ready && !stopping && await readiness.check(database.status().connected, !!env.JWTKEY?.trim()) &&
        ready && !stopping && database.status().connected && !!env.JWTKEY?.trim(); }
      catch { diagnostics.report("database", "unavailable", "DATABASE_STATUS_UNAVAILABLE"); return false; }
    },
    routes: [
      ...accounts.routes,
      preparation.route,
      publishing.route,
      ...productionPublishingStatusRoutes(dependencies?.publishingStatus ?? mongoPublishingStatusReads(database.connection), () => new Date(), isLivePublishingEnabled(env)),
      ...productionWebsiteRoutes(dependencies?.websites ?? mongoWebsiteReads(database.connection)),
      productionWebsiteRenameRoute(dependencies?.websiteRenames ?? mongoWebsiteRenames(database.connection)),
      productionSavedSourceRoute(dependencies?.savedSources ?? mongoSavedSourceRepository(database.connection),
        config.dataRoot ? dependencies?.sourceArtifacts ?? savedSourceArtifactReader(config.dataRoot) : { read: () => { requireProductionDataRoot(config); return Promise.resolve(undefined); } }),
    ],
  });
  return {
    server,
    start: (): Promise<string> => {
      if (started || stopping) return Promise.reject(new Error("Sites HTTP API cannot be restarted"));
      started = true;
      return starting = (async () => {
        try {
          try { await database.connect(); diagnostics.report("database", "ready", "INITIALIZED"); }
          catch (error) { diagnostics.report("database", "failed", "DATABASE_CONNECT_FAILED"); throw error; }
          if (stopping) throw new Error("Sites HTTP API is closing");
          await accounts.initialize();
          if (stopping) throw new Error("Sites HTTP API is closing");
          await readiness.checkStorage();
          if (stopping) throw new Error("Sites HTTP API is closing");
          await publishing.initialize();
          if (stopping) throw new Error("Sites HTTP API is closing");
          const url = await server.start().catch((error: unknown) => { diagnostics.report("http", "failed", "HTTP_LISTEN_FAILED"); throw error; });
          diagnostics.report("http", "ready", "INITIALIZED");
          if (stopping) throw new Error("Sites HTTP API is closing");
          ready = true; readiness.started();
          return url;
        } catch (error) {
          ready = false; readiness.failed();
          await drain([server.close().then(() => server.drainRequests()), publishing.close(), preparation.close(), accounts.close()]);
          await disconnect();
          throw error;
        }
      })();
    },
    close: (): Promise<void> => {
      if (!stopping) readiness.stopping();
      stopping = true; ready = false;
      if (closing) return closing;
      const draining = [server.close().then(() => server.drainRequests()), publishing.close(), preparation.close(), accounts.close()];
      return closing ??= (async () => {
        await drain([starting?.catch(() => undefined) ?? Promise.resolve(), ...draining]);
        await disconnect();
        readiness.stopped();
      })();
    },
  };
}
