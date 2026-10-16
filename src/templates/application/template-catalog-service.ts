import { ApplicationError } from "../../app/errors/application-error.js";
import type { TemplateCatalogCache } from "../cache/template-catalog-cache.js";
import {
  toPublicSiteCategory,
  toPublicSiteTemplate,
  type PublicSiteCategory,
  type PublicSiteTemplate,
} from "../domain/site-template.js";
import type { TemplateCatalogQuery } from "../http/template-catalog-query.js";
import type { SiteCategoryRepository, SiteTemplateRepository } from "../repositories.js";

export interface TemplateCatalogResponse {
  readonly data: readonly PublicSiteTemplate[];
  readonly pagination: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
  };
}

export class TemplateCatalogService {
  constructor(
    private readonly templates: SiteTemplateRepository,
    private readonly categories: SiteCategoryRepository,
    private readonly cache: TemplateCatalogCache,
    private readonly previewBucket: string,
  ) {}

  async listActiveTemplates(query: TemplateCatalogQuery): Promise<TemplateCatalogResponse> {
    const cacheGeneration = await this.cache.generation();
    const cached = await this.cache.read<TemplateCatalogResponse>(
      "catalog",
      query,
      cacheGeneration,
    );
    if (cached) return cached;
    let categoryId: string | undefined;
    if (query.category) {
      const category = await this.categories.findCategoryByKey(query.category);
      if (!category || category.status !== "active") return this.#empty(query);
      categoryId = category.id;
    }
    const page = await this.templates.listActiveTemplates({
      ...(categoryId ? { categoryId } : {}),
      ...(query.search ? { search: query.search } : {}),
      tags: query.tags,
      page: query.page,
      limit: query.limit,
    });
    const response: TemplateCatalogResponse = {
      data: page.items.map((template) => toPublicSiteTemplate(template, this.previewBucket)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: page.total,
        totalPages: Math.ceil(page.total / query.limit),
      },
    };
    await this.cache.write("catalog", query, response, cacheGeneration);
    return response;
  }

  async getActiveTemplate(templateKey: string, version?: number): Promise<PublicSiteTemplate> {
    const identity = { templateKey, version: version ?? "latest" };
    const cacheGeneration = await this.cache.generation();
    const cached = await this.cache.read<PublicSiteTemplate>("detail", identity, cacheGeneration);
    if (cached) return cached;
    const template =
      version === undefined
        ? await this.templates.findLatestActiveTemplate(templateKey)
        : await this.templates.findTemplateVersion(templateKey, version);
    if (!template || template.status !== "active")
      throw new ApplicationError("TEMPLATE_NOT_FOUND", "Site template not found");
    const response = toPublicSiteTemplate(template, this.previewBucket);
    await this.cache.write("detail", identity, response, cacheGeneration);
    return response;
  }

  async listActiveCategories(): Promise<{ readonly data: readonly PublicSiteCategory[] }> {
    const cacheGeneration = await this.cache.generation();
    const cached = await this.cache.read<{ readonly data: readonly PublicSiteCategory[] }>(
      "categories",
      "active",
      cacheGeneration,
    );
    if (cached) return cached;
    const response = {
      data: (await this.categories.listActiveCategories()).map(toPublicSiteCategory),
    };
    await this.cache.write("categories", "active", response, cacheGeneration);
    return response;
  }

  invalidateTemplateCatalogCache(): Promise<void> {
    return this.cache.invalidateTemplateCatalogCache();
  }

  #empty(query: TemplateCatalogQuery): TemplateCatalogResponse {
    return {
      data: [],
      pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
    };
  }
}
