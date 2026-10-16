import { randomUUID } from "node:crypto";
import { Schema, type Connection, type Model } from "mongoose";
import {
  SITE_TEMPLATE_STATUSES,
  validateSiteCategory,
  validateSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
  type SiteTemplatePreviews,
  type SiteTemplateRoute,
  type SiteTemplateStatus,
} from "../domain/site-template.js";

export interface MongoSiteTemplateRecord {
  _id: string;
  templateKey: string;
  version: number;
  name: string;
  description: string;
  categoryId: string;
  tags: string[];
  status: SiteTemplateStatus;
  routes: SiteTemplateRoute[];
  sourceObject?: string;
  sourceSha256?: string;
  previews: SiteTemplatePreviews;
  createdAt: Date;
  updatedAt: Date;
}

export interface MongoSiteCategoryRecord {
  _id: string;
  categoryKey: string;
  name: string;
  description: string;
  status: SiteTemplateStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MongoTemplateModels {
  readonly templates: Model<MongoSiteTemplateRecord>;
  readonly categories: Model<MongoSiteCategoryRecord>;
}

const routeSchema = new Schema<SiteTemplateRoute>(
  {
    path: { type: String, required: true, maxlength: 200 },
    label: { type: String, required: true, maxlength: 80 },
  },
  { _id: false, versionKey: false, strict: "throw" },
);

const templateSchema = new Schema<MongoSiteTemplateRecord>(
  {
    _id: { type: String, required: true, immutable: true, default: () => randomUUID() },
    templateKey: { type: String, required: true, immutable: true, maxlength: 120 },
    version: { type: Number, required: true, immutable: true, min: 1 },
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, required: true, maxlength: 2_000 },
    categoryId: { type: String, required: true, maxlength: 128 },
    tags: { type: [String], required: true, default: [] },
    status: { type: String, required: true, enum: SITE_TEMPLATE_STATUSES, default: "draft" },
    routes: { type: [routeSchema], required: true },
    sourceObject: { type: String, required: false, maxlength: 1_024 },
    sourceSha256: { type: String, required: false, maxlength: 64 },
    previews: {
      type: new Schema<SiteTemplatePreviews>(
        {
          desktop: { type: String, maxlength: 1_024 },
          tablet: { type: String, maxlength: 1_024 },
          mobile: { type: String, maxlength: 1_024 },
        },
        { _id: false, versionKey: false, strict: "throw" },
      ),
      required: true,
      default: {},
    },
    createdAt: { type: Date, required: true, default: Date.now },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: "sites_templates", timestamps: true, versionKey: false, strict: "throw" },
);
templateSchema.index({ templateKey: 1, version: 1 }, { unique: true });
templateSchema.index({ status: 1 });
templateSchema.index({ categoryId: 1 });
templateSchema.index({ updatedAt: -1 });
templateSchema.pre("validate", function validateTemplateDocument() {
  validateSiteTemplate(toTemplate(this));
});

const categorySchema = new Schema<MongoSiteCategoryRecord>(
  {
    _id: { type: String, required: true, immutable: true, default: () => randomUUID() },
    categoryKey: { type: String, required: true, immutable: true, maxlength: 120 },
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, required: true, maxlength: 2_000 },
    status: { type: String, required: true, enum: SITE_TEMPLATE_STATUSES, default: "draft" },
    sortOrder: { type: Number, required: true, default: 0 },
    createdAt: { type: Date, required: true, default: Date.now },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: "sites_categories", timestamps: true, versionKey: false, strict: "throw" },
);
categorySchema.index({ categoryKey: 1 }, { unique: true });
categorySchema.index({ status: 1 });
categorySchema.index({ sortOrder: 1 });
categorySchema.pre("validate", function validateCategoryDocument() {
  validateSiteCategory(toCategory(this));
});

export function toTemplate(record: MongoSiteTemplateRecord): SiteTemplate {
  return {
    id: String(record._id),
    templateKey: record.templateKey,
    version: record.version,
    name: record.name,
    description: record.description,
    categoryId: record.categoryId,
    tags: [...record.tags],
    status: record.status,
    routes: record.routes.map((route) => ({ path: route.path, label: route.label })),
    ...(record.sourceObject ? { sourceObject: record.sourceObject } : {}),
    ...(record.sourceSha256 ? { sourceSha256: record.sourceSha256 } : {}),
    previews: {
      ...(record.previews.desktop ? { desktop: record.previews.desktop } : {}),
      ...(record.previews.tablet ? { tablet: record.previews.tablet } : {}),
      ...(record.previews.mobile ? { mobile: record.previews.mobile } : {}),
    },
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function toCategory(record: MongoSiteCategoryRecord): SiteCategory {
  return {
    id: String(record._id),
    categoryKey: record.categoryKey,
    name: record.name,
    description: record.description,
    status: record.status,
    sortOrder: record.sortOrder,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function createMongoTemplateModels(connection: Connection): MongoTemplateModels {
  return {
    templates:
      (connection.models.SitesTemplate as Model<MongoSiteTemplateRecord> | undefined) ??
      connection.model<MongoSiteTemplateRecord>("SitesTemplate", templateSchema),
    categories:
      (connection.models.SitesCategory as Model<MongoSiteCategoryRecord> | undefined) ??
      connection.model<MongoSiteCategoryRecord>("SitesCategory", categorySchema),
  };
}
