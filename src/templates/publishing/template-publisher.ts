import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  validateSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
} from "../domain/site-template.js";
import type { TemplatePublicationRepository } from "../repositories.js";
import type { TemplateCatalogCache } from "../cache/template-catalog-cache.js";
import type { TemplateArtifactStorage } from "./template-artifact-storage.js";
import type { TemplateBuildRunner } from "./template-build.js";
import {
  PlaywrightTemplateBrowserQA,
  type TemplateBrowserQA,
  type TemplatePreviewName,
} from "./template-browser-qa.js";
import { loadTemplateManifest } from "./template-manifest.js";
import { templateObjectPaths, type TemplateObjectPaths } from "./template-object-paths.js";
import { packageTemplateSource } from "./template-package.js";
import { copyCleanTemplateSource, validateTemplateSource } from "./template-source.js";

export interface TemplateCategoryLookup {
  findCategoryByKey(categoryKey: string): Promise<SiteCategory | undefined>;
}

export interface TemplateCacheInvalidator {
  invalidateTemplateCatalogCache(): Promise<void>;
}

export interface TemplatePublisherLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PublishTemplateInput {
  readonly directory: string;
  readonly dryRun: boolean;
}

export interface TemplatePublicationResult {
  readonly templateKey: string;
  readonly version: number;
  readonly categoryKey: string;
  readonly status: SiteTemplate["status"];
  readonly routeCount: number;
  readonly zipSizeBytes: number;
  readonly sha256: string;
  readonly objects: TemplateObjectPaths;
  readonly buildDurationMs: number;
  readonly browserQA: "PASS";
  readonly routesChecked: number;
  readonly viewportsChecked: number;
  readonly previewByteSizes: Readonly<Record<TemplatePreviewName, number>>;
  readonly dryRun: boolean;
  readonly gcsUpload: "SKIPPED" | "COMPLETED";
  readonly mongoWrite: "SKIPPED" | "COMPLETED";
  readonly redisInvalidation: "SKIPPED" | "COMPLETED" | "WARNING";
  readonly warnings: readonly string[];
}

type PublicationFailureCode = "GCS_UPLOAD_FAILED" | "TEMPLATE_PERSIST_FAILED";

export class TemplatePublisher {
  constructor(
    private readonly templates: TemplatePublicationRepository,
    private readonly categories: TemplateCategoryLookup,
    private readonly storage: TemplateArtifactStorage,
    private readonly cache:
      TemplateCacheInvalidator | Pick<TemplateCatalogCache, "invalidateTemplateCatalogCache">,
    private readonly builder: TemplateBuildRunner,
    private readonly logger: TemplatePublisherLogger = console,
    private readonly browserQA: TemplateBrowserQA = new PlaywrightTemplateBrowserQA(),
  ) {}

