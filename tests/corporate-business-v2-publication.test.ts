import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TemplateCatalogCache } from "../src/templates/cache/template-catalog-cache.js";
import { TemplateCatalogService } from "../src/templates/application/template-catalog-service.js";
import { TemplateInstantiationService } from "../src/templates/application/template-instantiation-service.js";
import type { SiteCategory, SiteTemplate } from "../src/templates/domain/site-template.js";
import type { ActiveTemplateQuery, SiteTemplateRepository } from "../src/templates/repositories.js";

interface Artifact { object: string; bytes: Uint8Array }
interface PublicationDependencies {
  expected: SiteTemplate;
  artifacts: Artifact[];
  templates: Pick<SiteTemplateRepository, "findTemplateVersion">;
  storage: { readObject(object: string): Promise<Uint8Array | undefined> };
  publishNew(): Promise<unknown>;
  finalizeCatalog(): Promise<void>;
}
const operationPath = "../scripts/corporate-business-v2-publication.mjs";
const { publishPreparedCorporateBusinessV2 } = await import(operationPath) as {
  publishPreparedCorporateBusinessV2: (input: PublicationDependencies) => Promise<{ state: string; uploads: number; mongoCreates: number; verifiedArtifacts: number; conflicts: number }>;
};
const now = new Date(0);
const category: SiteCategory = { id: "corporate-business-category", categoryKey: "business", name: "Corporate Business", description: "Dining", status: "active", sortOrder: 0, createdAt: now, updatedAt: now };
const query = { tags: [], page: 1, limit: 100 };

function template(key: string, version: number): SiteTemplate {
  return {
    id: `${key}:${version}`, templateKey: key, version, name: key, description: `${key} description`,
    categoryId: key === "corporate-business" ? category.id : "other", tags: ["dining"], status: "active",
    routes: [{ path: "/", label: "Home" }],
    sourceObject: `sites/templates/${key}/v${version}/source/template.zip`, sourceSha256: "a".repeat(64),
    previews: Object.fromEntries(["desktop", "tablet", "mobile"].map((name) => [name, `sites/templates/${key}/v${version}/previews/${name}.webp`])),
    createdAt: now, updatedAt: now,
  };
}

function fixture() {
  const original = template("corporate-business", 1);
  const expected = template("corporate-business", 2);
  const artifacts: Artifact[] = [expected.sourceObject!, expected.previews.desktop!, expected.previews.tablet!, expected.previews.mobile!]
    .map((object, index) => ({ object, bytes: new Uint8Array([index + 1, 42, 99]) }));
  const expectedWithSha = { ...expected, sourceSha256: createHash("sha256").update(artifacts[0]!.bytes).digest("hex") };
  const values = new Map<string, SiteTemplate>([[original.id, original]]);
  for (let index = 0; index < 7; index++) {
    const other = template(`other-${index}`, 1);
    values.set(other.id, other);
  }
  const objects = new Map<string, Uint8Array>([[original.sourceObject!, new Uint8Array([7, 1])]]);
  const templates: SiteTemplateRepository = {
    async listActiveTemplates(q: ActiveTemplateQuery) {
      const active = [...values.values()].filter((value) => value.status === "active" && (!q.categoryId || value.categoryId === q.categoryId));
      return { items: active.slice((q.page - 1) * q.limit, q.page * q.limit), total: active.length };
    },
    async findTemplateVersion(key, version) { return [...values.values()].find((value) => value.templateKey === key && value.version === version); },
    async findLatestActiveTemplate(key) { return [...values.values()].filter((value) => value.templateKey === key && value.status === "active").sort((a, b) => b.version - a.version)[0]; },
    async findById(id) { return values.get(id); },
  };
  const cacheValues = new Map<string, string>([["unrelated-key", "preserve"]]);
  const cache = new TemplateCatalogCache({
    async getString(key) { return cacheValues.get(key); },
    async setString(key, value) { cacheValues.set(key, value); return true; },
    async increment(key) { const value = Number(cacheValues.get(key) ?? 0) + 1; cacheValues.set(key, String(value)); return value; },
  }, "phase7l");
  const publishNew = vi.fn(async () => {
    for (const artifact of artifacts) {
      if (objects.has(artifact.object)) throw new Error("Overwrite attempted");
      objects.set(artifact.object, artifact.bytes);
    }
    values.set(expectedWithSha.id, expectedWithSha);
  });
  const finalizeCatalog = vi.fn(async () => {
    values.set(original.id, { ...original, status: "archived" });
    await cache.requireTemplateCatalogCacheInvalidation();
  });
  const dependencies: PublicationDependencies = {
    expected: expectedWithSha, artifacts, templates,
    storage: { async readObject(object) { return objects.get(object); } },
    publishNew, finalizeCatalog,
  };
  const catalog = new TemplateCatalogService(templates, {
    async findCategoryByKey(key) { return key === category.categoryKey ? category : undefined; },
    async listActiveCategories() { return [category]; },
  }, cache, "bucket-chatbot-ni");
  return { original, expected: expectedWithSha, artifacts, objects, values, templates, catalog, cache, cacheValues, publishNew, finalizeCatalog, dependencies };
}

