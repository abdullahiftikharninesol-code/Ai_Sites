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
import { createMongoBillingModels } from "../../persistence/mongodb/mongo-billing-models.js";
import {
  MongoModelCreditRateRepository,
  MongoSubscriberQuotaRepository,
} from "../../persistence/mongodb/mongo-billing-repositories.js";
import { SiteCreditBillingService } from "../../billing/credit-billing.js";
import {
  GetChatlyQuotaNotificationService,
  readUserCreditQuotaPayload,
} from "../../billing/getchatly-quota-notification.js";
import { MongoGetChatlyQuotaUserRepository } from "../../auth/identity-repository.js";
import { loadConfig } from "../../app/config/environment.js";
import { SharedRedisConnection } from "../../redis/shared-redis.js";
import { TemplateCatalogService } from "../../templates/application/template-catalog-service.js";
import { TemplateInstantiationService } from "../../templates/application/template-instantiation-service.js";
import { CatalogTemplateDesignReferenceResolver } from "../../templates/application/template-design-context.js";
import { TemplateCatalogCache } from "../../templates/cache/template-catalog-cache.js";
import { createMongoTemplateModels } from "../../templates/persistence/mongo-template-models.js";
import {
  MongoSiteCategoryRepository,
  MongoSiteTemplateRepository,
} from "../../templates/persistence/mongo-template-repositories.js";
import { GoogleCloudTemplateArtifactStorage } from "../../templates/publishing/google-cloud-template-artifact-storage.js";
import { ApplicationError } from "../../app/errors/application-error.js";
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
  const billingModels = createMongoBillingModels(mongo.connection);
  const quotas = new MongoSubscriberQuotaRepository(billingModels);
  const appConfig = loadConfig();
  const sharedRedis = new SharedRedisConnection({
    ...(appConfig.redisUrl ? { url: appConfig.redisUrl } : {}),
  });
  const templateModels = createMongoTemplateModels(mongo.connection);
  const templateRepositories = {
    templates: new MongoSiteTemplateRepository(templateModels),
    categories: new MongoSiteCategoryRepository(templateModels),
  };
  const templateCatalogCache = new TemplateCatalogCache(
    sharedRedis,
    appConfig.redisCacheEnvironment ?? "development",
  );
  const templateCatalog = new TemplateCatalogService(
    templateRepositories.templates,
    templateRepositories.categories,
    templateCatalogCache,
    appConfig.templateGcsBucket ?? "",
  );
  const templateSource = appConfig.templateGcsBucket
    ? new GoogleCloudTemplateArtifactStorage(appConfig.templateGcsBucket)
    : {
        readObject: () =>
          Promise.reject(new ApplicationError(
            "PROVIDER_CONFIGURATION_ERROR",
            "SITES_TEMPLATE_GCS_BUCKET is required to instantiate templates",
          )),
      };
  const quotaUsers = new MongoGetChatlyQuotaUserRepository(mongo.connection);
  const quotaNotifications = new GetChatlyQuotaNotificationService(
    quotas,
    quotaUsers,
    sharedRedis,
    appConfig.redisCacheEnvironment ?? "development",
  );
  const billing = new SiteCreditBillingService(
    new MongoModelCreditRateRepository(billingModels),
    quotas,
    jobs,
    quotaNotifications,
  );
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
    billing,
    versionCommitter,
    runtimeProvider: siteRuntime,
    templateDesignReferences: new CatalogTemplateDesignReferenceResolver(templateRepositories.templates, templateSource),
  });
  const templateInstantiation = new TemplateInstantiationService({
    templates: templateRepositories.templates,
    source: templateSource,
    execution: product.execution,
    artifacts,
    projects,
    versions: versionCommitter,
    browserQA: product.browserQA,
    cleanupSite: async (siteId, ownerId) => {
      await deleteMongoSite(models, siteId, ownerId);
      await artifacts.deletePrefix(`sites/${siteId}`);
    },
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
    // Concrete type so user-facing callers can use the owner-scoped lookup.
    projects,
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
    templateCatalog,
    templateCatalogCache,
    templateRepositories,
    templateInstantiation,
    readCanonicalQuota: (userId: string) => readUserCreditQuotaPayload(quotas, quotaUsers, userId),
    connectPersistence: async () => {
      await connectMongo(mongo);
      if (Number(mongo.connection.readyState) === 1)
        await migrateMongoProjectFilesToLocalArtifacts(models, artifacts);
    },
    databaseStatus: () => getMongoStatus(mongo),
    deleteSite: async (siteId: SiteId, ownerId: string) => {
      await deleteMongoSite(models, siteId, ownerId);
      await artifacts.deletePrefix(`sites/${siteId}`);
    },
    close: async () => {
      if (closed) return;
      if (product.execution.getActiveEnvironmentCount() !== 0)
        throw new Error("Cannot close persistent Sites product with active resources");
      siteRuntime.close();
      await sharedRedis.close();
      await disconnectMongo(mongo);
      closed = true;
    },
  };
}
