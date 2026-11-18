import { loadProductionConfig, requireProductionDataRoot, type ProductionConfig } from "./production-config.js";
import type { Connection } from "mongoose";
import type { MongoSiteProjectRecord } from "../persistence/mongodb/mongo-models.js";
import { MongoRuntimeState, projectFrom, versionFrom } from "../persistence/mongodb/mongo-repositories.js";
import { mongoWebsiteReads, validSiteId } from "./production-website-reads.js";
import { PublishPreparationService, loadPublishBuildAccess, type PublishPreparationServiceOptions } from "../publishing/publish-preparation-service.js";
import { MongoPublishPreparationRepository } from "../publishing/publish-preparation-repository.js";
import { PublishingError, isPublishingErrorCode } from "../publishing/publishing-errors.js";
import { ProductionBuildService, loadProductionBuildLimits } from "../publishing/production-build-service.js";
import { LocalExecutionProvider } from "../execution/local/local-execution.provider.js";
import { loadLocalExecutionConfig } from "../execution/local/local-execution.config.js";
import { VercelProjectProvider, type PublishedProjectPin } from "../integrations/vercel/vercel-project-provider.js";
import { MongoVercelProjectLinkRepository, type VercelProjectLinkRepository } from "../integrations/vercel/vercel-project-link-repository.js";
import { createVercelProjectsClient, type VercelProjectsClient } from "../integrations/vercel/vercel-projects-client.js";
import { createVercelAccountVerifier, type VercelAccountVerifier } from "../integrations/vercel/vercel-account-verifier.js";
import type { VercelCredentials } from "../integrations/vercel/vercel-connection-service.js";
import type { SiteId } from "../shared/types.js";
import { preparationDirectory, productionPreparationArtifacts } from "./production-preparation-storage.js";
import type { ProductionRoute } from "./production-http-routes.js";
import type { productionVercelAccounts } from "./production-vercel-accounts.js";
import { productionProviderFetch } from "./production-provider-fetch.js";
import type { InitializationState } from "./production-readiness.js";

export interface ProductionPreparationDependencies {
  readonly repository?: PublishPreparationServiceOptions["repository"] & { ready?(): Promise<void> };
  readonly projects?: PublishPreparationServiceOptions["projects"];
  readonly versions?: PublishPreparationServiceOptions["versions"];
  readonly artifacts?: PublishPreparationServiceOptions["artifacts"];
  readonly builder?: PublishPreparationServiceOptions["builder"];
  readonly credentials?: (ownerId: string) => Promise<VercelCredentials>;
  readonly verifier?: VercelAccountVerifier;
  readonly projectLinks?: VercelProjectLinkRepository & { ready?(): Promise<void> };
  readonly projectClient?: VercelProjectsClient;
}
const interrupted = () => new PublishingError("PUBLISH_INTERRUPTED", "Publishing preparation is shutting down. Try again.");
const mismatch = () => new PublishingError("VERCEL_ACCOUNT_MISMATCH", "The Vercel connection changed during preparation. Reconnect the intended account and try again.");
const unavailable = () => new PublishingError("PUBLISH_SOURCE_UNAVAILABLE", "The saved version or its storage is unavailable.");

