import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationError } from "../src/app/errors/application-error.js";
import {
  APPROVED_TEMPLATE_CATEGORIES,
  APPROVED_TEMPLATE_KEYS,
  ApprovedTemplateCatalogRegistrationService,
  type ApprovedManifestLoader,
  type TemplateCatalogCacheInvalidator,
} from "../src/templates/application/approved-template-catalog-registration.js";
import { TemplateCatalogService } from "../src/templates/application/template-catalog-service.js";
import { TemplateCatalogCache, type TemplateCatalogRedis } from "../src/templates/cache/template-catalog-cache.js";
import type { SiteCategory, SiteTemplate } from "../src/templates/domain/site-template.js";
import { loadTemplateManifest, type TemplateManifest } from "../src/templates/publishing/template-manifest.js";
import type {
  ActiveTemplateQuery,
  SiteCategoryRepository,
  SiteTemplateRepository,
  TemplateCategoryRegistrationRepository,
  TemplatePage,
  TemplatePublicationRepository,
} from "../src/templates/repositories.js";

const categoryByTemplate = new Map(
  APPROVED_TEMPLATE_KEYS.map((key, index) => [key, APPROVED_TEMPLATE_CATEGORIES[index]!.categoryKey]),
);

const manifests = (): Map<string, TemplateManifest> =>
  new Map(
    APPROVED_TEMPLATE_KEYS.map((templateKey, index) => [
      templateKey,
      {
        templateKey,
        version: 1,
        name: `Template ${index + 1}`,
        description: `Canonical description ${index + 1}`,
        categoryKey: categoryByTemplate.get(templateKey)!,
        tags: [`tag-${index + 1}`, "multi-page"],
        status: "draft",
        routes: [
          { path: "/", label: "Home" },
          { path: "/about", label: "About" },
        ],
      },
    ]),
  );

class MemoryCategories
  implements TemplateCategoryRegistrationRepository, SiteCategoryRepository
{
  readonly records = new Map<string, SiteCategory>();
  createCalls = 0;

  findCategoryByKey(categoryKey: string): Promise<SiteCategory | undefined> {
    return Promise.resolve(this.records.get(categoryKey));
  }

  createCategory(category: SiteCategory): Promise<SiteCategory> {
    this.createCalls++;
    this.records.set(category.categoryKey, category);
    return Promise.resolve(category);
  }

  listActiveCategories(): Promise<readonly SiteCategory[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((category) => category.status === "active")
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder || left.categoryKey.localeCompare(right.categoryKey),
        ),
    );
  }
}

class MemoryTemplates implements TemplatePublicationRepository, SiteTemplateRepository {
  readonly records = new Map<string, SiteTemplate>();
  createCalls = 0;

  findTemplateVersion(templateKey: string, version: number): Promise<SiteTemplate | undefined> {
    return Promise.resolve(this.records.get(`${templateKey}:${version}`));
  }

  createTemplateVersion(template: SiteTemplate): Promise<SiteTemplate> {
    this.createCalls++;
    this.records.set(`${template.templateKey}:${template.version}`, template);
    return Promise.resolve(template);
  }

  listActiveTemplates(query: ActiveTemplateQuery): Promise<TemplatePage> {
    const items = [...this.records.values()].filter(
      (template) =>
        template.status === "active" &&
        (!query.categoryId || template.categoryId === query.categoryId) &&
        query.tags.every((tag) => template.tags.includes(tag)),
    );
    return Promise.resolve({ items, total: items.length });
  }

  findLatestActiveTemplate(templateKey: string): Promise<SiteTemplate | undefined> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((template) => template.templateKey === templateKey && template.status === "active")
        .sort((left, right) => right.version - left.version)[0],
    );
  }

  findById(id: string): Promise<SiteTemplate | undefined> {
    return Promise.resolve([...this.records.values()].find((template) => template.id === id));
  }
}

class MemoryInvalidator implements TemplateCatalogCacheInvalidator {
  calls = 0;
  invalidateTemplateCatalogCache(): Promise<void> {
    this.calls++;
    return Promise.resolve();
  }
}

class MemoryRedis implements TemplateCatalogRedis {
  readonly values = new Map<string, string>();
  increments: string[] = [];
  getString(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  setString(key: string, value: string): Promise<boolean> {
    this.values.set(key, value);
    return Promise.resolve(true);
  }
  increment(key: string): Promise<number> {
    this.increments.push(key);
    const value = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(value));
    return Promise.resolve(value);
  }
}

