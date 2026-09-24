import { CustomDomainService } from "../../domains/custom-domain-service.js";
import { InMemoryCustomDomainRepository } from "../../domains/in-memory-custom-domain.repository.js";
import { ReservedHostnamePolicy } from "../../domains/custom-domain.js";
import { LocalNoopCertificateProvider } from "../../domains/domain-verification-provider.js";
import {
  LocalDnsRegistry,
  LocalDomainVerificationProvider,
} from "../../domains/local-domain-verification.provider.js";
import { DeploymentService } from "../../deployment/deployment-service.js";
import { LocalHostingProvider } from "../../hosting/local-hosting.provider.js";
import { LocalArtifactStore } from "../../persistence/local-artifact-store.js";
import { InMemorySiteDeploymentRepository } from "../../persistence/in-memory-repositories.js";
import {
  connectMongo,
  disconnectMongo,
  getMongoStatus,
  getSharedMongoConnection,
  type MongoConnectionManager,
} from "../../persistence/mongodb/mongo-connection.js";
import { createMongoModels } from "../../persistence/mongodb/mongo-models.js";
import {
  deleteMongoSite,
  migrateMongoProjectFilesToLocalArtifacts,
  MongoRuntimeState,
  MongoSiteJobRepository,
  MongoSiteProjectRepository,
  MongoSiteVersionCommitter,
  MongoSiteVersionRepository,
} from "../../persistence/mongodb/mongo-repositories.js";
import { LocalSiteRuntimeProvider } from "../../site-runtime/local/local-site-runtime.provider.js";
import { LocalSitesRuntimeGateway } from "../../site-runtime/local/local-sites-runtime-gateway.js";
import { SiteRuntimeService } from "../../site-runtime/site-runtime-service.js";
import type { SiteId } from "../../shared/types.js";
import { SiteQueries } from "../application/site-queries.js";
import {
  createLocalSitesProduct,
  type LocalSitesProductOptions,
} from "./create-local-sites-product.js";

export interface MongoPersistentSitesProductOptions extends Omit<
  LocalSitesProductOptions,
  "artifacts" | "projects" | "versions" | "jobs" | "versionCommitter"
> {
  readonly databaseUri?: string;
  readonly mongoConnection?: MongoConnectionManager;
}

export function createMongoPersistentSitesProduct(options: MongoPersistentSitesProductOptions) {
  const mongo = options.mongoConnection ?? getSharedMongoConnection(options.databaseUri);
  const models = createMongoModels(mongo.connection);
  const artifacts = new LocalArtifactStore(options.artifactRoot);
  const state = new MongoRuntimeState();
  const projects = new MongoSiteProjectRepository(models, state);
  const versions = new MongoSiteVersionRepository(models, artifacts, state);
  const jobs = new MongoSiteJobRepository(models);
  const deployments = new InMemorySiteDeploymentRepository();
  const customDomains = new InMemoryCustomDomainRepository();
  const versionCommitter = new MongoSiteVersionCommitter(models, artifacts, state);
  const siteRuntime = new LocalSiteRuntimeProvider(`mongo-product:${options.artifactRoot}`);
  const siteRuntimeService = new SiteRuntimeService(projects, siteRuntime);
  const localDns = new LocalDnsRegistry();
  const customDomainService = new CustomDomainService(
    projects,
    customDomains,
    new LocalDomainVerificationProvider(localDns),
    new LocalNoopCertificateProvider(),
    new ReservedHostnamePolicy(["localhost", "127.0.0.1"]),
  );
  const product = createLocalSitesProduct({
    ...options,
    artifacts,
    projects,
    versions,
    jobs,
    versionCommitter,
    runtimeProvider: siteRuntime,
  });
  const queries = new SiteQueries(projects, versions);
  const deploymentService = new DeploymentService(
    product.pipeline,
    product.execution,
    artifacts,
    projects,
    versions,
    deployments,
  );
  let closed = false;

  return {
    ...product,
    database: mongo,
    deployments,
    deploymentService,
    siteRuntime,
    siteRuntimeService,
    createRuntimeGateway: (allowedOrigins: readonly string[], host = "127.0.0.1", port = 0) =>
      new LocalSitesRuntimeGateway(siteRuntimeService, {
        host,
        port,
        allowedOrigins,
        maxRequestBytes: 64_000,
      }),
    createHostingGateway: (host = "127.0.0.1", port = 8088) =>
      new LocalHostingProvider(projects, deployments, artifacts, host, port, customDomains),
    customDomains,
    customDomainService,
    localDns,
    queries,
    artifacts,
    connectPersistence: async () => {
      await connectMongo(mongo);
      if (Number(mongo.connection.readyState) === 1)
        await migrateMongoProjectFilesToLocalArtifacts(models, artifacts);
    },
    databaseStatus: () => getMongoStatus(mongo),
    deleteSite: async (siteId: SiteId) => {
      await deleteMongoSite(models, siteId);
      await artifacts.deletePrefix(`sites/${siteId}`);
    },
    close: async () => {
      if (closed) return;
      if (product.execution.getActiveEnvironmentCount() !== 0)
        throw new Error("Cannot close persistent Sites product with active resources");
      siteRuntime.close();
      await disconnectMongo(mongo);
      closed = true;
    },
  };
}
