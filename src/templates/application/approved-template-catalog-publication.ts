import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { validateSiteTemplate, type SiteCategory, type SiteTemplate } from "../domain/site-template.js";
import type { TemplateActivationRepository } from "../repositories.js";
import type { ComparableTemplateArtifactStorage } from "../publishing/template-artifact-storage.js";
import type { TemplateBrowserQA, TemplatePreviewName } from "../publishing/template-browser-qa.js";
import { PlaywrightTemplateBrowserQA } from "../publishing/template-browser-qa.js";
import type { TemplateBuildRunner } from "../publishing/template-build.js";
import { loadTemplateManifest, type TemplateManifest } from "../publishing/template-manifest.js";
import { templateObjectPaths, type TemplateObjectPaths } from "../publishing/template-object-paths.js";
import { packageTemplateSource } from "../publishing/template-package.js";
import { copyCleanTemplateSource, validateTemplateSource } from "../publishing/template-source.js";
import {
  APPROVED_TEMPLATE_KEYS,
  EXPECTED_CATEGORY_BY_TEMPLATE,
} from "./approved-template-catalog-registration.js";

export type ArtifactPublicationState = "CREATED" | "MATCHED";

export interface ApprovedTemplatePublicationSummary {
  readonly templateKey: string;
  readonly build: "PASS";
  readonly qa: "PASS";
  readonly routesChecked: number;
  readonly viewportsChecked: number;
  readonly source: ArtifactPublicationState;
  readonly desktop: ArtifactPublicationState;
  readonly tablet: ArtifactPublicationState;
  readonly mobile: ArtifactPublicationState;
  readonly mongo: "ACTIVATED" | "EXISTING";
  readonly status: "active";
  readonly sourceSha256: string;
}

export interface ApprovedCatalogPublicationResult {
  readonly templates: readonly ApprovedTemplatePublicationSummary[];
  readonly uploadsCreated: number;
  readonly matchingExistingObjects: number;
  readonly conflicts: 0;
  readonly cacheInvalidated: true;
}

export interface ApprovedTemplateCategoryLookup {
  findCategoryByKey(categoryKey: string): Promise<SiteCategory | undefined>;
}

export interface StrictTemplateCacheInvalidator {
  invalidateTemplateCatalogCache(): Promise<void>;
}

export interface ApprovedTemplatePublicationLogger {
  info(message: string): void;
}

interface PreparedTemplate {
  readonly directory: string;
  readonly manifest: TemplateManifest;
  readonly category: SiteCategory;
  readonly existing: SiteTemplate;
}

interface ArtifactInput {
  readonly object: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const arraysMatch = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const routesMatch = (left: SiteTemplate["routes"], right: TemplateManifest["routes"]): boolean =>
  left.length === right.length &&
  left.every(
    (route, index) => route.path === right[index]?.path && route.label === right[index]?.label,
  );

function immutableMetadataMatches(
  existing: SiteTemplate,
  manifest: TemplateManifest,
  categoryId: string,
): boolean {
  return (
    existing.templateKey === manifest.templateKey &&
    existing.version === manifest.version &&
    existing.name === manifest.name &&
    existing.description === manifest.description &&
    existing.categoryId === categoryId &&
    arraysMatch(existing.tags, manifest.tags) &&
    routesMatch(existing.routes, manifest.routes)
  );
}

function artifactMetadataMatches(
  template: SiteTemplate,
  objects: TemplateObjectPaths,
  sourceSha256: string,
): boolean {
  return (
    template.status === "active" &&
    template.sourceObject === objects.source &&
    template.sourceSha256 === sourceSha256 &&
    template.previews.desktop === objects.previews.desktop &&
    template.previews.tablet === objects.previews.tablet &&
    template.previews.mobile === objects.previews.mobile
  );
}

function draftIsClean(template: SiteTemplate): boolean {
  return (
    template.status === "draft" &&
    template.sourceObject === undefined &&
    template.sourceSha256 === undefined &&
    Object.keys(template.previews).length === 0
  );
}

export class ApprovedTemplateCatalogPublicationService {
  constructor(
    private readonly templates: TemplateActivationRepository,
    private readonly categories: ApprovedTemplateCategoryLookup,
    private readonly storage: ComparableTemplateArtifactStorage,
    private readonly cache: StrictTemplateCacheInvalidator,
    private readonly builder: TemplateBuildRunner,
    private readonly logger: ApprovedTemplatePublicationLogger = console,
    private readonly browserQA: TemplateBrowserQA = new PlaywrightTemplateBrowserQA(),
  ) {}

