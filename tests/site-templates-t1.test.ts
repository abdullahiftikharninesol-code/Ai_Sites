import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplateCatalogService } from "../src/templates/application/template-catalog-service.js";
import {
  TemplateCatalogCache,
  TEMPLATE_CATALOG_CACHE_TTL_SECONDS,
  type TemplateCatalogRedis,
} from "../src/templates/cache/template-catalog-cache.js";
import {
  toPublicSiteTemplate,
  validateSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
} from "../src/templates/domain/site-template.js";
import {
  parseTemplateCatalogQuery,
  parseTemplateVersion,
  validateTemplateKey,
} from "../src/templates/http/template-catalog-query.js";
import { createMongoTemplateModels } from "../src/templates/persistence/mongo-template-models.js";
import type {
  ActiveTemplateQuery,
  SiteCategoryRepository,
  SiteTemplateRepository,
} from "../src/templates/repositories.js";

const connections: mongoose.Connection[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

const timestamp = new Date("2026-10-15T00:00:00.000Z");
const template = (
  id: string,
  templateKey: string,
  version: number,
  status: SiteTemplate["status"] = "active",
  fields: Partial<SiteTemplate> = {},
): SiteTemplate => ({
  id,
  templateKey,
  version,
  name: `${templateKey} v${version}`,
  description: `A ${templateKey} website template`,
  categoryId: "category-saas",
  tags: ["modern", "landing-page"],
  status,
  routes: [{ path: "/", label: "Home" }],
  ...(status === "active"
    ? {
        sourceObject: `sites/templates/${templateKey}/v${version}/source/template.zip`,
        sourceSha256: "a".repeat(64),
      }
    : {}),
  previews: {
    desktop: `sites/templates/${templateKey}/v${version}/previews/desktop.webp`,
    tablet: `sites/templates/${templateKey}/v${version}/previews/tablet.webp`,
    mobile: `sites/templates/${templateKey}/v${version}/previews/mobile.webp`,
  },
  createdAt: timestamp,
  updatedAt: new Date(timestamp.getTime() + version),
  ...fields,
});

const category = (
  id: string,
  categoryKey: string,
  status: SiteCategory["status"] = "active",
  sortOrder = 0,
): SiteCategory => ({
  id,
  categoryKey,
  name: categoryKey,
  description: `${categoryKey} templates`,
  status,
  sortOrder,
  createdAt: timestamp,
  updatedAt: timestamp,
});

class MemoryTemplateRepository implements SiteTemplateRepository {
  listCalls = 0;

  constructor(readonly records: readonly SiteTemplate[]) {}

  async listActiveTemplates(query: ActiveTemplateQuery) {
    this.listCalls += 1;
    const search = query.search?.toLowerCase();
    const filtered = this.records
      .filter((record) => record.status === "active")
      .filter((record) => !query.categoryId || record.categoryId === query.categoryId)
      .filter((record) => query.tags.every((tag) => record.tags.includes(tag)))
      .filter(
        (record) =>
          !search ||
          [record.name, record.description, record.templateKey, ...record.tags].some((value) =>
            value.toLowerCase().includes(search),
          ),
      )
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          left.templateKey.localeCompare(right.templateKey) ||
          right.version - left.version,
      );
    const start = (query.page - 1) * query.limit;
    return { items: filtered.slice(start, start + query.limit), total: filtered.length };
  }

  async findTemplateVersion(templateKey: string, version: number) {
    return this.records.find(
      (record) => record.templateKey === templateKey && record.version === version,
    );
  }

  async findLatestActiveTemplate(templateKey: string) {
    return this.records
      .filter((record) => record.templateKey === templateKey && record.status === "active")
      .sort((left, right) => right.version - left.version)[0];
  }

  async findById(id: string) {
    return this.records.find((record) => record.id === id);
  }
}

class MemoryCategoryRepository implements SiteCategoryRepository {
  listCalls = 0;

  constructor(readonly records: readonly SiteCategory[]) {}

  async listActiveCategories() {
    this.listCalls += 1;
    return this.records
      .filter((record) => record.status === "active")
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.categoryKey.localeCompare(right.categoryKey),
      );
  }

  async findCategoryByKey(categoryKey: string) {
    return this.records.find((record) => record.categoryKey === categoryKey);
  }
}

class MemoryRedis implements TemplateCatalogRedis {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; ttl: number }> = [];
  increments = 0;

  async getString(key: string) {
    return this.values.get(key);
  }

  async setString(key: string, value: string, ttlSeconds: number) {
    this.values.set(key, value);
    this.writes.push({ key, ttl: ttlSeconds });
    return true;
  }

  async increment(key: string) {
    const next = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(next));
    this.increments += 1;
    return next;
  }
}

