import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  ActiveTemplateQuery,
  SiteCategoryRepository,
  SiteTemplateRepository,
  TemplateActivationRepository,
  TemplateCategoryRegistrationRepository,
  TemplatePublicationRepository,
  TemplatePage,
} from "../repositories.js";
import type { SiteCategory, SiteTemplate } from "../domain/site-template.js";
import {
  toCategory,
  toTemplate,
  type MongoSiteCategoryRecord,
  type MongoSiteTemplateRecord,
  type MongoTemplateModels,
} from "./mongo-template-models.js";

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const readFailure = (message: string, cause: unknown): never => {
  throw new ApplicationError("PERSISTENCE_READ_FAILED", message, { cause });
};

export class MongoSiteTemplateRepository
  implements SiteTemplateRepository, TemplatePublicationRepository, TemplateActivationRepository
{
  constructor(private readonly models: MongoTemplateModels) {}

  async listActiveTemplates(query: ActiveTemplateQuery): Promise<TemplatePage> {
    try {
      const filter: Record<string, unknown> = { status: "active" };
      if (query.categoryId) filter.categoryId = query.categoryId;
      if (query.tags.length) filter.tags = { $all: [...query.tags] };
      if (query.search) {
        const pattern = new RegExp(escapeRegex(query.search), "i");
        filter.$or = [
          { name: pattern },
          { description: pattern },
          { templateKey: pattern },
          { tags: pattern },
        ];
      }
      const [records, total] = await Promise.all([
        this.models.templates
          .find(filter)
          .sort({ updatedAt: -1, templateKey: 1, version: -1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .lean()
          .exec(),
        this.models.templates.countDocuments(filter).exec(),
      ]);
      return {
        items: records.map(toTemplate),
        total,
      };
    } catch (error) {
      return readFailure("Unable to read the site template catalog", error);
    }
  }

  async findTemplateVersion(
    templateKey: string,
    version: number,
  ): Promise<SiteTemplate | undefined> {
    try {
      const record = await this.models.templates.findOne({ templateKey, version }).lean().exec();
      return record ? toTemplate(record) : undefined;
    } catch (error) {
      return readFailure("Unable to read the requested site template version", error);
    }
  }

  async findLatestActiveTemplate(templateKey: string): Promise<SiteTemplate | undefined> {
    try {
      const record = await this.models.templates
        .findOne({ templateKey, status: "active" })
        .sort({ version: -1 })
        .lean()
        .exec();
      return record ? toTemplate(record) : undefined;
    } catch (error) {
      return readFailure("Unable to resolve the latest active site template", error);
    }
  }

  async findById(id: string): Promise<SiteTemplate | undefined> {
    try {
      const record = await this.models.templates.findById(id).lean().exec();
      return record ? toTemplate(record) : undefined;
    } catch (error) {
      return readFailure("Unable to read the requested site template", error);
    }
  }

  async createTemplateVersion(template: SiteTemplate): Promise<SiteTemplate> {
    try {
      const record = await this.models.templates.create({
        _id: template.id,
        templateKey: template.templateKey,
        version: template.version,
        name: template.name,
        description: template.description,
        categoryId: template.categoryId,
        tags: [...template.tags],
        status: template.status,
        routes: template.routes.map((route) => ({ ...route })),
        ...(template.sourceObject ? { sourceObject: template.sourceObject } : {}),
        ...(template.sourceSha256 ? { sourceSha256: template.sourceSha256 } : {}),
        previews: { ...template.previews },
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      });
      return toTemplate(record.toObject<MongoSiteTemplateRecord>());
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 11000)
        throw new ApplicationError(
          "TEMPLATE_VERSION_EXISTS",
          `Template ${template.templateKey} v${template.version} already exists`,
          { cause: error },
        );
      throw new ApplicationError("TEMPLATE_PERSIST_FAILED", "Unable to publish site template", {
        cause: error,
      });
    }
  }

  async activateTemplateVersion(template: SiteTemplate): Promise<SiteTemplate> {
    try {
      const record = await this.models.templates
        .findOneAndUpdate(
          {
            templateKey: template.templateKey,
            version: template.version,
            status: "draft",
            sourceObject: { $exists: false },
            sourceSha256: { $exists: false },
            "previews.desktop": { $exists: false },
            "previews.tablet": { $exists: false },
            "previews.mobile": { $exists: false },
          },
          {
            $set: {
              sourceObject: template.sourceObject,
              sourceSha256: template.sourceSha256,
              previews: { ...template.previews },
              status: "active",
            },
          },
          { returnDocument: "after", runValidators: true },
        )
        .lean()
        .exec();
      if (record) return toTemplate(record);

      const existing = await this.models.templates
        .findOne({ templateKey: template.templateKey, version: template.version })
        .lean()
        .exec();
      if (
        existing?.status === "active" &&
        existing.sourceObject === template.sourceObject &&
        existing.sourceSha256 === template.sourceSha256 &&
        existing.previews.desktop === template.previews.desktop &&
        existing.previews.tablet === template.previews.tablet &&
        existing.previews.mobile === template.previews.mobile
      )
        return toTemplate(existing);
      throw new ApplicationError(
        "TEMPLATE_METADATA_CONFLICT",
        `Template ${template.templateKey} v${template.version} cannot be activated safely`,
      );
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "TEMPLATE_PERSIST_FAILED",
        "Unable to activate site template",
        { cause: error },
      );
    }
  }
}

export class MongoSiteCategoryRepository
  implements SiteCategoryRepository, TemplateCategoryRegistrationRepository
{
  constructor(private readonly models: MongoTemplateModels) {}

  async listActiveCategories(): Promise<readonly SiteCategory[]> {
    try {
      const records = await this.models.categories
        .find({ status: "active" })
        .sort({ sortOrder: 1, categoryKey: 1 })
        .lean()
        .exec();
      return records.map(toCategory);
    } catch (error) {
      return readFailure("Unable to read the site category catalog", error);
    }
  }

  async findCategoryByKey(categoryKey: string): Promise<SiteCategory | undefined> {
    try {
      const record = await this.models.categories.findOne({ categoryKey }).lean().exec();
      return record ? toCategory(record) : undefined;
    } catch (error) {
      return readFailure("Unable to read the requested site category", error);
    }
  }


  async createCategory(category: SiteCategory): Promise<SiteCategory> {
    try {
      const record = await this.models.categories.create({
        _id: category.id,
        categoryKey: category.categoryKey,
        name: category.name,
        description: category.description,
        status: category.status,
        sortOrder: category.sortOrder,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      });
      return toCategory(record.toObject<MongoSiteCategoryRecord>());
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 11000)
        throw new ApplicationError(
          "CATEGORY_CONFLICT",
          `Category ${category.categoryKey} already exists`,
          { cause: error },
        );
      throw new ApplicationError(
        "PERSISTENCE_WRITE_FAILED",
        "Unable to create site template category",
        { cause: error },
      );
    }
  }
}