function fixture(values = manifests()) {
  const categories = new MemoryCategories();
  const templates = new MemoryTemplates();
  const cache = new MemoryInvalidator();
  let id = 0;
  const loader: ApprovedManifestLoader = (directory) => {
    const manifest = values.get(basename(directory));
    if (!manifest) throw new Error("missing manifest");
    return Promise.resolve(manifest);
  };
  const service = new ApprovedTemplateCatalogRegistrationService(
    categories,
    templates,
    cache,
    loader,
    () => new Date("2026-01-01T00:00:00.000Z"),
    () => `id-${++id}`,
  );
  return { categories, templates, cache, service, values };
}

describe("Phase 4A approved template catalog registration", () => {
  it("contains exactly the eight approved category definitions", () => {
    expect(APPROVED_TEMPLATE_CATEGORIES.map((category) => category.categoryKey)).toEqual([
      "saas", "agency", "portfolio", "business", "ecommerce", "restaurant", "real-estate", "healthcare",
    ]);
  });

  it("uses the deterministic category sort order", () => {
    expect(APPROVED_TEMPLATE_CATEGORIES.map((category) => category.sortOrder)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  it("contains exactly the eight approved template keys", () => {
    expect(APPROVED_TEMPLATE_KEYS).toEqual([
      "modern-saas", "creative-agency", "personal-portfolio", "corporate-business",
      "ecommerce-store", "restaurant", "real-estate", "healthcare-clinic",
    ]);
  });

  it("loads every approved manifest from its local template directory", async () => {
    for (const key of APPROVED_TEMPLATE_KEYS) {
      const manifest = await loadTemplateManifest(resolve("templates", key));
      expect(manifest.templateKey).toBe(key);
      expect(manifest.status).toBe("draft");
    }
  });

  it("creates all missing categories", async () => {
    const h = fixture();
    const result = await h.service.register("templates");
    expect(result.categoriesCreated).toBe(8);
    expect(h.categories.records.size).toBe(8);
  });

  it("maps the configured sort order onto created categories", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect([...h.categories.records.values()].map((category) => category.sortOrder)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  it("creates all missing template versions", async () => {
    const h = fixture();
    const result = await h.service.register("templates");
    expect(result.templatesCreated).toBe(8);
    expect(h.templates.records.size).toBe(8);
  });

  it("resolves every categoryKey to its trusted category id", async () => {
    const h = fixture();
    await h.service.register("templates");
    for (const template of h.templates.records.values()) {
      const manifest = h.values.get(template.templateKey)!;
      expect(template.categoryId).toBe(h.categories.records.get(manifest.categoryKey)?.id);
    }
  });

  it("always inserts templates as draft", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect([...h.templates.records.values()].every((template) => template.status === "draft")).toBe(true);
  });

  it("rejects an approved manifest that attempts to register active", async () => {
    const values = manifests();
    values.set("modern-saas", { ...values.get("modern-saas")!, status: "active" });
    const h = fixture(values);
    await expect(h.service.register("templates")).rejects.toMatchObject({
      code: "APPROVED_TEMPLATE_MANIFEST_INVALID",
    });
    expect(h.categories.createCalls).toBe(0);
  });

  it("does not persist sourceObject", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect([...h.templates.records.values()].every((template) => template.sourceObject === undefined)).toBe(true);
  });

  it("does not persist sourceSha256", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect([...h.templates.records.values()].every((template) => template.sourceSha256 === undefined)).toBe(true);
  });

  it("does not persist previews", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect([...h.templates.records.values()].every((template) => Object.keys(template.previews).length === 0)).toBe(true);
  });

  it("does not persist a local filesystem path", async () => {
    const h = fixture();
    await h.service.register(resolve("templates"));
    const serialized = JSON.stringify([...h.templates.records.values()]);
    expect(serialized).not.toContain(resolve("templates"));
    expect(serialized).not.toContain("site-template.json");
  });

  it("is idempotent for categories and templates", async () => {
    const h = fixture();
    await h.service.register("templates");
    const second = await h.service.register("templates");
    expect(second).toMatchObject({ categoriesCreated: 0, templatesCreated: 0, conflicts: 0 });
    expect(h.categories.createCalls).toBe(8);
    expect(h.templates.createCalls).toBe(8);
  });

  it("treats matching categories as no-ops", async () => {
    const h = fixture();
    await h.service.register("templates");
    const second = await h.service.register("templates");
    expect(second.categoriesExisting).toBe(8);
  });

  it("detects a material category conflict before writing", async () => {
    const h = fixture();
    h.categories.records.set("saas", {
      id: "existing", ...APPROVED_TEMPLATE_CATEGORIES[0], name: "Conflicting SaaS", status: "active",
      createdAt: new Date(0), updatedAt: new Date(0),
    });
    await expect(h.service.register("templates")).rejects.toMatchObject({ code: "CATEGORY_CONFLICT" });
    expect(h.categories.createCalls).toBe(0);
  });

  it("detects conflicting template metadata before writing templates", async () => {
    const h = fixture();
    await h.service.register("templates");
    const existing = h.templates.records.get("modern-saas:1")!;
    h.templates.records.set("modern-saas:1", { ...existing, description: "Conflict" });
    await expect(h.service.register("templates")).rejects.toMatchObject({ code: "TEMPLATE_METADATA_CONFLICT" });
    expect(h.templates.createCalls).toBe(8);
  });

  it("does not create duplicate templateKey/version records", async () => {
    const h = fixture();
    await h.service.register("templates");
    await h.service.register("templates");
    expect(new Set([...h.templates.records.keys()]).size).toBe(8);
  });

  it("preserves manifest descriptions", async () => {
    const h = fixture();
    await h.service.register("templates");
    for (const template of h.templates.records.values())
      expect(template.description).toBe(h.values.get(template.templateKey)?.description);
  });

  it("preserves manifest tags in order", async () => {
    const h = fixture();
    await h.service.register("templates");
    for (const template of h.templates.records.values())
      expect(template.tags).toEqual(h.values.get(template.templateKey)?.tags);
  });

  it("preserves manifest routes in order", async () => {
    const h = fixture();
    await h.service.register("templates");
    for (const template of h.templates.records.values())
      expect(template.routes).toEqual(h.values.get(template.templateKey)?.routes);
  });

  it("keeps registered drafts out of the public template catalog", async () => {
    const h = fixture();
    await h.service.register("templates");
    const catalog = new TemplateCatalogService(
      h.templates,
      h.categories,
      new TemplateCatalogCache(new MemoryRedis(), "test"),
      "unused-for-empty-draft-result",
    );
    const result = await catalog.listActiveTemplates({ tags: [], page: 1, limit: 100 });
    expect(result.data).toEqual([]);
  });

  it("keeps registered drafts visible through internal repository reads", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect(await h.templates.findTemplateVersion("modern-saas", 1)).toMatchObject({ status: "draft" });
  });

  it("invalidates the template catalog cache once after a changed batch", async () => {
    const h = fixture();
    await h.service.register("templates");
    expect(h.cache.calls).toBe(1);
  });

  it("invalidates once after every successful idempotent batch", async () => {
    const h = fixture();
    await h.service.register("templates");
    await h.service.register("templates");
    expect(h.cache.calls).toBe(2);
  });

  it("does not instantiate or import a GCS client", async () => {
    const cli = await readFile("src/templates/cli/template-catalog-register-cli.ts", "utf8");
    const service = await readFile(
      "src/templates/application/approved-template-catalog-registration.ts",
      "utf8",
    );
    expect(`${cli}\n${service}`).not.toMatch(/GoogleCloud|@google-cloud\/storage|putObject/);
  });

  it("has no billing or quota Redis mutation path", async () => {
    const cli = await readFile("src/templates/cli/template-catalog-register-cli.ts", "utf8");
    const service = await readFile(
      "src/templates/application/approved-template-catalog-registration.ts",
      "utf8",
    );
    expect(`${cli}\n${service}`).not.toMatch(/billing|quota|deleteExactKeys|publish\(/i);
  });

  it("reports manifest validation failures with the approved-manifest code", async () => {
    const h = fixture();
    const broken = new ApprovedTemplateCatalogRegistrationService(
      h.categories,
      h.templates,
      h.cache,
      () => Promise.reject(new ApplicationError("MANIFEST_INVALID", "broken")),
    );
    await expect(broken.register("templates")).rejects.toMatchObject({
      code: "APPROVED_TEMPLATE_MANIFEST_INVALID",
    });
  });
});
