import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/app/config/environment.js";
import {
  toPublicSiteTemplate,
  validateSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
} from "../src/templates/domain/site-template.js";
import type { TemplatePublicationRepository } from "../src/templates/repositories.js";
import type {
  TemplateArtifactStorage,
  TemplateArtifactWrite,
} from "../src/templates/publishing/template-artifact-storage.js";
import type { BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import type {
  TemplateBrowserQA,
  TemplateBrowserQAInput,
  TemplateBrowserQAResult,
} from "../src/templates/publishing/template-browser-qa.js";
import {
  TrustedInternalTemplateBuildRunner,
  type TemplateBuildRunner,
} from "../src/templates/publishing/template-build.js";
import {
  loadTemplateManifest,
  parseTemplateManifest,
} from "../src/templates/publishing/template-manifest.js";
import { templateObjectPaths } from "../src/templates/publishing/template-object-paths.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import {
  TemplatePublisher,
  type TemplateCacheInvalidator,
  type TemplateCategoryLookup,
} from "../src/templates/publishing/template-publisher.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";

const fixture = resolve("tests/fixtures/template-publisher-valid");
const temporaryRoots: string[] = [];
let templateDirectory: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "sites-template-t2a-test-"));
  temporaryRoots.push(root);
  templateDirectory = join(root, "template");
  await cp(fixture, templateDirectory, { recursive: true });
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function updateManifest(update: (value: Record<string, unknown>) => void): Promise<void> {
  const path = join(templateDirectory, "site-template.json");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  update(value);
  await writeFile(path, JSON.stringify(value, null, 2));
}