  async publish(input: PublishTemplateInput): Promise<TemplatePublicationResult> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sites-template-publisher-"));
    try {
      const manifest = await loadTemplateManifest(input.directory);
      const source = await validateTemplateSource(input.directory);
      const category = await this.categories.findCategoryByKey(manifest.categoryKey);
      if (!category)
        throw new ApplicationError(
          "CATEGORY_NOT_FOUND",
          `Template category '${manifest.categoryKey}' was not found`,
        );
      if (manifest.status === "active" && category.status !== "active")
        throw new ApplicationError(
          "CATEGORY_INACTIVE",
          `Active template requires active category '${manifest.categoryKey}'`,
        );

      const buildDirectory = join(temporaryRoot, "source");
      await mkdir(buildDirectory, { recursive: true });
      await copyCleanTemplateSource(source, buildDirectory);
      this.logger.info(
        `[sites][templates] validating trusted internal template build key=${manifest.templateKey} version=${manifest.version}`,
      );
      const build = await this.builder.build(buildDirectory);
      const qa = await this.browserQA.run({
        buildDirectory,
        routes: manifest.routes.map(({ path }) => path),
        previewDirectory: join(temporaryRoot, "previews"),
      });
      const archive = await packageTemplateSource(source);
      const objects = templateObjectPaths(manifest.templateKey, manifest.version);
      this.logger.info(
        `[sites][templates] prepared key=${manifest.templateKey} version=${manifest.version} buildMs=${build.durationMs} browserQA=PASS routes=${qa.routesChecked} zipBytes=${archive.sizeBytes} sha256=${archive.sha256}`,
      );

      const base = {
        templateKey: manifest.templateKey,
        version: manifest.version,
        categoryKey: manifest.categoryKey,
        status: manifest.status,
        routeCount: manifest.routes.length,
        zipSizeBytes: archive.sizeBytes,
        sha256: archive.sha256,
        objects,
        buildDurationMs: build.durationMs,
        browserQA: "PASS",
        routesChecked: qa.routesChecked,
        viewportsChecked: qa.viewportsChecked,
        previewByteSizes: {
          desktop: qa.previews.desktop.sizeBytes,
          tablet: qa.previews.tablet.sizeBytes,
          mobile: qa.previews.mobile.sizeBytes,
        },
      } as const;
      if (input.dryRun)
        return {
          ...base,
          dryRun: true,
          gcsUpload: "SKIPPED",
          mongoWrite: "SKIPPED",
          redisInvalidation: "SKIPPED",
          warnings: [],
        };

      const now = new Date();
      const template: SiteTemplate = {
        id: randomUUID(),
        templateKey: manifest.templateKey,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        categoryId: category.id,
        tags: manifest.tags,
        status: manifest.status,
        routes: manifest.routes,
        sourceObject: objects.source,
        sourceSha256: archive.sha256,
        previews: {
          desktop: objects.previews.desktop,
          tablet: objects.previews.tablet,
          mobile: objects.previews.mobile,
        },
        createdAt: now,
        updatedAt: now,
      };
      validateSiteTemplate(template);

      if (await this.templates.findTemplateVersion(manifest.templateKey, manifest.version))
        throw new ApplicationError(
          "TEMPLATE_VERSION_EXISTS",
          `Template ${manifest.templateKey} v${manifest.version} already exists`,
        );
      const expectedObjects = [
        objects.source,
        objects.previews.desktop,
        objects.previews.tablet,
        objects.previews.mobile,
      ];
      try {
        for (const object of expectedObjects)
          if (await this.storage.objectExists(object))
            throw new ApplicationError(
              "ARTIFACT_ALREADY_EXISTS",
              `Artifact already exists: ${object}`,
            );
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "ARTIFACT_ALREADY_EXISTS")
          throw error;
        throw new ApplicationError(
          "GCS_UPLOAD_FAILED",
          "Unable to verify template artifact collision state",
          { cause: error },
        );
      }

      const uploaded: string[] = [];
      try {
        await this.#upload(objects.source, archive.bytes, "application/zip", uploaded);
        for (const name of ["desktop", "tablet", "mobile"] as const)
          await this.#upload(
            objects.previews[name],
            new Uint8Array(await readFile(qa.previews[name].path)),
            "image/webp",
            uploaded,
          );
      } catch (error) {
        throw await this.#failureWithCleanup(
          "GCS_UPLOAD_FAILED",
          "Template artifact upload failed",
          error,
          uploaded,
        );
      }

      try {
        await this.templates.createTemplateVersion(template);
      } catch (error) {
        const code: PublicationFailureCode | "TEMPLATE_VERSION_EXISTS" =
          error instanceof ApplicationError && error.code === "TEMPLATE_VERSION_EXISTS"
            ? "TEMPLATE_VERSION_EXISTS"
            : "TEMPLATE_PERSIST_FAILED";
        throw await this.#failureWithCleanup(
          code,
          code === "TEMPLATE_VERSION_EXISTS"
            ? `Template ${manifest.templateKey} v${manifest.version} already exists`
            : "Template metadata persistence failed",
          error,
          uploaded,
        );
      }

      const warnings: string[] = [];
      let redisInvalidation: TemplatePublicationResult["redisInvalidation"] = "COMPLETED";
      try {
        await this.cache.invalidateTemplateCatalogCache();
      } catch {
        const warning = "Template published, but catalog cache invalidation failed";
        warnings.push(warning);
        redisInvalidation = "WARNING";
        this.logger.warn(`[sites][templates] ${warning}`);
      }
      return {
        ...base,
        dryRun: false,
        gcsUpload: "COMPLETED",
        mongoWrite: "COMPLETED",
        redisInvalidation,
        warnings,
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async #upload(
    object: string,
    bytes: Uint8Array,
    contentType: string,
    uploaded: string[],
  ): Promise<void> {
    await this.storage.putObject({ object, bytes, contentType });
    uploaded.push(object);
  }

  async #failureWithCleanup(
    code: PublicationFailureCode | "TEMPLATE_VERSION_EXISTS",
    message: string,
    cause: unknown,
    uploaded: readonly string[],
  ): Promise<ApplicationError> {
    const cleanupFailedObjects: string[] = [];
    for (const object of [...uploaded].reverse()) {
      try {
        await this.storage.deleteObject(object);
      } catch {
        cleanupFailedObjects.push(object);
      }
    }
    return new ApplicationError(code, message, {
      cause,
      metadata: {
        uploadedObjects: [...uploaded],
        cleanupFailedObjects,
        partialPublication: cleanupFailedObjects.length > 0,
      },
    });
  }
}
