import { resolve } from "node:path";
import { loadConfig } from "../../app/config/environment.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import { loadPersistenceConfig } from "../../persistence/persistence-config.js";
import {
  connectMongo,
  disconnectMongo,
  getSharedMongoConnection,
} from "../../persistence/mongodb/mongo-connection.js";
import { SharedRedisConnection } from "../../redis/shared-redis.js";
import {
  ApprovedTemplateCatalogRegistrationService,
  type ApprovedCatalogRegistrationResult,
} from "../application/approved-template-catalog-registration.js";
import { TemplateCatalogService } from "../application/template-catalog-service.js";
import { TemplateCatalogCache } from "../cache/template-catalog-cache.js";
import { createMongoTemplateModels } from "../persistence/mongo-template-models.js";
import {
  MongoSiteCategoryRepository,
  MongoSiteTemplateRepository,
} from "../persistence/mongo-template-repositories.js";

function printResult(
  result: ApprovedCatalogRegistrationResult,
  publicCategoryCount: number,
  publicTemplateCount: number,
): void {
  console.info("Sites template catalog registration:");
  console.info(`categories created: ${result.categoriesCreated}`);
  console.info(`categories existing: ${result.categoriesExisting}`);
  console.info(`templates created: ${result.templatesCreated}`);
  console.info(`templates existing: ${result.templatesExisting}`);
  console.info(`conflicts: ${result.conflicts}`);
  console.info(`template catalog cache invalidated: ${result.cacheInvalidated ? "YES" : "NO-OP"}`);
  console.info(`public active categories: ${publicCategoryCount}`);
  console.info(`public active templates: ${publicTemplateCount}`);
  console.info("\nCategories:");
  for (const category of result.categories)
    console.info(
      `${category.categoryKey} | ${category.name} | ${category.sortOrder} | ${category.created ? "created" : "existing"} | ${category.status}`,
    );
  console.info("\nTemplates:");
  for (const template of result.templates)
    console.info(
      `${template.templateKey} | v${template.version} | ${template.categoryKey}/${template.categoryName} | ${template.status} | routes=${template.routeCount} | tags=${template.tagCount} | ${template.created ? "created" : "existing"}`,
    );
  console.info("\nArtifact metadata: ABSENT");
  console.info("GCS client: NOT INSTANTIATED");
  console.info("GCS writes: 0");
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("This command does not accept arguments");
  const persistence = loadPersistenceConfig();
  const config = loadConfig();
  const mongo = getSharedMongoConnection(persistence.databaseUri);
  const redis = new SharedRedisConnection({ ...(config.redisUrl ? { url: config.redisUrl } : {}) });
  try {
    await connectMongo(mongo);
    const models = createMongoTemplateModels(mongo.connection);
    const templates = new MongoSiteTemplateRepository(models);
    const categories = new MongoSiteCategoryRepository(models);
    const cache = new TemplateCatalogCache(redis, config.redisCacheEnvironment ?? "development");
    const registration = new ApprovedTemplateCatalogRegistrationService(
      categories,
      templates,
      {
        invalidateTemplateCatalogCache: () => cache.requireTemplateCatalogCacheInvalidation(),
      },
    );
    const result = await registration.register(resolve("templates"));
    const catalog = new TemplateCatalogService(
      templates,
      categories,
      cache,
      config.templateGcsBucket ?? "",
    );
    const publicCategories = await catalog.listActiveCategories();
    const publicTemplates = await catalog.listActiveTemplates({ tags: [], page: 1, limit: 100 });
    printResult(result, publicCategories.data.length, publicTemplates.data.length);
  } finally {
    await redis.close();
    await disconnectMongo(mongo);
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof ApplicationError ? error.code : "PERSISTENCE_WRITE_FAILED";
  const message = error instanceof Error ? error.message : "Template catalog registration failed";
  console.error(`[sites][templates] ${code}: ${message}`);
  process.exitCode = 1;
}