  async publishAll(templatesRoot: string): Promise<ApprovedCatalogPublicationResult> {
    const prepared = await this.#preflight(templatesRoot);
    const summaries: ApprovedTemplatePublicationSummary[] = [];
    let uploadsCreated = 0;
    let matchingExistingObjects = 0;

    for (const item of prepared) {
      const summary = await this.#publishOne(item);
      summaries.push(summary);
      for (const state of [
        summary.source,
        summary.desktop,
        summary.tablet,
        summary.mobile,
      ]) {
        if (state === "CREATED") uploadsCreated++;
        else matchingExistingObjects++;
      }
    }

    await this.cache.invalidateTemplateCatalogCache();
    return {
      templates: summaries,
      uploadsCreated,
      matchingExistingObjects,
      conflicts: 0,
      cacheInvalidated: true,
    };
  }

  async #preflight(templatesRoot: string): Promise<readonly PreparedTemplate[]> {
    const prepared: PreparedTemplate[] = [];
    for (const templateKey of APPROVED_TEMPLATE_KEYS) {
      const directory = join(templatesRoot, templateKey);
      const manifest = await loadTemplateManifest(directory);
      if (
        manifest.templateKey !== templateKey ||
        manifest.version !== 1 ||
        manifest.status !== "draft" ||
        manifest.categoryKey !== EXPECTED_CATEGORY_BY_TEMPLATE[templateKey]
      )
        throw new ApplicationError(
          "APPROVED_TEMPLATE_MANIFEST_INVALID",
          `Approved manifest ${templateKey} does not match the frozen publication contract`,
        );
      const category = await this.categories.findCategoryByKey(manifest.categoryKey);
      if (!category)
        throw new ApplicationError(
          "CATEGORY_NOT_FOUND",
          `Template category '${manifest.categoryKey}' was not found`,
        );
      if (category.status !== "active")
        throw new ApplicationError(
          "CATEGORY_INACTIVE",
          `Template category '${manifest.categoryKey}' is not active`,
        );
      const existing = await this.templates.findTemplateVersion(templateKey, 1);
      if (!existing)
        throw new ApplicationError(
          "TEMPLATE_NOT_FOUND",
          `Existing draft template ${templateKey} v1 was not found`,
        );
      if (!immutableMetadataMatches(existing, manifest, category.id))
        throw new ApplicationError(
          "TEMPLATE_METADATA_CONFLICT",
          `Template ${templateKey} v1 conflicts with approved metadata`,
        );
      if (existing.status !== "active" && !draftIsClean(existing))
        throw new ApplicationError(
          "TEMPLATE_METADATA_CONFLICT",
          `Template ${templateKey} v1 is not a clean draft or active publication`,
        );
      prepared.push({ directory, manifest, category, existing });
    }
    return prepared;
  }