export function productionPublishPreparation(connection: Connection, accounts: ReturnType<typeof productionVercelAccounts>, env: NodeJS.ProcessEnv, dependencies: ProductionPreparationDependencies = {}, shutdownSignal?: AbortSignal, config: ProductionConfig = loadProductionConfig(env), observe?: (state: InitializationState) => void) {
  const providerShutdown = new AbortController();
  const providerFetch = productionProviderFetch(shutdownSignal ? AbortSignal.any([shutdownSignal, providerShutdown.signal]) : providerShutdown.signal);
  const metadata = mongoWebsiteReads(connection), state = new MongoRuntimeState();
  const projects = dependencies.projects ?? { getOwnedById: async (siteId, ownerId) => {
    const row = await metadata.getOwnedById(siteId, ownerId);
    if (!row || row._id !== siteId || row.ownerId !== ownerId) return undefined;
    if (!validSiteId(row._id) || !Number.isSafeInteger(row.versionNumber) || row.versionNumber < 0 || !["DRAFT", "ACTIVE", "ARCHIVED"].includes(row.status) ||
      !Number.isFinite(new Date(row.updatedAt).getTime()) || !Number.isFinite(new Date(row.createdAt).getTime())) throw unavailable();
    return projectFrom(row, state);
  } } satisfies PublishPreparationServiceOptions["projects"];
  const versions = dependencies.versions ?? { getById: async (versionId, ownerId) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,199}):v([1-9][0-9]*)$/.exec(versionId);
    if (!match || !ownerId || !connection.db) return undefined;
    const row = await connection.db.collection<MongoSiteProjectRecord>("sites_projects").findOne({ _id: match[1]!, ownerId },
      { projection: { _id: 1, ownerId: 1, versionNumber: 1, sourceArtifactRef: 1, sourceManifestRef: 1, updatedAt: 1 }, maxTimeMS: 5_000 });
    if (!row || row._id !== match[1] || row.ownerId !== ownerId || row.versionNumber !== Number(match[2])) return undefined;
    const ref = row.sourceArtifactRef ?? `sites/${row._id}/current/source.json`;
    if (typeof ref !== "string" || !ref.startsWith(`sites/${row._id}/`) ||
      !/^sites\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/(?:current\/source\.json|versions\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/source\/source\.json)$/.test(ref) ||
      !Number.isFinite(new Date(row.updatedAt).getTime())) throw unavailable();
    return versionFrom(row);
  } } satisfies PublishPreparationServiceOptions["versions"];
  const rawCredentials = dependencies.credentials ?? accounts.credentials;
  const verifier = dependencies.verifier ?? createVercelAccountVerifier(createVercelProjectsClient(providerFetch));
  let stopping = false, service: PublishPreparationService | undefined, initializing: Promise<PublishPreparationService> | undefined;
  const pending = new Set<Promise<void>>();
  let publishingProjectProvider: PublishPreparationServiceOptions["projectProvider"];
  let preparationRepository: PublishPreparationServiceOptions["repository"];
  const same = (a: VercelCredentials, b: VercelCredentials) => a.ownerId === b.ownerId && a.configurationId === b.configurationId && a.vercelUserId === b.vercelUserId && a.teamId === b.teamId && a.accessToken === b.accessToken;
  const credentials = async (ownerId: string) => {
    if (stopping) throw interrupted();
    const initial = await rawCredentials(ownerId);
    if (initial.ownerId !== ownerId) throw mismatch();
    const verification = await verifier.verify({ auth: initial, configurationId: initial.configurationId, accountId: initial.teamId ?? initial.vercelUserId, now: new Date() });
    if (verification.state !== "OK") {
      const code = verification.problem === "ACCOUNT_MISMATCH" ? "VERCEL_ACCOUNT_MISMATCH" : verification.problem === "MISSING_PERMISSIONS" ? "VERCEL_PROJECT_SCOPE_MISSING"
        : verification.problem === "INTEGRATION_DISABLED" || verification.problem === "INTEGRATION_REMOVED" ? "VERCEL_INTEGRATION_DISABLED" : verification.problem === "RATE_LIMITED" ? "VERCEL_RATE_LIMITED"
          : verification.state === "REAUTHORIZATION_REQUIRED" ? "VERCEL_TOKEN_REVOKED" : "VERCEL_UNAVAILABLE";
      throw new PublishingError(code, "Vercel authorization could not be verified. Reconnect or try again later.");
    }
    if (!same(initial, await rawCredentials(ownerId))) throw mismatch();
    if (stopping) throw interrupted();
    return initial;
  };
  const getService = () => initializing ??= (async () => {
    observe?.("initializing");
    const dataRoot = requireProductionDataRoot(config);
    const provider = env.SITES_PUBLISH_BUILD_PROVIDER === undefined ? "local" : env.SITES_PUBLISH_BUILD_PROVIDER.trim();
    if (provider !== "local") throw new PublishingError("PUBLISH_ISOLATION_UNAVAILABLE", provider === "cloud" ? "Isolated cloud builds are not enabled in this production API." : "The publishing build provider is not recognized. Local execution was refused.");
    const repository = dependencies.repository ?? new MongoPublishPreparationRepository(connection);
    preparationRepository = repository;
    await repository.ready?.();
    const linkProjects = env.VERCEL_PROJECT_LINKING_ENABLED === "true";
    let projectProvider: PublishPreparationServiceOptions["projectProvider"];
    if (linkProjects) {
      const links = dependencies.projectLinks ?? new MongoVercelProjectLinkRepository(connection);
      await links.ready?.();
      const client = dependencies.projectClient ?? createVercelProjectsClient(providerFetch);
      projectProvider = { ensureProject: async (ownerId, siteId) => {
        const expected = await rawCredentials(ownerId);
        if (expected.ownerId !== ownerId) throw mismatch();
        const check = async () => { if (stopping) throw interrupted(); if (!same(expected, await rawCredentials(ownerId))) throw mismatch(); };
        const guarded = <T>(call: () => Promise<T>) => (async () => { await check(); const result = await call(); await check(); return result; })();
        const api: VercelProjectsClient = {
          getConfiguration: (auth, id) => guarded(() => client.getConfiguration(auth, id)), findProject: (auth, id) => guarded(() => client.findProject(auth, id)),
          createProject: (auth, input) => guarded(() => client.createProject(auth, input)), getAccountName: auth => guarded(() => client.getAccountName(auth)),
        };
        const guardedLinks: VercelProjectLinkRepository = { find: id => links.find(id), claimCreation: input => guarded(() => links.claimCreation(input)),
          completeLink: (...args) => guarded(() => links.completeLink(...args)), releaseLease: (...args) => links.releaseLease(...args), markStale: (...args) => guarded(() => links.markStale(...args)) };
        const pinned = async (id: string): Promise<PublishedProjectPin | undefined> => {
          if (!connection.db) throw unavailable();
          const row = await connection.db.collection("sites_site_publications").findOne({ ownerId, siteId: id }, { projection: { projectId: 1, accountId: 1 }, maxTimeMS: 5_000 });
          if (!row) return undefined;
          if (typeof row.projectId !== "string" || !row.projectId || typeof row.accountId !== "string" || !row.accountId) throw unavailable();
          return { projectId: row.projectId, accountId: row.accountId };
        };
        return new VercelProjectProvider({ credentials: async () => { await check(); return expected; } }, guardedLinks, api, () => new Date(), pinned).ensureProject(ownerId, siteId);
      } };
    }
    publishingProjectProvider = projectProvider;
    let local: ProductionBuildService | undefined;
    const builder = dependencies.builder ?? { build: async (input) => {
      if (stopping) throw interrupted();
      await preparationDirectory(dataRoot, ["artifacts"]);
      const executionRoot = await preparationDirectory(dataRoot, ["execution"], true);
      if (!local) {
        const execution = new LocalExecutionProvider({ ...loadLocalExecutionConfig(env), rootDirectory: executionRoot, keepWorkspace: false, previewHost: "127.0.0.1" });
        local = new ProductionBuildService({ createEnvironment: options => execution.createEnvironment(options), destroyEnvironment: id => execution.destroyEnvironment(id),
          writeFileBytes: (...args) => execution.writeFileBytes(...args), executeCommand: (...args) => execution.executeCommand(...args), getWorkspacePath: id => execution.getWorkspacePath(id) }, loadProductionBuildLimits(env));
      }
      return local.build(input);
    } } satisfies PublishPreparationServiceOptions["builder"];
    const concurrent = Number(env.SITES_PUBLISH_MAX_CONCURRENT ?? 1);
    service = new PublishPreparationService({ repository, projects, versions, artifacts: dependencies.artifacts ?? productionPreparationArtifacts(dataRoot), builder,
      connections: { credentials }, buildAccess: loadPublishBuildAccess({}, env), linkProjects, ...(projectProvider ? { projectProvider } : {}),
      maxConcurrent: Number.isInteger(concurrent) ? Math.min(4, Math.max(1, concurrent)) : 1 });
    if (stopping) { await service.close(); throw interrupted(); }
    return service;
  })().then(value => { observe?.("ready"); return value; }, (error: unknown) => { observe?.("failed"); throw error; });
  const route: ProductionRoute = { access: "authenticated", method: "POST", path: "/api/dev/sites/:siteId/versions/:versionId/publish/prepare", body: "json",
    handle: context => {
      const task = (async () => {
        if (stopping) throw Object.assign(new Error("Service unavailable"), { code: "SERVICE_UNAVAILABLE" });
        const { siteId, versionId } = context.params;
        if (!siteId || !validSiteId(siteId) || !versionId || !versionId.startsWith(`${siteId}:v`)) throw Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
        if (context.body && (context.body instanceof Uint8Array || Object.keys(context.body).length)) throw Object.assign(new Error("No preparation body fields are supported"), { code: "INVALID_REQUEST" });
        try {
          await assertAllowed(context.ownerId, siteId, versionId);
          const prepared = await (await getService()).prepare(context.ownerId, siteId, versionId);
          const { metrics: ignoredMetrics, failure: storedFailure, ...view } = prepared; void ignoredMetrics;
          const failure = storedFailure ? { code: isPublishingErrorCode(storedFailure.code) ? storedFailure.code : "PUBLISH_PREPARATION_FAILED", message: "Publishing preparation could not complete. Check the connection and try again.", retryable: storedFailure.retryable === true } : undefined;
          context.response.writeHead(202, { "content-type": "application/json; charset=utf-8" }); context.response.end(JSON.stringify({ preparation: { ...view, ...(failure ? { failure } : {}) } }));
        } catch (error) {
          if (!(error instanceof PublishingError)) throw error;
          context.response.writeHead(error.httpStatus, { "content-type": "application/json; charset=utf-8" }); context.response.end(JSON.stringify({ error: { code: error.code, message: "Publishing preparation was refused or could not complete. Check the saved version, connection and build configuration.", retryable: error.retryable } }));
        }
      })();
      pending.add(task); void task.finally(() => pending.delete(task)).catch(() => undefined); return task;
    },
  };
  const assertAllowed = async (ownerId: string, siteId: string, versionId: string) => {
    if (stopping) throw interrupted();
    const project = await projects.getOwnedById(siteId as SiteId, ownerId);
    if (!project || project.id !== siteId || project.ownerId !== ownerId) throw Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
    if (project.latestVersionId !== versionId) throw new PublishingError("PUBLISH_VERSION_NOT_CURRENT", "Only the current saved version may be published.");
    const provider = env.SITES_PUBLISH_BUILD_PROVIDER === undefined ? "local" : env.SITES_PUBLISH_BUILD_PROVIDER.trim();
    if (provider !== "local") throw new PublishingError("PUBLISH_ISOLATION_UNAVAILABLE", "Verified build isolation is unavailable. No local fallback was used.");
    const access = loadPublishBuildAccess({}, env);
    if (access.isolatedExecution !== false || !access.trustedSiteIds.has(siteId)) throw new PublishingError("PUBLISH_SITE_NOT_TRUSTED", "Publishing is limited to explicitly trusted sites.");
  };
  return { route, assertAllowed, publishing: async () => {
    const prepared = await getService();
    if (!publishingProjectProvider) throw new PublishingError("PUBLISH_LIVE_DISABLED", "Project linking is disabled.");
    return { projects, projectProvider: publishingProjectProvider, connections: { credentials },
      assertConnection: async (ownerId: string, expected: VercelCredentials) => {
        if (!same(expected, await rawCredentials(ownerId))) throw mismatch();
      },
      preparations: {
        prepare: async (ownerId: string, siteId: string, versionId: string) => { await assertAllowed(ownerId, siteId, versionId); return prepared.prepare(ownerId, siteId, versionId); },
        latest: (ownerId: string, siteId: string) => prepared.latest(ownerId, siteId),
        loadReadyArtifact: async (ownerId: string, preparationId: string) => {
          const stored = await preparationRepository.findOwned(ownerId, preparationId);
          if (!stored || stored.ownerId !== ownerId || stored.preparationId !== preparationId || stored.provider !== "vercel")
            throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared artifact binding is invalid.");
          const prefix = `sites/${stored.siteId}/publishing/${preparationId}/attempt-`, ref = stored.artifact?.ref;
          const artifactAttempt = typeof ref === "string" && ref.startsWith(prefix) ? /^([1-9][0-9]*)\/artifact\.json$/.exec(ref.slice(prefix.length)) : null;
          if (!artifactAttempt || !Number.isSafeInteger(stored.attempt) || stored.attempt < 1 || !Number.isSafeInteger(Number(artifactAttempt[1])) || Number(artifactAttempt[1]) > stored.attempt)
            throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared artifact binding is invalid.");
          await assertAllowed(ownerId, stored.siteId, stored.versionId);
          const result = await prepared.loadReadyArtifact(ownerId, preparationId), record = result.record;
          await assertAllowed(ownerId, record.siteId, record.versionId);
          const current = await credentials(ownerId), expected = record.connection;
          if (record.ownerId !== ownerId || record.provider !== "vercel" || current.configurationId !== expected.configurationId || current.vercelUserId !== expected.vercelUserId || current.teamId !== expected.teamId) throw mismatch();
          if (record.attempt !== stored.attempt || record.artifact?.ref !== stored.artifact?.ref || record.artifact?.sha256 !== stored.artifact?.sha256)
            throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared artifact binding is invalid.");
          return result;
        },
      },
    };
  }, close: async () => {
    stopping = true;
    providerShutdown.abort();
    const draining = service?.close();
    await Promise.allSettled([...pending]); await initializing?.catch(() => undefined); await draining; await service?.close();
  } };
}
