import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_QA_VIEWPORTS,
  createBrowserQAReport,
} from "../src/browser-qa/browser-qa-domain.js";
import {
  ApprovedTemplateCatalogPublicationService,
  type StrictTemplateCacheInvalidator,
} from "../src/templates/application/approved-template-catalog-publication.js";
import {
  APPROVED_TEMPLATE_CATEGORIES,
  APPROVED_TEMPLATE_KEYS,
} from "../src/templates/application/approved-template-catalog-registration.js";
import {
  toPublicSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
} from "../src/templates/domain/site-template.js";
import type { TemplateActivationRepository } from "../src/templates/repositories.js";
import type {
  ComparableTemplateArtifactStorage,
  TemplateArtifactWrite,
} from "../src/templates/publishing/template-artifact-storage.js";
import type {
  TemplateBrowserQA,
  TemplateBrowserQAInput,
  TemplateBrowserQAResult,
} from "../src/templates/publishing/template-browser-qa.js";
import type {
  TemplateBuildResult,
  TemplateBuildRunner,
} from "../src/templates/publishing/template-build.js";
import { loadTemplateManifest } from "../src/templates/publishing/template-manifest.js";
import { templateObjectPaths } from "../src/templates/publishing/template-object-paths.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";

const templatesRoot = resolve("templates");
const previewBytes = {
  desktop: new Uint8Array([82, 73, 70, 70, 1, 100]),
  tablet: new Uint8Array([82, 73, 70, 70, 2, 116]),
  mobile: new Uint8Array([82, 73, 70, 70, 3, 109]),
} as const;

class MemoryStorage implements ComparableTemplateArtifactStorage {
  readonly bucketName = "bucket-chatbot-ni";
  readonly objects = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  overwriteAttempts = 0;
  failObject: string | undefined;

  readObject(object: string): Promise<Uint8Array | undefined> {
    const value = this.objects.get(object);
    return Promise.resolve(value ? new Uint8Array(value) : undefined);
  }

  putObject(write: TemplateArtifactWrite): Promise<void> {
    if (this.failObject === write.object) return Promise.reject(new Error("upload failed"));
    if (this.objects.has(write.object)) {
      this.overwriteAttempts++;
      return Promise.reject(new Error("create-only precondition failed"));
    }
    this.writes.push(write.object);
    this.objects.set(write.object, new Uint8Array(write.bytes));
    return Promise.resolve();
  }

  deleteObject(object: string): Promise<void> {
    this.deletes.push(object);
    return Promise.resolve();
  }
}

class MemoryTemplates implements TemplateActivationRepository {
  readonly values = new Map<string, SiteTemplate>();
  activations = 0;
  creations = 0;
  beforeActivation: (() => void) | undefined;

  findTemplateVersion(templateKey: string, version: number): Promise<SiteTemplate | undefined> {
    return Promise.resolve(this.values.get(`${templateKey}:${version}`));
  }

  activateTemplateVersion(template: SiteTemplate): Promise<SiteTemplate> {
    this.beforeActivation?.();
    this.activations++;
    this.values.set(`${template.templateKey}:${template.version}`, template);
    return Promise.resolve(template);
  }
}

class PassingBuilder implements TemplateBuildRunner {
  build(): Promise<TemplateBuildResult> {
    return Promise.resolve({ durationMs: 1, packageManager: "npm" });
  }
}

class PassingQA implements TemplateBrowserQA {
  async run(input: TemplateBrowserQAInput): Promise<TemplateBrowserQAResult> {
    await mkdir(input.previewDirectory, { recursive: true });
    await Promise.all(
      (Object.keys(previewBytes) as (keyof typeof previewBytes)[]).map((name) =>
        writeFile(resolve(input.previewDirectory, `${name}.webp`), previewBytes[name]),
      ),
    );
    return {
      passed: true,
      routesChecked: input.routes.length,
      viewportsChecked: input.routes.length * 3,
      report: createBrowserQAReport({
        runId: "phase-4b-test",
        browser: { name: "chromium" },
        viewports: BROWSER_QA_VIEWPORTS,
        routes: input.routes,
        checks: [],
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 1,
      }),
      previews: {
        desktop: {
          path: resolve(input.previewDirectory, "desktop.webp"),
          sizeBytes: previewBytes.desktop.byteLength,
        },
        tablet: {
          path: resolve(input.previewDirectory, "tablet.webp"),
          sizeBytes: previewBytes.tablet.byteLength,
        },
        mobile: {
          path: resolve(input.previewDirectory, "mobile.webp"),
          sizeBytes: previewBytes.mobile.byteLength,
        },
      },
    };
  }
}

