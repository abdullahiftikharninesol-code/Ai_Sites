import type { SiteCategory, SiteTemplate } from "./domain/site-template.js";

export interface ActiveTemplateQuery {
  readonly categoryId?: string;
  readonly search?: string;
  readonly tags: readonly string[];
  readonly page: number;
  readonly limit: number;
}

export interface TemplatePage {
  readonly items: readonly SiteTemplate[];
  readonly total: number;
}

export interface SiteTemplateRepository {
  listActiveTemplates(query: ActiveTemplateQuery): Promise<TemplatePage>;
  findTemplateVersion(templateKey: string, version: number): Promise<SiteTemplate | undefined>;
  findLatestActiveTemplate(templateKey: string): Promise<SiteTemplate | undefined>;
  findById(id: string): Promise<SiteTemplate | undefined>;
}

export interface TemplatePublicationRepository {
  findTemplateVersion(templateKey: string, version: number): Promise<SiteTemplate | undefined>;
  createTemplateVersion(template: SiteTemplate): Promise<SiteTemplate>;
}

export interface TemplateActivationRepository {
  findTemplateVersion(templateKey: string, version: number): Promise<SiteTemplate | undefined>;
  activateTemplateVersion(template: SiteTemplate): Promise<SiteTemplate>;
}

export interface SiteCategoryRepository {
  listActiveCategories(): Promise<readonly SiteCategory[]>;
  findCategoryByKey(categoryKey: string): Promise<SiteCategory | undefined>;
}

export interface TemplateCategoryRegistrationRepository {
  findCategoryByKey(categoryKey: string): Promise<SiteCategory | undefined>;
  createCategory(category: SiteCategory): Promise<SiteCategory>;
}
