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
import { TemplateCatalogCache } from "../cache/template-catalog-cache.js";
import type { SiteCategory, SiteTemplate } from "../domain/site-template.js";
import { createMongoTemplateModels } from "../persistence/mongo-template-models.js";
import {
  MongoSiteCategoryRepository,
  MongoSiteTemplateRepository,
} from "../persistence/mongo-template-repositories.js";
import type { TemplatePublicationRepository } from "../repositories.js";
import { GoogleCloudTemplateArtifactStorage } from "../publishing/google-cloud-template-artifact-storage.js";
import type { TemplateArtifactStorage } from "../publishing/template-artifact-storage.js";
import { TrustedInternalTemplateBuildRunner } from "../publishing/template-build.js";
import {
  TemplatePublisher,
  type TemplateCacheInvalidator,
  type TemplateCategoryLookup,
  type TemplatePublicationResult,
} from "../publishing/template-publisher.js";

interface CliOptions {
  readonly directory: string;
  readonly dryRun: boolean;
}

function parseArguments(args: readonly string[]): CliOptions {
  let directory: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--dir") {
      directory = args[index + 1];
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${value ?? ""}`);
  }
  if (!directory) throw new Error("--dir is required");
  return { directory: resolve(directory), dryRun };
}

class DryRunStorage implements TemplateArtifactStorage {
  readonly bucketName = "dry-run";
  objectExists(): Promise<boolean> {
    throw new Error("Dry-run attempted GCS access");
  }
  putObject(): Promise<void> {
    throw new Error("Dry-run attempted GCS upload");
  }
  deleteObject(): Promise<void> {
    throw new Error("Dry-run attempted GCS deletion");
  }
}

class DryRunTemplates implements TemplatePublicationRepository {
  findTemplateVersion(): Promise<SiteTemplate | undefined> {
    throw new Error("Dry-run attempted Mongo template read");
  }
  createTemplateVersion(): Promise<SiteTemplate> {
    throw new Error("Dry-run attempted Mongo template write");
  }
}

class DryRunCategories implements TemplateCategoryLookup {
  findCategoryByKey(categoryKey: string): Promise<SiteCategory> {
    const now = new Date(0);
    return Promise.resolve({
      id: `dry-run:${categoryKey}`,
      categoryKey,
      name: categoryKey,
      description: "Dry-run category resolution",
      status: "active",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

class DryRunCache implements TemplateCacheInvalidator {
  invalidateTemplateCatalogCache(): Promise<void> {
    throw new Error("Dry-run attempted Redis invalidation");
  }
}

function printResult(result: TemplatePublicationResult): void {
  console.info(`Template:\n${result.templateKey}`);
  console.info(`\nVersion:\n${result.version}`);
  console.info(`\nCategory:\n${result.categoryKey}`);
  console.info(`\nStatus:\n${result.status}`);
  console.info(`\nRoutes:\n${result.routeCount}`);
  console.info(`\nBrowser QA:\n${result.browserQA}`);
  console.info(`\nRoutes checked:\n${result.routesChecked}`);
  console.info(`\nViewports checked:\n${result.viewportsChecked}`);
  console.info("\nDesktop preview:\nGENERATED");
  console.info("\nTablet preview:\nGENERATED");
  console.info("\nMobile preview:\nGENERATED");
  console.info("\nPreview byte sizes:");
  console.info(`desktop=${result.previewByteSizes.desktop}`);
  console.info(`tablet=${result.previewByteSizes.tablet}`);
  console.info(`mobile=${result.previewByteSizes.mobile}`);
  console.info(`\nZIP size:\n${result.zipSizeBytes}`);
  console.info(`\nSHA-256:\n${result.sha256}`);
  console.info(`\nSource object:\n${result.objects.source}`);
  console.info(`\nDesktop preview object:\n${result.objects.previews.desktop}`);
  console.info(`\nTablet preview object:\n${result.objects.previews.tablet}`);
  console.info(`\nMobile preview object:\n${result.objects.previews.mobile}`);
  console.info(`\nGCS:\n${result.gcsUpload}${result.dryRun ? " (dry-run)" : ""}`);
  console.info(`\nMongo:\n${result.mongoWrite}${result.dryRun ? " (dry-run)" : ""}`);
  console.info(`\nRedis:\n${result.redisInvalidation}${result.dryRun ? " (dry-run)" : ""}`);
}

async function runDryRun(options: CliOptions): Promise<void> {
  const publisher = new TemplatePublisher(
    new DryRunTemplates(),
    new DryRunCategories(),
    new DryRunStorage(),
    new DryRunCache(),
    new TrustedInternalTemplateBuildRunner(),
  );
  printResult(await publisher.publish({ directory: options.directory, dryRun: true }));
}

async function runLive(options: CliOptions): Promise<void> {
  const config = loadConfig();
  if (!config.templateGcsBucket)
    throw new Error("SITES_TEMPLATE_GCS_BUCKET is required for live publication");
  const persistence = loadPersistenceConfig();
  const mongo = getSharedMongoConnection(persistence.databaseUri);
  const redis = new SharedRedisConnection({ ...(config.redisUrl ? { url: config.redisUrl } : {}) });
  try {
    await connectMongo(mongo);
    const models = createMongoTemplateModels(mongo.connection);
    const templates = new MongoSiteTemplateRepository(models);
    const categories = new MongoSiteCategoryRepository(models);
    const cache = new TemplateCatalogCache(redis, config.redisCacheEnvironment ?? "development");
    const publisher = new TemplatePublisher(
      templates,
      categories,
      new GoogleCloudTemplateArtifactStorage(config.templateGcsBucket),
      cache,
      new TrustedInternalTemplateBuildRunner(),
    );
    printResult(await publisher.publish({ directory: options.directory, dryRun: false }));
  } finally {
    await redis.close();
    await disconnectMongo(mongo);
  }
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.dryRun) await runDryRun(options);
    else await runLive(options);
  } catch (error) {
    const code = error instanceof ApplicationError ? error.code : "TEMPLATE_PUBLISH_FAILED";
    const message = error instanceof Error ? error.message : "Template publication failed";
    console.error(`[sites][templates] ${code}: ${message}`);
    process.exitCode = 1;
  }
}

await main();