class CountingCache implements StrictTemplateCacheInvalidator {
  invalidations = 0;
  invalidateTemplateCatalogCache(): Promise<void> {
    this.invalidations++;
    return Promise.resolve();
  }
}

interface Harness {
  readonly templates: MemoryTemplates;
  readonly storage: MemoryStorage;
  readonly cache: CountingCache;
  readonly publisher: ApprovedTemplateCatalogPublicationService;
}

async function harness(): Promise<Harness> {
  const categories = new Map<string, SiteCategory>();
  const templates = new MemoryTemplates();
  const now = new Date(0);
  for (const definition of APPROVED_TEMPLATE_CATEGORIES)
    categories.set(definition.categoryKey, {
      id: `category:${definition.categoryKey}`,
      ...definition,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  for (const templateKey of APPROVED_TEMPLATE_KEYS) {
    const manifest = await loadTemplateManifest(resolve(templatesRoot, templateKey));
    templates.values.set(`${templateKey}:1`, {
      id: `template:${templateKey}`,
      templateKey,
      version: 1,
      name: manifest.name,
      description: manifest.description,
      categoryId: `category:${manifest.categoryKey}`,
      tags: [...manifest.tags],
      status: "draft",
      routes: manifest.routes.map((route) => ({ ...route })),
      previews: {},
      createdAt: now,
      updatedAt: now,
    });
  }
  const storage = new MemoryStorage();
  const cache = new CountingCache();
  return {
    templates,
    storage,
    cache,
    publisher: new ApprovedTemplateCatalogPublicationService(
      templates,
      { findCategoryByKey: (key) => Promise.resolve(categories.get(key)) },
      storage,
      cache,
      new PassingBuilder(),
      { info: () => undefined },
      new PassingQA(),
    ),
  };
}

async function sourceBytes(templateKey: string): Promise<Uint8Array> {
  const source = await validateTemplateSource(resolve(templatesRoot, templateKey));
  return (await packageTemplateSource(source)).bytes;
}

describe("Phase 4B approved template publication", () => {
  it("uploads source artifacts with create-only writes", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.storage.writes.filter((path) => path.endsWith("template.zip"))).toHaveLength(8);
    expect(h.storage.overwriteAttempts).toBe(0);
  });

  it("uploads preview artifacts with create-only writes", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.storage.writes.filter((path) => path.endsWith(".webp"))).toHaveLength(24);
  });

  it("accepts a matching existing source", async () => {
    const h = await harness();
    const object = templateObjectPaths("modern-saas", 1).source;
    h.storage.objects.set(object, await sourceBytes("modern-saas"));
    const result = await h.publisher.publishAll(templatesRoot);
    expect(result.templates[0]?.source).toBe("MATCHED");
  });

  it("rejects a conflicting existing source", async () => {
    const h = await harness();
    h.storage.objects.set(templateObjectPaths("modern-saas", 1).source, new Uint8Array([1]));
    await expect(h.publisher.publishAll(templatesRoot)).rejects.toMatchObject({
      code: "GCS_ARTIFACT_CONFLICT",
    });
  });

  it("accepts a matching existing preview", async () => {
    const h = await harness();
    h.storage.objects.set(
      templateObjectPaths("modern-saas", 1).previews.desktop,
      previewBytes.desktop,
    );
    const result = await h.publisher.publishAll(templatesRoot);
    expect(result.templates[0]?.desktop).toBe("MATCHED");
  });

  it("rejects a conflicting existing preview", async () => {
    const h = await harness();
    h.storage.objects.set(
      templateObjectPaths("modern-saas", 1).previews.desktop,
      new Uint8Array([9]),
    );
    await expect(h.publisher.publishAll(templatesRoot)).rejects.toMatchObject({
      code: "GCS_ARTIFACT_CONFLICT",
    });
  });

  it("leaves the template draft after a partial upload", async () => {
    const h = await harness();
    h.storage.failObject = templateObjectPaths("modern-saas", 1).previews.desktop;
    await expect(h.publisher.publishAll(templatesRoot)).rejects.toMatchObject({
      code: "GCS_UPLOAD_FAILED",
    });
    expect(h.templates.values.get("modern-saas:1")?.status).toBe("draft");
    expect(h.storage.objects.has(templateObjectPaths("modern-saas", 1).source)).toBe(true);
  });

  it("activates Mongo only after all four artifacts exist", async () => {
    const h = await harness();
    const paths = templateObjectPaths("modern-saas", 1);
    h.templates.beforeActivation = () => {
      expect(
        [paths.source, ...Object.values(paths.previews)].every((path) =>
          h.storage.objects.has(path),
        ),
      ).toBe(true);
      h.templates.beforeActivation = undefined;
    };
    await h.publisher.publishAll(templatesRoot);
  });

  it("stores sourceObject", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.templates.values.get("modern-saas:1")?.sourceObject).toBe(
      templateObjectPaths("modern-saas", 1).source,
    );
  });

  it("stores sourceSha256", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.templates.values.get("modern-saas:1")?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores all preview object paths", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.templates.values.get("modern-saas:1")?.previews).toEqual(
      templateObjectPaths("modern-saas", 1).previews,
    );
  });

  it("changes all records to active", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect([...h.templates.values.values()].every((template) => template.status === "active")).toBe(
      true,
    );
  });

  it("does not create duplicate Mongo records", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.templates.values).toHaveLength(8);
    expect(h.templates.creations).toBe(0);
  });

  it("hides source metadata from public serialization", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    const value = toPublicSiteTemplate(
      h.templates.values.get("modern-saas:1")!,
      "bucket-chatbot-ni",
    ) as unknown as Record<string, unknown>;
    expect(value).not.toHaveProperty("sourceObject");
    expect(value).not.toHaveProperty("sourceSha256");
  });

  it("resolves public preview URLs from bucket and object paths", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    const value = toPublicSiteTemplate(
      h.templates.values.get("modern-saas:1")!,
      "bucket-chatbot-ni",
    );
    expect(value.previews.desktop).toBe(
      "https://storage.googleapis.com/bucket-chatbot-ni/sites/templates/modern-saas/v1/previews/desktop.webp",
    );
  });

  it("invalidates the catalog cache once per batch", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    expect(h.cache.invalidations).toBe(1);
  });

  it("contains no billing or quota mutation path", async () => {
    const source = await readFile(
      resolve("src/templates/application/approved-template-catalog-publication.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/billing|userCreditQuota|subscriberQuota/);
  });

  it("is idempotent on a second run", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    const activations = h.templates.activations;
    const result = await h.publisher.publishAll(templatesRoot);
    expect(result.uploadsCreated).toBe(0);
    expect(result.matchingExistingObjects).toBe(32);
    expect(h.templates.activations).toBe(activations);
  });

  it("never attempts delete-based rollback", async () => {
    const h = await harness();
    h.storage.failObject = templateObjectPaths("modern-saas", 1).previews.desktop;
    await expect(h.publisher.publishAll(templatesRoot)).rejects.toBeTruthy();
    expect(h.storage.deletes).toEqual([]);
  });

  it("never attempts to overwrite matching artifacts", async () => {
    const h = await harness();
    await h.publisher.publishAll(templatesRoot);
    await h.publisher.publishAll(templatesRoot);
    expect(h.storage.overwriteAttempts).toBe(0);
  });
});