const fixture = () => {
  const categories = new MemoryCategoryRepository([
    category("category-portfolio", "portfolio", "active", 1),
    category("category-saas", "saas", "active", 2),
    category("category-draft", "draft-category", "draft", 3),
  ]);
  const templates = new MemoryTemplateRepository([
    template("saas-v1", "modern-saas", 1),
    template("saas-v2", "modern-saas", 2, "active", { tags: ["dark", "modern"] }),
    template("portfolio-v1", "clean-portfolio", 1, "active", {
      categoryId: "category-portfolio",
      tags: ["minimal", "professional"],
      description: "A polished creative showcase",
    }),
    template("draft", "draft-site", 1, "draft"),
    template("archived", "old-site", 1, "archived"),
  ]);
  const redis = new MemoryRedis();
  const cache = new TemplateCatalogCache(redis, "test");
  return {
    templates,
    categories,
    redis,
    service: new TemplateCatalogService(templates, categories, cache, "bucket-chatbot-ni"),
    cache,
  };
};

const query = (value = "") => parseTemplateCatalogQuery(new URLSearchParams(value));

describe("Sites template Mongo contracts", () => {
  it("uses dedicated collections and unique version/category-key indexes", () => {
    const connection = mongoose.createConnection();
    connections.push(connection);
    const models = createMongoTemplateModels(connection);
    expect(models.templates.collection.collectionName).toBe("sites_templates");
    expect(models.categories.collection.collectionName).toBe("sites_categories");
    expect(models.templates.schema.indexes()).toContainEqual([
      { templateKey: 1, version: 1 },
      { unique: true },
    ]);
    expect(models.categories.schema.indexes()).toContainEqual([
      { categoryKey: 1 },
      { unique: true },
    ]);
  });

  it("defines only metadata fields and the required query indexes", () => {
    const connection = mongoose.createConnection();
    connections.push(connection);
    const models = createMongoTemplateModels(connection);
    expect(Object.keys(models.templates.schema.paths)).not.toEqual(
      expect.arrayContaining([
        "source",
        "sourceArtifact",
        "code",
        "zip",
        "files",
        "credentials",
        "provider",
        "bucket",
        "sizeBytes",
      ]),
    );
    expect(Object.keys(models.templates.schema.paths)).toEqual(
      expect.arrayContaining(["sourceObject", "sourceSha256", "previews"]),
    );
    expect(models.templates.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ status: 1 }, {}],
        [{ categoryId: 1 }, {}],
        [{ updatedAt: -1 }, {}],
      ]),
    );
    expect(models.categories.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ status: 1 }, {}],
        [{ sortOrder: 1 }, {}],
      ]),
    );
  });

  it("serializes only lean artifact metadata in the Mongo document shape", async () => {
    const connection = mongoose.createConnection();
    connections.push(connection);
    const models = createMongoTemplateModels(connection);
    const value = template("lean", "modern-saas", 1);
    const document = new models.templates({ ...value, _id: value.id });
    await document.validate();
    const stored = document.toObject();
    expect(stored).toMatchObject({
      sourceObject: "sites/templates/modern-saas/v1/source/template.zip",
      sourceSha256: "a".repeat(64),
      previews: {
        desktop: "sites/templates/modern-saas/v1/previews/desktop.webp",
        tablet: "sites/templates/modern-saas/v1/previews/tablet.webp",
        mobile: "sites/templates/modern-saas/v1/previews/mobile.webp",
      },
    });
    expect(stored).not.toHaveProperty("sourceArtifact");
    expect(JSON.stringify(stored)).not.toMatch(/"(?:provider|bucket|sizeBytes)"/);
  });

  it("rejects duplicate route paths deterministically", async () => {
    const invalid = template("duplicate", "duplicate-routes", 1, "draft", {
      routes: [
        { path: "/", label: "Home" },
        { path: "/", label: "Again" },
      ],
    });
    expect(() => validateSiteTemplate(invalid)).toThrow("duplicate route path");
    const connection = mongoose.createConnection();
    connections.push(connection);
    const models = createMongoTemplateModels(connection);
    await expect(new models.templates({ ...invalid, _id: invalid.id }).validate()).rejects.toThrow(
      "duplicate route path",
    );
  });

  it("requires lean source and preview object metadata for active records", () => {
    expect(() =>
      validateSiteTemplate(template("draft-artifact", "draft-artifact", 1, "draft")),
    ).not.toThrow();
    expect(() =>
      validateSiteTemplate(
        template("active-artifact", "active-artifact", 1, "draft", { status: "active" }),
      ),
    ).toThrow("active templates require sourceObject");
  });
});