describe("Corporate Business v2 create-only publication operation", () => {
  it("creates only the four v2 artifacts and preserves v1 source metadata/artifact", async () => {
    const h = fixture();
    const originalBytes = h.objects.get(h.original.sourceObject!);
    await expect(publishPreparedCorporateBusinessV2(h.dependencies)).resolves.toMatchObject({ state: "CREATED", uploads: 4, mongoCreates: 1, verifiedArtifacts: 4, conflicts: 0 });
    expect(h.publishNew).toHaveBeenCalledOnce();
    expect(h.objects.get(h.original.sourceObject!)).toEqual(originalBytes);
    expect(await h.templates.findTemplateVersion("corporate-business", 1)).toEqual({ ...h.original, status: "archived" });
    expect(await h.templates.findTemplateVersion("corporate-business", 2)).toEqual(h.expected);
  });

  it("recognizes matching artifacts and metadata on the second invocation without new writes", async () => {
    const h = fixture();
    await publishPreparedCorporateBusinessV2(h.dependencies);
    const objectCount = h.objects.size;
    const recordCount = h.values.size;
    await expect(publishPreparedCorporateBusinessV2(h.dependencies)).resolves.toMatchObject({ state: "EXISTING", uploads: 0, mongoCreates: 0, conflicts: 0 });
    expect(h.publishNew).toHaveBeenCalledOnce();
    expect(h.objects.size).toBe(objectCount);
    expect(h.values.size).toBe(recordCount);
  });

  it.each([0, 1, 2, 3])("stops before mutation on artifact conflict %i", async (index) => {
    const h = fixture();
    h.objects.set(h.artifacts[index]!.object, new Uint8Array([0]));
    await expect(publishPreparedCorporateBusinessV2(h.dependencies)).rejects.toMatchObject({ code: "GCS_ARTIFACT_CONFLICT" });
    expect(h.publishNew).not.toHaveBeenCalled();
    expect(h.finalizeCatalog).not.toHaveBeenCalled();
  });

  it("does not overwrite conflicting existing metadata", async () => {
    const h = fixture();
    h.values.set(h.expected.id, { ...h.expected, sourceSha256: "b".repeat(64) });
    await expect(publishPreparedCorporateBusinessV2(h.dependencies)).rejects.toMatchObject({ code: "TEMPLATE_METADATA_CONFLICT" });
    expect(h.publishNew).not.toHaveBeenCalled();
  });
});

describe("Current Corporate Business v2 catalog and Use Template resolution", () => {
  it("invalidates stale v1 cache, keeping eight logical cards and one Corporate Business", async () => {
    const h = fixture();
    expect((await h.catalog.listActiveTemplates(query)).data.find((item) => item.templateKey === "corporate-business")?.version).toBe(1);
    await publishPreparedCorporateBusinessV2(h.dependencies);
    const response = await h.catalog.listActiveTemplates(query);
    expect(response.pagination.total).toBe(8);
    expect(response.data.filter((item) => item.templateKey === "corporate-business")).toHaveLength(1);
    expect(response.data.find((item) => item.templateKey === "corporate-business")?.version).toBe(2);
    expect(h.cacheValues.get("unrelated-key")).toBe("preserve");
  });

  it("resolves latest detail and category filtering to v2, with private source metadata omitted", async () => {
    const h = fixture();
    await publishPreparedCorporateBusinessV2(h.dependencies);
    const detail = await h.catalog.getActiveTemplate("corporate-business");
    const categoryResult = await h.catalog.listActiveTemplates({ ...query, category: "business" });
    expect(detail.version).toBe(2);
    expect(detail.previews.desktop).toContain("/corporate-business/v2/");
    expect(categoryResult.pagination.total).toBe(1);
    expect(categoryResult.data[0]?.version).toBe(2);
    expect(detail).not.toHaveProperty("sourceObject");
    expect(detail).not.toHaveProperty("sourceSha256");
    expect(categoryResult.data[0]).not.toHaveProperty("sourceObject");
    await expect(h.catalog.getActiveTemplate("corporate-business", 1)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("Generate resolves the selected v2 source before any project/environment can be created", async () => {
    const h = fixture();
    await publishPreparedCorporateBusinessV2(h.dependencies);
    const readObject = vi.fn<(object: string) => Promise<undefined>>(async () => undefined);
    const createEnvironment = vi.fn();
    const service = new TemplateInstantiationService({
      templates: h.templates, source: { readObject }, execution: { createEnvironment } as never,
      artifacts: {} as never, projects: {} as never, versions: {} as never, browserQA: {} as never,
      cleanupSite: vi.fn(),
    });
    await expect(service.instantiate({ ownerId: "offline-owner" as never, templateKey: "corporate-business" })).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(readObject).toHaveBeenCalledExactlyOnceWith(h.expected.sourceObject);
    expect(createEnvironment).not.toHaveBeenCalled();
  });
});

describe("Archived Corporate Business selection safety", () => {
  it("rejects explicitly selected archived v1 without fallback, storage reads or project creation", async () => {
    const h = fixture();
    await publishPreparedCorporateBusinessV2(h.dependencies);
    const readObject = vi.fn();
    const createEnvironment = vi.fn();
    const projects = { save: vi.fn() };
    const service = new TemplateInstantiationService({
      templates: h.templates, source: { readObject }, execution: { createEnvironment } as never,
      artifacts: {} as never, projects: projects as never, versions: {} as never, browserQA: {} as never,
      cleanupSite: vi.fn(),
    });
    await expect(service.instantiate({ ownerId: "offline-owner" as never, templateKey: "corporate-business", version: 1 }))
      .rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND", message: "Active template was not found" });
    expect(readObject).not.toHaveBeenCalled();
    expect(createEnvironment).not.toHaveBeenCalled();
    expect(projects.save).not.toHaveBeenCalled();
    expect((await h.catalog.getActiveTemplate("corporate-business")).version).toBe(2);
  });
});