const category = (status: SiteCategory["status"] = "active"): SiteCategory => ({
  id: "category-saas",
  categoryKey: "saas",
  name: "SaaS",
  description: "SaaS templates",
  status,
  sortOrder: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

class FakeTemplates implements TemplatePublicationRepository {
  existing: SiteTemplate | undefined;
  created: SiteTemplate | undefined;
  failCreate = false;
  constructor(private readonly events: string[]) {}
  findTemplateVersion(): Promise<SiteTemplate | undefined> {
    this.events.push("version-check");
    return Promise.resolve(this.existing);
  }
  createTemplateVersion(template: SiteTemplate): Promise<SiteTemplate> {
    this.events.push("persist");
    if (this.failCreate) return Promise.reject(new Error("mongo failed"));
    this.created = template;
    return Promise.resolve(template);
  }
}

class FakeCategories implements TemplateCategoryLookup {
  value: SiteCategory | undefined = category();
  constructor(private readonly events: string[]) {}
  findCategoryByKey(): Promise<SiteCategory | undefined> {
    this.events.push("category");
    return Promise.resolve(this.value);
  }
}

class FakeStorage implements TemplateArtifactStorage {
  readonly bucketName = "template-bucket";
  readonly existing = new Set<string>();
  readonly writes: TemplateArtifactWrite[] = [];
  readonly deletes: string[] = [];
  failPutObject: string | undefined;
  failDeleteObject: string | undefined;
  constructor(private readonly events: string[]) {}
  objectExists(object: string): Promise<boolean> {
    this.events.push(`exists:${object}`);
    return Promise.resolve(this.existing.has(object));
  }
  putObject(write: TemplateArtifactWrite): Promise<void> {
    this.events.push(`put:${write.object}`);
    if (write.object === this.failPutObject) return Promise.reject(new Error("gcs failed"));
    this.writes.push(write);
    return Promise.resolve();
  }
  deleteObject(object: string): Promise<void> {
    this.events.push(`delete:${object}`);
    this.deletes.push(object);
    if (object === this.failDeleteObject) return Promise.reject(new Error("cleanup failed"));
    return Promise.resolve();
  }
}

class FakeCache implements TemplateCacheInvalidator {
  calls = 0;
  constructor(private readonly events: string[]) {}
  invalidateTemplateCatalogCache(): Promise<void> {
    this.events.push("invalidate");
    this.calls++;
    return Promise.resolve();
  }
}

class FakeBuilder implements TemplateBuildRunner {
  calls = 0;
  constructor(private readonly events: string[]) {}
  build(): Promise<{ durationMs: number; packageManager: "npm" }> {
    this.events.push("build");
    this.calls++;
    return Promise.resolve({ durationMs: 12, packageManager: "npm" });
  }
}

class FakeTemplateBrowserQA implements TemplateBrowserQA {
  calls = 0;
  constructor(private readonly events: string[]) {}
  async run(input: TemplateBrowserQAInput): Promise<TemplateBrowserQAResult> {
    this.events.push("qa");
    this.calls++;
    await mkdir(input.previewDirectory, { recursive: true });
    const previews = {} as Record<
      "desktop" | "tablet" | "mobile",
      { path: string; sizeBytes: number }
    >;
    for (const name of ["desktop", "tablet", "mobile"] as const) {
      const path = join(input.previewDirectory, `${name}.webp`);
      const bytes = Buffer.from("RIFFxxxxWEBPpreview");
      await writeFile(path, bytes);
      previews[name] = { path, sizeBytes: bytes.byteLength };
    }
    return {
      passed: true,
      routesChecked: input.routes.length,
      viewportsChecked: 3,
      report: {} as BrowserQAReport,
      previews,
    };
  }
}

function harness() {
  const events: string[] = [];
  const templates = new FakeTemplates(events);
  const categories = new FakeCategories(events);
  const storage = new FakeStorage(events);
  const cache = new FakeCache(events);
  const builder = new FakeBuilder(events);
  const browserQA = new FakeTemplateBrowserQA(events);
  const publisher = new TemplatePublisher(
    templates,
    categories,
    storage,
    cache,
    builder,
    { info: () => undefined, warn: () => undefined },
    browserQA,
  );
  return { events, templates, categories, storage, cache, builder, browserQA, publisher };
}

describe("T2A manifest contract", () => {
  it("loads the template bucket through centralized Sites configuration", () => {
    expect(
      loadConfig({ NODE_ENV: "test", SITES_TEMPLATE_GCS_BUCKET: " template-bucket " })
        .templateGcsBucket,
    ).toBe("template-bucket");
  });

  it("loads a valid manifest", async () => {
    await expect(loadTemplateManifest(templateDirectory)).resolves.toMatchObject({
      templateKey: "publisher-fixture",
      categoryKey: "saas",
      version: 1,
    });
  });

  it("rejects an invalid templateKey through the frozen T1 validation", () => {
    expect(() =>
      parseTemplateManifest({
        templateKey: "Not Safe",
        version: 1,
        name: "Name",
        description: "Description",
        categoryKey: "saas",
        tags: [],
        status: "draft",
        routes: [{ path: "/", label: "Home" }],
      }),
    ).toThrow("templateKey must be lowercase and URL-safe");
  });

  it("rejects duplicate routes through the frozen T1 validation", async () => {
    await updateManifest((value) => {
      value.routes = [
        { path: "/", label: "Home" },
        { path: "/", label: "Duplicate" },
      ];
    });
    await expect(loadTemplateManifest(templateDirectory)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
  });

  it.each([
    "sourceArtifact",
    "sourceObject",
    "sourceSha256",
    "previews",
    "bucket",
    "gcsPath",
    "credentials",
    "createdAt",
    "_id",
  ])("rejects infrastructure-owned field %s", async (field) => {
    await updateManifest((value) => {
      value[field] = "forbidden";
    });
    await expect(loadTemplateManifest(templateDirectory)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
  });
});

describe("T2A source and preview safety", () => {
  it("rejects a missing package.json", async () => {
    await rm(join(templateDirectory, "package.json"));
    await expect(validateTemplateSource(templateDirectory)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
  });

  it("rejects a missing src directory", async () => {
    await rm(join(templateDirectory, "src"), { recursive: true });
    await expect(validateTemplateSource(templateDirectory)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
  });

  it.each([".env", ".env.local", ".env.production"])("rejects private file %s", async (name) => {
    await writeFile(join(templateDirectory, name), "SECRET=value");
    await expect(validateTemplateSource(templateDirectory)).rejects.toMatchObject({
      code: "UNSAFE_TEMPLATE_SOURCE",
    });
  });

  it.each(["service-account.json", "service-account-prod.json", "credentials.json"])(
    "rejects credential file %s",
    async (name) => {
      await writeFile(join(templateDirectory, name), "{}");
      await expect(validateTemplateSource(templateDirectory)).rejects.toMatchObject({
        code: "UNSAFE_TEMPLATE_SOURCE",
      });
    },
  );

  it.each(["private.pem", "signing.key"])("rejects key material %s", async (name) => {
    await writeFile(join(templateDirectory, name), "private");
    await expect(validateTemplateSource(templateDirectory)).rejects.toMatchObject({
      code: "UNSAFE_TEMPLATE_SOURCE",
    });
  });

  it("rejects symbolic links", async () => {
    await symlink(
      resolve(templateDirectory, "src"),
      join(templateDirectory, "linked-src"),
      "junction",
    );
    await expect(validateTemplateSource(templateDirectory)).rejects.toMatchObject({
      code: "UNSAFE_TEMPLATE_SOURCE",
    });
  });

  it("excludes node_modules from packaged files", async () => {
    await mkdir(join(templateDirectory, "node_modules", "unsafe"), { recursive: true });
    await writeFile(join(templateDirectory, "node_modules", "unsafe", "index.js"), "ignored");
    const source = await validateTemplateSource(templateDirectory);
    expect(source.packageFiles.some((path) => path.startsWith("node_modules/"))).toBe(false);
  });

  it("excludes dist, build, coverage, git, and previews from packaged source", async () => {
    for (const name of ["dist", "build", "coverage", ".git"]) {
      await mkdir(join(templateDirectory, name), { recursive: true });
      await writeFile(join(templateDirectory, name, "ignored.txt"), "ignored");
    }
    const source = await validateTemplateSource(templateDirectory);
    expect(source.packageFiles).not.toEqual(
      expect.arrayContaining([
        "dist/ignored.txt",
        "build/ignored.txt",
        "coverage/ignored.txt",
        ".git/ignored.txt",
        "previews/desktop.webp",
      ]),
    );
  });

  it.each(["desktop", "tablet", "mobile"])(
    "does not validate author-supplied %s.webp",
    async (name) => {
      await mkdir(join(templateDirectory, "previews"), { recursive: true });
      await writeFile(join(templateDirectory, "previews", `${name}.webp`), "");
      await expect(validateTemplateSource(templateDirectory)).resolves.toBeDefined();
    },
  );

  it("does not require a previews directory", async () => {
    await rm(join(templateDirectory, "previews"), { recursive: true, force: true });
    await expect(validateTemplateSource(templateDirectory)).resolves.toBeDefined();
  });
});

describe("T2A object layout and ZIP", () => {
  it("creates deterministic GCS object paths", () => {
    expect(templateObjectPaths("modern-saas", 3)).toEqual({
      source: "sites/templates/modern-saas/v3/source/template.zip",
      previews: {
        desktop: "sites/templates/modern-saas/v3/previews/desktop.webp",
        tablet: "sites/templates/modern-saas/v3/previews/tablet.webp",
        mobile: "sites/templates/modern-saas/v3/previews/mobile.webp",
      },
    });
  });

  it("creates a readable source ZIP", async () => {
    const archive = await packageTemplateSource(await validateTemplateSource(templateDirectory));
    expect(Object.keys(unzipSync(archive.bytes))).toContain("site-template.json");
  });

  it("uses only relative non-traversing ZIP paths", async () => {
    const archive = await packageTemplateSource(await validateTemplateSource(templateDirectory));
    expect(
      archive.entries.every(
        (name) => !name.match(/^[A-Za-z]:/) && !name.startsWith("/") && !name.includes(".."),
      ),
    ).toBe(true);
  });

  it("calculates SHA-256 from the exact ZIP bytes", async () => {
    const archive = await packageTemplateSource(await validateTemplateSource(templateDirectory));
    expect(archive.sha256).toBe(createHash("sha256").update(archive.bytes).digest("hex"));
  });

  it("records the exact ZIP byte size", async () => {
    const archive = await packageTemplateSource(await validateTemplateSource(templateDirectory));
    expect(archive.sizeBytes).toBe(archive.bytes.byteLength);
    expect(archive.sizeBytes).toBeGreaterThan(0);
  });

  it("produces deterministic ZIP bytes for unchanged source", async () => {
    const source = await validateTemplateSource(templateDirectory);
    const first = await packageTemplateSource(source);
    const second = await packageTemplateSource(source);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toEqual(first.bytes);
  });
});

describe("T2A publisher orchestration", () => {
  it("dry-run performs build and packaging without GCS upload", async () => {
    const h = harness();
    const result = await h.publisher.publish({ directory: templateDirectory, dryRun: true });
    expect(result.gcsUpload).toBe("SKIPPED");
    expect(h.builder.calls).toBe(1);
    expect(h.storage.writes).toHaveLength(0);
  });

  it("dry-run does not read or write template versions in Mongo", async () => {
    const h = harness();
    await h.publisher.publish({ directory: templateDirectory, dryRun: true });
    expect(h.events).not.toContain("version-check");
    expect(h.events).not.toContain("persist");
  });

  it("dry-run does not invalidate Redis", async () => {
    const h = harness();
    await h.publisher.publish({ directory: templateDirectory, dryRun: true });
    expect(h.cache.calls).toBe(0);
  });

  it("rejects a missing category", async () => {
    const h = harness();
    h.categories.value = undefined;
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "CATEGORY_NOT_FOUND",
    });
  });

  it("rejects an active template assigned to an inactive category", async () => {
    await updateManifest((value) => {
      value.status = "active";
    });
    const h = harness();
    h.categories.value = category("archived");
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "CATEGORY_INACTIVE",
    });
  });

  it("rejects an existing immutable template version before GCS checks", async () => {
    const h = harness();
    h.templates.existing = {} as SiteTemplate;
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "TEMPLATE_VERSION_EXISTS",
    });
    expect(h.events.some((event) => event.startsWith("exists:"))).toBe(false);
  });

  it("rejects any planned artifact collision before upload", async () => {
    const h = harness();
    h.storage.existing.add("sites/templates/publisher-fixture/v1/previews/tablet.webp");
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_ALREADY_EXISTS",
    });
    expect(h.storage.writes).toHaveLength(0);
  });

  it("uploads source then previews, persists, and invalidates in order", async () => {
    const h = harness();
    await h.publisher.publish({ directory: templateDirectory, dryRun: false });
    const selected = h.events.filter(
      (event) => event.startsWith("put:") || event === "persist" || event === "invalidate",
    );
    expect(selected).toEqual([
      "put:sites/templates/publisher-fixture/v1/source/template.zip",
      "put:sites/templates/publisher-fixture/v1/previews/desktop.webp",
      "put:sites/templates/publisher-fixture/v1/previews/tablet.webp",
      "put:sites/templates/publisher-fixture/v1/previews/mobile.webp",
      "persist",
      "invalidate",
    ]);
  });

  it("prevents Mongo persistence when a GCS upload fails", async () => {
    const h = harness();
    h.storage.failPutObject = "sites/templates/publisher-fixture/v1/previews/desktop.webp";
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "GCS_UPLOAD_FAILED",
    });
    expect(h.templates.created).toBeUndefined();
    expect(h.storage.deletes).toEqual(["sites/templates/publisher-fixture/v1/source/template.zip"]);
  });

  it("cleans up every object uploaded by the run when Mongo persistence fails", async () => {
    const h = harness();
    h.templates.failCreate = true;
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "TEMPLATE_PERSIST_FAILED",
    });
    expect(h.storage.deletes).toEqual([
      "sites/templates/publisher-fixture/v1/previews/mobile.webp",
      "sites/templates/publisher-fixture/v1/previews/tablet.webp",
      "sites/templates/publisher-fixture/v1/previews/desktop.webp",
      "sites/templates/publisher-fixture/v1/source/template.zip",
    ]);
  });

  it("invalidates the catalog cache only after persistence", async () => {
    const h = harness();
    await h.publisher.publish({ directory: templateDirectory, dryRun: false });
    expect(h.events.indexOf("persist")).toBeLessThan(h.events.indexOf("invalidate"));
  });

  it("surfaces partial publication metadata when cleanup fails", async () => {
    const h = harness();
    h.templates.failCreate = true;
    h.storage.failDeleteObject = "sites/templates/publisher-fixture/v1/previews/tablet.webp";
    await expect(
      h.publisher.publish({ directory: templateDirectory, dryRun: false }),
    ).rejects.toMatchObject({
      code: "TEMPLATE_PERSIST_FAILED",
      metadata: {
        cleanupFailedObjects: ["sites/templates/publisher-fixture/v1/previews/tablet.webp"],
        partialPublication: true,
      },
    });
  });

  it("persists lean source and preview metadata without repeated infrastructure fields", async () => {
    const h = harness();
    const result = await h.publisher.publish({ directory: templateDirectory, dryRun: false });
    expect(h.templates.created).toMatchObject({
      sourceObject: result.objects.source,
      sourceSha256: result.sha256,
      previews: result.objects.previews,
    });
    expect(h.templates.created).not.toHaveProperty("sourceArtifact");
    expect(h.templates.created).not.toHaveProperty("provider");
    expect(h.templates.created).not.toHaveProperty("bucket");
    expect(h.templates.created).not.toHaveProperty("sizeBytes");
    expect(JSON.stringify(h.templates.created?.previews)).not.toContain("template-bucket");
  });
});