describe("Sites active template catalog", () => {
  it("returns active records and excludes drafts and archives", async () => {
    const { service } = fixture();
    const result = await service.listActiveTemplates(query());
    expect(result.data.map((item) => item.templateKey)).toEqual([
      "modern-saas",
      "clean-portfolio",
      "modern-saas",
    ]);
    expect(result.data.map((item) => item.templateKey)).not.toEqual(
      expect.arrayContaining(["draft-site", "old-site"]),
    );
  });

  it("filters by active category key", async () => {
    const { service } = fixture();
    const result = await service.listActiveTemplates(query("category=portfolio"));
    expect(result.data.map((item) => item.templateKey)).toEqual(["clean-portfolio"]);
    await expect(
      service.listActiveTemplates(query("category=draft-category")),
    ).resolves.toMatchObject({ data: [], pagination: { total: 0 } });
  });

  it("requires every requested tag", async () => {
    const { service } = fixture();
    await expect(service.listActiveTemplates(query("tags=dark,modern"))).resolves.toMatchObject({
      data: [{ templateKey: "modern-saas", version: 2 }],
    });
  });

  it("searches name, description, templateKey, and tags case-insensitively", async () => {
    const { service } = fixture();
    for (const search of ["CLEAN-PORTFOLIO", "creative showcase", "professional"])
      expect(
        (await service.listActiveTemplates(query(`search=${encodeURIComponent(search)}`))).data,
      ).toHaveLength(1);
  });

  it("returns stable page/limit pagination with a safe maximum", async () => {
    const { service } = fixture();
    const result = await service.listActiveTemplates(query("page=2&limit=2"));
    expect(result.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(result.data).toHaveLength(1);
    expect(() => query("limit=101")).toThrow("limit must be between 1 and 100");
  });

  it("resolves the latest active version and an explicit active version", async () => {
    const { service } = fixture();
    await expect(service.getActiveTemplate("modern-saas")).resolves.toMatchObject({ version: 2 });
    await expect(service.getActiveTemplate("modern-saas", 1)).resolves.toMatchObject({
      version: 1,
    });
  });

  it("never resolves draft or archived versions through the catalog", async () => {
    const { service } = fixture();
    await expect(service.getActiveTemplate("draft-site", 1)).rejects.toMatchObject({
      code: "TEMPLATE_NOT_FOUND",
    });
    await expect(service.getActiveTemplate("old-site")).rejects.toMatchObject({
      code: "TEMPLATE_NOT_FOUND",
    });
  });

  it("returns only active categories in deterministic order", async () => {
    const { service } = fixture();
    await expect(service.listActiveCategories()).resolves.toMatchObject({
      data: [{ categoryKey: "portfolio" }, { categoryKey: "saas" }],
    });
  });
});

describe("Sites template catalog cache and serialization", () => {
  it("serves repeat catalog and category reads from the Sites Redis cache", async () => {
    const { service, templates, categories, redis } = fixture();
    const first = await service.listActiveTemplates(query("tags=modern"));
    const second = await service.listActiveTemplates(query("tags=modern"));
    await service.listActiveCategories();
    await service.listActiveCategories();
    expect(second).toEqual(first);
    expect(templates.listCalls).toBe(1);
    expect(categories.listCalls).toBe(1);
    expect(redis.writes.every((write) => write.ttl === TEMPLATE_CATALOG_CACHE_TTL_SECONDS)).toBe(
      true,
    );
    expect(redis.writes.every((write) => write.key.startsWith("sites:test:templates:"))).toBe(true);
  });

  it("invalidates all catalog shapes by advancing the cache generation", async () => {
    const { service, templates, cache, redis } = fixture();
    await service.listActiveTemplates(query());
    await service.listActiveTemplates(query());
    expect(templates.listCalls).toBe(1);
    await cache.invalidateTemplateCatalogCache();
    await service.listActiveTemplates(query());
    expect(redis.increments).toBe(1);
    expect(templates.listCalls).toBe(2);
  });

  it("does not expose source metadata and resolves preview object paths to public URLs", () => {
    const record = template("safe", "safe-template", 1, "active", {
      sourceObject: "sites/templates/safe-template/v1/source/template.zip",
      sourceSha256: "b".repeat(64),
    });
    const publicValue = toPublicSiteTemplate(record, "bucket-chatbot-ni");
    const serialized = JSON.stringify(publicValue);
    expect(publicValue).not.toHaveProperty("sourceObject");
    expect(publicValue).not.toHaveProperty("sourceSha256");
    expect(serialized).not.toContain("template.zip");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain('"bucket"');
    expect(publicValue.previews.desktop).toBe(
      "https://storage.googleapis.com/bucket-chatbot-ni/sites/templates/safe-template/v1/previews/desktop.webp",
    );
    expect(publicValue).toMatchObject({
      description: "A safe-template website template",
      tags: ["modern", "landing-page"],
      routes: [{ path: "/", label: "Home" }],
      previews: {
        tablet:
          "https://storage.googleapis.com/bucket-chatbot-ni/sites/templates/safe-template/v1/previews/tablet.webp",
        mobile:
          "https://storage.googleapis.com/bucket-chatbot-ni/sites/templates/safe-template/v1/previews/mobile.webp",
      },
    });
  });
});

describe("Sites template HTTP query validation", () => {
  it.each([
    "page=0",
    "page=1.5",
    "limit=-1",
    "limit=999",
    "category=Not%20Safe",
    "tags=valid,NOT_SAFE",
  ])("rejects malformed catalog query %s", (value) => {
    expect(() => query(value)).toThrow();
  });

  it("validates template keys and explicit versions", () => {
    expect(validateTemplateKey("modern-saas")).toBe("modern-saas");
    expect(() => validateTemplateKey("Modern SaaS")).toThrow();
    expect(parseTemplateVersion(new URLSearchParams("version=2"))).toBe(2);
    expect(parseTemplateVersion(new URLSearchParams())).toBeUndefined();
    expect(() => parseTemplateVersion(new URLSearchParams("version=0"))).toThrow();
  });
});
