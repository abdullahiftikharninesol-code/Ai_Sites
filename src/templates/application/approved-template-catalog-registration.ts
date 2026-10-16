import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  validateSiteCategory,
  validateSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
} from "../domain/site-template.js";
import {
  loadTemplateManifest,
  type TemplateManifest,
} from "../publishing/template-manifest.js";
import type {
  TemplateCategoryRegistrationRepository,
  TemplatePublicationRepository,
} from "../repositories.js";

export interface ApprovedTemplateCategoryDefinition {
  readonly categoryKey: string;
  readonly name: string;
  readonly description: string;
  readonly sortOrder: number;
}

export const APPROVED_TEMPLATE_CATEGORIES = [
  {
    categoryKey: "saas",
    name: "SaaS",
    description: "Templates for software, AI and subscription-based web products.",
    sortOrder: 10,
  },
  {
    categoryKey: "agency",
    name: "Agency",
    description: "Templates for creative, branding, marketing and digital agencies.",
    sortOrder: 20,
  },
  {
    categoryKey: "portfolio",
    name: "Portfolio",
    description: "Templates for personal portfolios, creatives and independent professionals.",
    sortOrder: 30,
  },
  {
    categoryKey: "business",
    name: "Business",
    description: "Templates for corporate, consulting and professional service businesses.",
    sortOrder: 40,
  },
  {
    categoryKey: "ecommerce",
    name: "Ecommerce",
    description: "Templates for online stores, retail and direct-to-consumer brands.",
    sortOrder: 50,
  },
  {
    categoryKey: "restaurant",
    name: "Restaurant",
    description: "Templates for restaurants, hospitality and dining businesses.",
    sortOrder: 60,
  },
  {
    categoryKey: "real-estate",
    name: "Real Estate",
    description: "Templates for property agencies, brokers and real estate businesses.",
    sortOrder: 70,
  },
  {
    categoryKey: "healthcare",
    name: "Healthcare",
    description: "Templates for clinics, healthcare practices and wellness providers.",
    sortOrder: 80,
  },
] as const satisfies readonly ApprovedTemplateCategoryDefinition[];

export const APPROVED_TEMPLATE_KEYS = [
  "modern-saas",
  "creative-agency",
  "personal-portfolio",
  "corporate-business",
  "ecommerce-store",
  "restaurant",
  "real-estate",
  "healthcare-clinic",
] as const;

export const EXPECTED_CATEGORY_BY_TEMPLATE: Readonly<
  Record<(typeof APPROVED_TEMPLATE_KEYS)[number], string>
> = {
  "modern-saas": "saas",
  "creative-agency": "agency",
  "personal-portfolio": "portfolio",
  "corporate-business": "business",
  "ecommerce-store": "ecommerce",
  restaurant: "restaurant",
  "real-estate": "real-estate",
  "healthcare-clinic": "healthcare",
};

export interface TemplateCatalogCacheInvalidator {
  invalidateTemplateCatalogCache(): Promise<void>;
}

export interface ApprovedTemplateRegistrationSummary {
  readonly templateKey: string;
  readonly version: number;
  readonly categoryKey: string;
  readonly categoryName: string;
  readonly status: "draft";
  readonly routeCount: number;
  readonly tagCount: number;
  readonly created: boolean;
}

export interface ApprovedCatalogRegistrationResult {
  readonly categoriesCreated: number;
  readonly categoriesExisting: number;
  readonly templatesCreated: number;
  readonly templatesExisting: number;
  readonly conflicts: 0;
  readonly cacheInvalidated: boolean;
  readonly categories: readonly (ApprovedTemplateCategoryDefinition & {
    readonly created: boolean;
    readonly status: "active";
  })[];
  readonly templates: readonly ApprovedTemplateRegistrationSummary[];
}

export type ApprovedManifestLoader = (directory: string) => Promise<TemplateManifest>;

const categoryMatches = (
  existing: SiteCategory,
  expected: ApprovedTemplateCategoryDefinition,
): boolean =>
  existing.categoryKey === expected.categoryKey &&
  existing.name === expected.name &&
  existing.description === expected.description &&
  existing.status === "active" &&
  existing.sortOrder === expected.sortOrder;

const routesMatch = (left: SiteTemplate["routes"], right: TemplateManifest["routes"]): boolean =>
  left.length === right.length &&
  left.every(
    (route, index) => route.path === right[index]?.path && route.label === right[index]?.label,
  );

const stringsMatch = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const templateMatches = (
  existing: SiteTemplate,
  manifest: TemplateManifest,
  categoryId: string,
): boolean =>
  existing.templateKey === manifest.templateKey &&
  existing.version === manifest.version &&
  existing.name === manifest.name &&
  existing.description === manifest.description &&
  existing.categoryId === categoryId &&
  stringsMatch(existing.tags, manifest.tags) &&
  routesMatch(existing.routes, manifest.routes) &&
  existing.status === "draft" &&
  existing.sourceObject === undefined &&
  existing.sourceSha256 === undefined &&
  Object.keys(existing.previews).length === 0;