  async #publishOne(item: PreparedTemplate): Promise<ApprovedTemplatePublicationSummary> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sites-approved-template-"));
    try {
      const source = await validateTemplateSource(item.directory);
      const buildDirectory = join(temporaryRoot, "source");
      await mkdir(buildDirectory, { recursive: true });
      await copyCleanTemplateSource(source, buildDirectory);
      this.logger.info(`[sites][templates] building approved template ${item.manifest.templateKey}`);
      await this.builder.build(buildDirectory);
      const qa = await this.browserQA.run({
        buildDirectory,
        routes: item.manifest.routes.map((route) => route.path),
        previewDirectory: join(temporaryRoot, "previews"),
      });
      const archive = await packageTemplateSource(source);
      const objects = templateObjectPaths(item.manifest.templateKey, item.manifest.version);
      const previewBytes = Object.fromEntries(
        await Promise.all(
          (["desktop", "tablet", "mobile"] as const).map(async (name) => [
            name,
            new Uint8Array(await readFile(qa.previews[name].path)),
          ]),
        ),
      ) as Readonly<Record<TemplatePreviewName, Uint8Array>>;
      const states = {
        source: await this.#ensureArtifact({
          object: objects.source,
          bytes: archive.bytes,
          contentType: "application/zip",
        }),
        desktop: await this.#ensureArtifact({
          object: objects.previews.desktop,
          bytes: previewBytes.desktop,
          contentType: "image/webp",
        }),
        tablet: await this.#ensureArtifact({
          object: objects.previews.tablet,
          bytes: previewBytes.tablet,
          contentType: "image/webp",
        }),
        mobile: await this.#ensureArtifact({
          object: objects.previews.mobile,
          bytes: previewBytes.mobile,
          contentType: "image/webp",
        }),
      } as const;

      const current = await this.templates.findTemplateVersion(
        item.manifest.templateKey,
        item.manifest.version,
      );
      if (!current)
        throw new ApplicationError("TEMPLATE_NOT_FOUND", "Template disappeared during publication");
      let mongo: ApprovedTemplatePublicationSummary["mongo"];
      if (artifactMetadataMatches(current, objects, archive.sha256)) mongo = "EXISTING";
      else {
        if (!draftIsClean(current))
          throw new ApplicationError(
            "TEMPLATE_METADATA_CONFLICT",
            `Template ${item.manifest.templateKey} changed during publication`,
          );
        const target: SiteTemplate = {
          ...current,
          status: "active",
          sourceObject: objects.source,
          sourceSha256: archive.sha256,
          previews: { ...objects.previews },
          updatedAt: new Date(),
        };
        validateSiteTemplate(target);
        const activated = await this.templates.activateTemplateVersion(target);
        if (!artifactMetadataMatches(activated, objects, archive.sha256))
          throw new ApplicationError(
            "TEMPLATE_PERSIST_FAILED",
            `Template ${item.manifest.templateKey} activation readback failed`,
          );
        mongo = "ACTIVATED";
      }

      return {
        templateKey: item.manifest.templateKey,
        build: "PASS",
        qa: "PASS",
        routesChecked: qa.routesChecked,
        viewportsChecked: qa.viewportsChecked,
        ...states,
        mongo,
        status: "active",
        sourceSha256: archive.sha256,
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async #ensureArtifact(input: ArtifactInput): Promise<ArtifactPublicationState> {
    const expectedSha256 = digest(input.bytes);
    const read = async (): Promise<Uint8Array | undefined> => {
      try {
        return await this.storage.readObject(input.object);
      } catch (error) {
        throw new ApplicationError("GCS_UPLOAD_FAILED", "Unable to read template artifact", {
          cause: error,
        });
      }
    };
    const existing = await read();
    if (existing) {
      if (digest(existing) === expectedSha256) return "MATCHED";
      throw new ApplicationError(
        "GCS_ARTIFACT_CONFLICT",
        `Existing artifact differs: ${input.object}`,
      );
    }
    try {
      await this.storage.putObject(input);
    } catch (error) {
      const raced = await read();
      if (raced && digest(raced) === expectedSha256) return "MATCHED";
      if (raced)
        throw new ApplicationError(
          "GCS_ARTIFACT_CONFLICT",
          `Existing artifact differs: ${input.object}`,
          { cause: error },
        );
      throw new ApplicationError("GCS_UPLOAD_FAILED", "Template artifact upload failed", {
        cause: error,
      });
    }
    const confirmed = await read();
    if (!confirmed || digest(confirmed) !== expectedSha256)
      throw new ApplicationError(
        "GCS_UPLOAD_FAILED",
        `Uploaded artifact could not be verified: ${input.object}`,
      );
    return "CREATED";
  }
}
