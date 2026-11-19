import type { Connection } from "mongoose";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { VercelConnectionService } from "../integrations/vercel/vercel-connection-service.js";
import { createVercelProjectProvider } from "../integrations/vercel/vercel-project-provider.js";
import { MongoPublishPreparationRepository } from "./publish-preparation-repository.js";
import { createVercelDeploymentsClient } from "../integrations/vercel/vercel-deployments-client.js";
import { MongoVercelPublishRepository } from "./vercel-publish-repository.js";
import { VercelPublishService, type VercelPublishServiceOptions } from "./vercel-publish-service.js";
import { ProductionBuildService, type ProductionBuildExecution } from "./production-build-service.js";
import {
  LOCAL_DEVELOPMENT_ALL_SITES_FLAG,
  PublishPreparationService,
  loadPublishBuildAccess,
  withLocalDevelopmentAllSites,
  type PublishBuildAccess,
  type PublishPreparationServiceOptions,
} from "./publish-preparation-service.js";
import { PublishingError } from "./publishing-errors.js";
import { loadCloudBuildConfig, loadPublishBuildProvider, type CloudBuildConfig } from "./cloud/cloud-build-config.js";
import { createGoogleCloudBuildApis } from "./cloud/cloud-build-gcp.js";
import { MongoCloudBuildLedger } from "./cloud/cloud-build-ledger.js";
import { CloudIsolationVerifier } from "./cloud/cloud-isolation-verifier.js";
import { CloudProductionBuildService } from "./cloud/cloud-production-build-service.js";

/** Composes live publishing (Stage 3); refuses to publish unless both live flags are true. */
export function createVercelPublishService(input: {
  readonly connection: Connection;
  readonly projects: VercelPublishServiceOptions["projects"];
  readonly preparations: VercelPublishServiceOptions["preparations"];
  readonly vercel: VercelConnectionService;
}): VercelPublishService {
  return new VercelPublishService({
    repository: new MongoVercelPublishRepository(input.connection),
    projects: input.projects,
    preparations: input.preparations,
    projectProvider: createVercelProjectProvider(input.connection, input.vercel),
    connections: input.vercel,
    deployments: createVercelDeploymentsClient(),
  });
}

/**
 * The build path for publishing (SITES_PUBLISH_BUILD_PROVIDER):
 *   local (default): this host, trusted site IDs only (Stage 2);
 *   cloud: Cloud Run job + sandboxes, any owner's eligible site once the
 *          isolation verifier passes. An incomplete cloud configuration
 *          refuses every build; it never falls back to local execution.
 */
export function createPublishBuildPath(input: {
  readonly connection: Connection;
  readonly execution: ProductionBuildExecution & { getCapabilities?(): { readonly secureIsolation?: boolean } };
  readonly env?: NodeJS.ProcessEnv;
  readonly cloudApis?: (config: CloudBuildConfig) => ReturnType<typeof createGoogleCloudBuildApis>;
  /**
   * Bind host of the calling development server. Only the loopback-only development
   * server passes it; with SITES_DEV_PUBLISH_ALLOW_ALL_LOCAL_SITES=true, local builds then
   * need no per-site ID. Production composition never calls this function.
   */
  readonly localDevelopmentHost?: string;
}): { readonly buildAccess: PublishBuildAccess; readonly builder: PublishPreparationServiceOptions["builder"]; readonly cloud?: CloudProductionBuildService } {
  const env = input.env ?? process.env;
  if (loadPublishBuildProvider(env) === "local") {
    const loaded = loadPublishBuildAccess(input.execution, env);
    const buildAccess = input.localDevelopmentHost === undefined ? loaded : withLocalDevelopmentAllSites(loaded, env, input.localDevelopmentHost);
    if (buildAccess.isolatedExecution === false && buildAccess.localDevelopmentAllSites)
      console.warn(`[sites][publish] local development: builds run on non-isolated local execution for every owned site (${LOCAL_DEVELOPMENT_ALL_SITES_FLAG}=true); never use this outside a trusted development machine`);
    else console.info(`[sites][publish] builds run on non-isolated local execution; trusted sites=${buildAccess.isolatedExecution ? 0 : buildAccess.trustedSiteIds.size} (SITES_PUBLISH_TRUSTED_SITE_IDS)`);
    return { buildAccess, builder: new ProductionBuildService(input.execution) };
  }
  const loaded = loadCloudBuildConfig(env);
  if (!loaded.ok) {
    console.warn(`[sites][publish] cloud builds selected but not configured; publishing builds are refused: ${loaded.problems.join("; ")}`);
    const unavailable = () =>
      Promise.reject(new PublishingError("PUBLISH_ISOLATION_UNAVAILABLE", "Isolated cloud builds aren't configured on this server, so sites can't be built for publishing.", {
        metadata: { reasons: loaded.problems.slice(0, 5) },
      }));
    return { buildAccess: { isolatedExecution: "verified-cloud", isolation: { assertVerified: unavailable } }, builder: { build: unavailable } };
  }
  const { config } = loaded;
  const apis = (input.cloudApis ?? createGoogleCloudBuildApis)(config);
  const ledger = new MongoCloudBuildLedger(input.connection);
  const verifier = new CloudIsolationVerifier({ config, jobs: apis.jobs, iam: apis.iam, ledger, coordinatorServiceAccount: apis.coordinatorServiceAccount });
  const cloud = new CloudProductionBuildService({ config, jobs: apis.jobs, transfer: apis.transfer, ledger, verifier, maxConcurrent: 2 });
  console.info(`[sites][publish] builds run in Cloud Run job ${config.jobName} (${config.region}) once isolation is verified`);
  return { buildAccess: { isolatedExecution: "verified-cloud", isolation: verifier }, builder: cloud, cloud };
}

/** Composes preparation from the existing Sites product (Mongo, artifacts, build path). */
export function createPublishPreparationService(input: {
  readonly connection: Connection;
  readonly projects: PublishPreparationServiceOptions["projects"];
  readonly versions: PublishPreparationServiceOptions["versions"];
  readonly artifacts: ArtifactStore;
  readonly execution: ProductionBuildExecution & { getCapabilities?(): { readonly secureIsolation?: boolean } };
  readonly vercel: VercelConnectionService;
  /** See createPublishBuildPath: passed only by the loopback-only development server. */
  readonly localDevelopmentHost?: string;
}): PublishPreparationService {
  const linkProjects = process.env.VERCEL_PROJECT_LINKING_ENABLED === "true";
  const { buildAccess, builder } = createPublishBuildPath({ connection: input.connection, execution: input.execution,
    ...(input.localDevelopmentHost !== undefined ? { localDevelopmentHost: input.localDevelopmentHost } : {}) });
  return new PublishPreparationService({
    buildAccess,
    repository: new MongoPublishPreparationRepository(input.connection),
    projects: input.projects,
    versions: input.versions,
    artifacts: input.artifacts,
    builder,
    connections: input.vercel,
    linkProjects,
    ...(linkProjects ? { projectProvider: createVercelProjectProvider(input.connection, input.vercel) } : {}),
  });
}