export class ApprovedTemplateCatalogRegistrationService {
  constructor(
    private readonly categories: TemplateCategoryRegistrationRepository,
    private readonly templates: TemplatePublicationRepository,
    private readonly cache: TemplateCatalogCacheInvalidator,
    private readonly manifestLoader: ApprovedManifestLoader = loadTemplateManifest,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
  ) {}

  async register(templatesRoot: string): Promise<ApprovedCatalogRegistrationResult> {
    const manifests = await this.#loadApprovedManifests(templatesRoot);
    const existingCategories = new Map<string, SiteCategory>();
    const missingCategories: ApprovedTemplateCategoryDefinition[] = [];

    for (const definition of APPROVED_TEMPLATE_CATEGORIES) {
      const existing = await this.categories.findCategoryByKey(definition.categoryKey);
      if (!existing) {
        missingCategories.push(definition);
        continue;
      }
      if (!categoryMatches(existing, definition))
        throw new ApplicationError(
          "CATEGORY_CONFLICT",
          `Category ${definition.categoryKey} conflicts with the approved definition`,
        );
      existingCategories.set(definition.categoryKey, existing);
    }

    const existingTemplates = new Map<string, SiteTemplate>();
    for (const manifest of manifests) {
      const existing = await this.templates.findTemplateVersion(
        manifest.templateKey,
        manifest.version,
      );
      if (!existing) continue;
      const category = existingCategories.get(manifest.categoryKey);
      if (!category || !templateMatches(existing, manifest, category.id))
        throw new ApplicationError(
          "TEMPLATE_METADATA_CONFLICT",
          `Template ${manifest.templateKey} v${manifest.version} conflicts with approved metadata`,
        );
      existingTemplates.set(`${manifest.templateKey}:${manifest.version}`, existing);
    }

    const createdCategoryKeys = new Set<string>();
    for (const definition of missingCategories) {
      const timestamp = this.now();
      const category: SiteCategory = {
        id: this.id(),
        ...definition,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      validateSiteCategory(category);
      const created = await this.categories.createCategory(category);
      existingCategories.set(definition.categoryKey, created);
      createdCategoryKeys.add(definition.categoryKey);
    }

    const createdTemplateKeys = new Set<string>();
    for (const manifest of manifests) {
      const identity = `${manifest.templateKey}:${manifest.version}`;
      if (existingTemplates.has(identity)) continue;
      const category = existingCategories.get(manifest.categoryKey);
      if (!category)
        throw new ApplicationError(
          "APPROVED_TEMPLATE_MANIFEST_INVALID",
          `Approved category ${manifest.categoryKey} was not resolved`,
        );
      const timestamp = this.now();
      const template: SiteTemplate = {
        id: this.id(),
        templateKey: manifest.templateKey,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        categoryId: category.id,
        tags: [...manifest.tags],
        status: "draft",
        routes: manifest.routes.map((route) => ({ ...route })),
        previews: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      validateSiteTemplate(template);
      const created = await this.templates.createTemplateVersion(template);
      existingTemplates.set(identity, created);
      createdTemplateKeys.add(identity);
    }

    await this.cache.invalidateTemplateCatalogCache();

    return {
      categoriesCreated: createdCategoryKeys.size,
      categoriesExisting: APPROVED_TEMPLATE_CATEGORIES.length - createdCategoryKeys.size,
      templatesCreated: createdTemplateKeys.size,
      templatesExisting: manifests.length - createdTemplateKeys.size,
      conflicts: 0,
      cacheInvalidated: true,
      categories: APPROVED_TEMPLATE_CATEGORIES.map((definition) => ({
        ...definition,
        created: createdCategoryKeys.has(definition.categoryKey),
        status: "active",
      })),
      templates: manifests.map((manifest) => ({
        templateKey: manifest.templateKey,
        version: manifest.version,
        categoryKey: manifest.categoryKey,
        categoryName:
          APPROVED_TEMPLATE_CATEGORIES.find(
            (category) => category.categoryKey === manifest.categoryKey,
          )?.name ?? manifest.categoryKey,
        status: "draft",
        routeCount: manifest.routes.length,
        tagCount: manifest.tags.length,
        created: createdTemplateKeys.has(`${manifest.templateKey}:${manifest.version}`),
      })),
    };
  }

  async #loadApprovedManifests(templatesRoot: string): Promise<readonly TemplateManifest[]> {
    const manifests: TemplateManifest[] = [];
    for (const templateKey of APPROVED_TEMPLATE_KEYS) {
      let manifest: TemplateManifest;
      try {
        manifest = await this.manifestLoader(join(templatesRoot, templateKey));
      } catch (error) {
        throw new ApplicationError(
          "APPROVED_TEMPLATE_MANIFEST_INVALID",
          `Approved manifest ${templateKey} is invalid`,
          { cause: error },
        );
      }
      if (
        manifest.templateKey !== templateKey ||
        manifest.version !== 1 ||
        manifest.status !== "draft" ||
        manifest.categoryKey !== EXPECTED_CATEGORY_BY_TEMPLATE[templateKey]
      )
        throw new ApplicationError(
          "APPROVED_TEMPLATE_MANIFEST_INVALID",
          `Approved manifest ${templateKey} does not match the frozen registration contract`,
        );
      manifests.push(manifest);
    }
    return manifests;
  }
}