describe("T2A regressions", () => {
  it("keeps lean source metadata absent and resolves preview URLs", () => {
    const now = new Date();
    const publicValue = toPublicSiteTemplate(
      {
        id: "template",
        templateKey: "modern-saas",
        version: 1,
        name: "Modern SaaS",
        description: "Description",
        categoryId: "saas",
        tags: [],
        status: "active",
        routes: [{ path: "/", label: "Home" }],
        sourceObject: "sites/templates/modern-saas/v1/source/template.zip",
        sourceSha256: "a".repeat(64),
        previews: {
          desktop: "sites/templates/modern-saas/v1/previews/desktop.webp",
          tablet: "sites/templates/modern-saas/v1/previews/tablet.webp",
          mobile: "sites/templates/modern-saas/v1/previews/mobile.webp",
        },
        createdAt: now,
        updatedAt: now,
      },
      "bucket-chatbot-ni",
    );
    expect(publicValue).not.toHaveProperty("sourceObject");
    expect(publicValue).not.toHaveProperty("sourceSha256");
    expect(JSON.stringify(publicValue)).not.toContain("template.zip");
    expect(publicValue.previews.desktop).toBe(
      "https://storage.googleapis.com/bucket-chatbot-ni/sites/templates/modern-saas/v1/previews/desktop.webp",
    );
  });

  it("preserves frozen T1 active artifact validation", () => {
    expect(() =>
      validateSiteTemplate({
        id: "template",
        templateKey: "modern-saas",
        version: 1,
        name: "Modern SaaS",
        description: "Description",
        categoryId: "saas",
        tags: [],
        status: "active",
        routes: [{ path: "/", label: "Home" }],
        previews: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow("active templates require sourceObject");
  });

  it("executes the real trusted internal React/Vite production build", async () => {
    const result = await new TrustedInternalTemplateBuildRunner().build(templateDirectory);
    expect(result.packageManager).toBe("npm");
    expect(result.durationMs).toBeGreaterThan(0);
  }, 120_000);
});
