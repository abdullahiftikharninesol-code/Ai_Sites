import { resolve } from "node:path";
import { LocalArtifactStore } from "../../persistence/local-artifact-store.js";
import { SqliteCatalogedArtifactStore } from "../../persistence/sqlite/sqlite-artifact-store.js";
import { SqliteDatabase } from "../../persistence/sqlite/sqlite-database.js";
import {
  SqliteSiteDeploymentRepository,
  SqliteSiteJobRepository,
  SqliteSiteProjectRepository,
  SqliteSiteVersionCommitter,
  SqliteSiteVersionRepository,
} from "../../persistence/sqlite/sqlite-repositories.js";
import { SiteQueries } from "../application/site-queries.js";
import { DeploymentService } from "../../deployment/deployment-service.js";
import { LocalHostingProvider } from "../../hosting/local-hosting.provider.js";
import { LocalSiteRuntimeProvider } from "../../site-runtime/local/local-site-runtime.provider.js";
import { SiteRuntimeService } from "../../site-runtime/site-runtime-service.js";
import { LocalSitesRuntimeGateway } from "../../site-runtime/local/local-sites-runtime-gateway.js";
import { SqliteCustomDomainRepository } from "../../domains/sqlite-custom-domain.repository.js";
import {
  LocalDnsRegistry,
  LocalDomainVerificationProvider,
} from "../../domains/local-domain-verification.provider.js";
import { LocalNoopCertificateProvider } from "../../domains/domain-verification-provider.js";
import { ReservedHostnamePolicy } from "../../domains/custom-domain.js";
import { CustomDomainService } from "../../domains/custom-domain-service.js";
import {
  createLocalSitesProduct,
  type LocalSitesProductOptions,
} from "./create-local-sites-product.js";
export interface LocalPersistentSitesProductOptions extends Omit<
  LocalSitesProductOptions,
  "artifacts" | "projects" | "versions" | "jobs" | "versionCommitter"
> {
  readonly databasePath?: string;
  readonly runtimeDatabasePath?: string;
}
export function createLocalPersistentSitesProduct(options: LocalPersistentSitesProductOptions) {
  const database = new SqliteDatabase(options.databasePath ?? resolve(".local-data/sites.db"));
  const projects = new SqliteSiteProjectRepository(database);
  const siteRuntime = new LocalSiteRuntimeProvider(
    options.runtimeDatabasePath ?? resolve(".local-data/runtime/sites-runtime.db"),
  );
  const siteRuntimeService = new SiteRuntimeService(projects, siteRuntime);
  const versions = new SqliteSiteVersionRepository(database);
  const jobs = new SqliteSiteJobRepository(database);
  const deployments = new SqliteSiteDeploymentRepository(database);
  const customDomains = new SqliteCustomDomainRepository(database);
  const localDns = new LocalDnsRegistry();
  const customDomainService = new CustomDomainService(
    projects,
    customDomains,
    new LocalDomainVerificationProvider(localDns),
    new LocalNoopCertificateProvider(),
    new ReservedHostnamePolicy(["localhost", "127.0.0.1"]),
  );
  const versionCommitter = new SqliteSiteVersionCommitter(database);
  const artifacts = new SqliteCatalogedArtifactStore(
    new LocalArtifactStore(options.artifactRoot),
    database,
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
    database,
  );
  let closed = false;
  return {
    ...product,
    database,
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
    close: () => {
      if (!closed) {
        if (
          product.execution.getActiveEnvironmentCount() !== 0 ||
          product.browserRenderer.activeBrowserCount !== 0
        )
          throw new Error("Cannot close persistent Sites product with active resources");
        siteRuntime.close();
        database.close();
        closed = true;
        return Promise.resolve();
      }
    },
  };
}
