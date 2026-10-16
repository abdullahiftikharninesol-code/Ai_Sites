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
  ApprovedTemplateCatalogPublicationService,
  type ApprovedCatalogPublicationResult,
} from "../application/approved-template-catalog-publication.js";
import {
  APPROVED_TEMPLATE_CATEGORIES,
  EXPECTED_CATEGORY_BY_TEMPLATE,
} from "../application/approved-template-catalog-registration.js";
import { TemplateCatalogService } from "../application/template-catalog-service.js";
import { TemplateCatalogCache } from "../cache/template-catalog-cache.js";
import { createMongoTemplateModels } from "../persistence/mongo-template-models.js";
import {
  MongoSiteCategoryRepository,
  MongoSiteTemplateRepository,
} from "../persistence/mongo-template-repositories.js";
import { GoogleCloudTemplateArtifactStorage } from "../publishing/google-cloud-template-artifact-storage.js";
import { TrustedInternalTemplateBuildRunner } from "../publishing/template-build.js";

const REQUIRED_BUCKET = "bucket-chatbot-ni";

async function verifyPublicCatalog(
  catalog: TemplateCatalogService,
): Promise<{ readonly templates: number; readonly categories: number }> {
  const categories = await catalog.listActiveCategories();
  const templates = await catalog.listActiveTemplates({ tags: [], page: 1, limit: 100 });
  if (categories.data.length !== 8 || templates.data.length !== 8)
    throw new Error("Public template catalog count verification failed");
  for (const definition of APPROVED_TEMPLATE_CATEGORIES) {
    const expected = Object.entries(EXPECTED_CATEGORY_BY_TEMPLATE).find(
      ([, categoryKey]) => categoryKey === definition.categoryKey,
    )?.[0];
    const filtered = await catalog.listActiveTemplates({
      category: definition.categoryKey,
      tags: [],
      page: 1,
      limit: 100,
    });
    if (filtered.data.length !== 1 || filtered.data[0]?.templateKey !== expected)
      throw new Error(`Public category filter failed: ${definition.categoryKey}`);
  }
  for (const template of templates.data) {
    const serialized = template as unknown as Record<string, unknown>;
    if ("sourceObject" in serialized || "sourceSha256" in serialized)
      throw new Error("Private source metadata was exposed publicly");
    for (const preview of Object.values(template.previews))
      if (
        typeof preview !== "string" ||
        !preview.startsWith(`https://storage.googleapis.com/${REQUIRED_BUCKET}/sites/templates/`)
      )
        throw new Error("Public preview URL verification failed");
  }
  return { templates: templates.data.length, categories: categories.data.length };
}

function printResult(
  result: ApprovedCatalogPublicationResult,
  generationBefore: string,
  generationAfter: string,
  publicCounts: { readonly templates: number; readonly categories: number },
): void {
  console.info("Sites approved template publication:");
  console.info(`uploads created: ${result.uploadsCreated}`);
  console.info(`matching existing objects: ${result.matchingExistingObjects}`);
  console.info(`conflicts: ${result.conflicts}`);
  console.info(`template catalog cache invalidated: ${result.cacheInvalidated ? "YES" : "NO"}`);
  console.info(`generation before: ${generationBefore}`);
  console.info(`generation after: ${generationAfter}`);
  console.info(`public active categories: ${publicCounts.categories}`);
  console.info(`public active templates: ${publicCounts.templates}`);
  console.info("source metadata public: NO");
  console.info("category filtering: PASS");
  console.info("GCS deletes attempted: 0");
  console.info("GCS overwrites: 0");
  console.info("\nTemplates:");
  for (const template of result.templates)
    console.info(
      `${template.templateKey} | build=${template.build} | qa=${template.qa} | source=${template.source} | desktop=${template.desktop} | tablet=${template.tablet} | mobile=${template.mobile} | mongo=${template.mongo} | status=${template.status}`,
    );
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("This command does not accept arguments");
  const config = loadConfig();
  if (config.templateGcsBucket !== REQUIRED_BUCKET)
    throw new Error(`SITES_TEMPLATE_GCS_BUCKET must be ${REQUIRED_BUCKET}`);
  const persistence = loadPersistenceConfig();
  const mongo = getSharedMongoConnection(persistence.databaseUri);
  const redis = new SharedRedisConnection({ ...(config.redisUrl ? { url: config.redisUrl } : {}) });
  try {
    await connectMongo(mongo);
    const models = createMongoTemplateModels(mongo.connection);
    const templates = new MongoSiteTemplateRepository(models);
    const categories = new MongoSiteCategoryRepository(models);
    const cache = new TemplateCatalogCache(redis, config.redisCacheEnvironment ?? "development");
    const generationBefore = await cache.generation();
    const publication = new ApprovedTemplateCatalogPublicationService(
      templates,
      categories,
      new GoogleCloudTemplateArtifactStorage(config.templateGcsBucket),
      {
        invalidateTemplateCatalogCache: () => cache.requireTemplateCatalogCacheInvalidation(),
      },
      new TrustedInternalTemplateBuildRunner(),
    );
    const result = await publication.publishAll(resolve("templates"));
    const generationAfter = await cache.generation();
    if (Number(generationAfter) <= Number(generationBefore))
      throw new Error("Template catalog generation did not increase");
    const catalog = new TemplateCatalogService(
      templates,
      categories,
      cache,
      config.templateGcsBucket,
    );
    const publicCounts = await verifyPublicCatalog(catalog);
    printResult(result, generationBefore, generationAfter, publicCounts);
  } finally {
    await redis.close();
    await disconnectMongo(mongo);
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof ApplicationError ? error.code : "TEMPLATE_PUBLISH_FAILED";
  const message = error instanceof Error ? error.message : "Approved template publication failed";
  console.error(`[sites][templates] ${code}: ${message}`);
  process.exitCode = 1;
}
