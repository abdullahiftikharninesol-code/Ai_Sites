import { ApplicationError } from "../../app/errors/application-error.js";

export const SITE_TEMPLATE_STATUSES = ["draft", "active", "archived"] as const;
export type SiteTemplateStatus = (typeof SITE_TEMPLATE_STATUSES)[number];

export interface SiteTemplateRoute {
  readonly path: string;
  readonly label: string;
}

export interface SiteTemplatePreviews {
  readonly desktop?: string;
  readonly tablet?: string;
  readonly mobile?: string;
}

export interface SiteTemplate {
  readonly id: string;
  readonly templateKey: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly categoryId: string;
  readonly tags: readonly string[];
  readonly status: SiteTemplateStatus;
  readonly routes: readonly SiteTemplateRoute[];
  readonly sourceObject?: string;
  readonly sourceSha256?: string;
  readonly previews: SiteTemplatePreviews;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SiteCategory {
  readonly id: string;
  readonly categoryKey: string;
  readonly name: string;
  readonly description: string;
  readonly status: SiteTemplateStatus;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PublicSiteTemplate {
  readonly id: string;
  readonly templateKey: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly categoryId: string;
  readonly tags: readonly string[];
  readonly routes: readonly SiteTemplateRoute[];
  readonly previews: SiteTemplatePreviews;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicSiteCategory {
  readonly id: string;
  readonly categoryKey: string;
  readonly name: string;
  readonly description: string;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const requiredText = (value: string, field: string, maximum: number): void => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new ApplicationError(
      "VALIDATION_FAILED",
      `${field} is required and must not exceed ${maximum} characters`,
    );
};

export function validateSiteTemplate(template: SiteTemplate): void {
  if (!KEY_PATTERN.test(template.templateKey))
    throw new ApplicationError("VALIDATION_FAILED", "templateKey must be lowercase and URL-safe");
  if (!Number.isSafeInteger(template.version) || template.version < 1)
    throw new ApplicationError("VALIDATION_FAILED", "version must be a positive integer");
  requiredText(template.name, "name", 120);
  requiredText(template.description, "description", 2_000);
  requiredText(template.categoryId, "categoryId", 128);
  if (!SITE_TEMPLATE_STATUSES.includes(template.status))
    throw new ApplicationError("VALIDATION_FAILED", "status is invalid");
  if (template.tags.length > 20)
    throw new ApplicationError("VALIDATION_FAILED", "tags must contain at most 20 values");
  if (
    new Set(template.tags).size !== template.tags.length ||
    template.tags.some((tag) => !TAG_PATTERN.test(tag))
  )
    throw new ApplicationError("VALIDATION_FAILED", "tags must be unique, lowercase, and URL-safe");
  if (template.routes.length === 0 || template.routes.length > 50)
    throw new ApplicationError("VALIDATION_FAILED", "routes must contain between 1 and 50 entries");
  const paths = new Set<string>();
  for (const route of template.routes) {
    if (!route.path.startsWith("/") || route.path.length > 200)
      throw new ApplicationError("VALIDATION_FAILED", "route paths must start with /");
    if (paths.has(route.path))
      throw new ApplicationError("VALIDATION_FAILED", `duplicate route path: ${route.path}`);
    paths.add(route.path);
    requiredText(route.label, "route label", 80);
  }
  const hasSourceObject = template.sourceObject !== undefined;
  const hasSourceSha256 = template.sourceSha256 !== undefined;
  if (hasSourceObject !== hasSourceSha256)
    throw new ApplicationError(
      "VALIDATION_FAILED",
      "sourceObject and sourceSha256 must be provided together",
    );
  if (template.sourceObject) validateObjectPath(template.sourceObject, "sourceObject");
  if (template.sourceSha256 && !SHA256_PATTERN.test(template.sourceSha256))
    throw new ApplicationError("VALIDATION_FAILED", "sourceSha256 must be a SHA-256 digest");
  for (const [name, preview] of [
    ["desktop", template.previews.desktop],
    ["tablet", template.previews.tablet],
    ["mobile", template.previews.mobile],
  ] as const)
    if (preview) validateObjectPath(preview, `previews.${name}`);
  if (
    template.status === "active" &&
    (!template.sourceObject ||
      !template.sourceSha256 ||
      !template.previews.desktop ||
      !template.previews.tablet ||
      !template.previews.mobile)
  )
    throw new ApplicationError(
      "VALIDATION_FAILED",
      "active templates require sourceObject, sourceSha256, and all preview object paths",
    );
}

export function validateSiteCategory(category: SiteCategory): void {
  if (!KEY_PATTERN.test(category.categoryKey))
    throw new ApplicationError("VALIDATION_FAILED", "categoryKey must be lowercase and URL-safe");
  requiredText(category.name, "name", 120);
  requiredText(category.description, "description", 2_000);
  if (!SITE_TEMPLATE_STATUSES.includes(category.status))
    throw new ApplicationError("VALIDATION_FAILED", "status is invalid");
  if (!Number.isSafeInteger(category.sortOrder))
    throw new ApplicationError("VALIDATION_FAILED", "sortOrder must be an integer");
}

function validateObjectPath(value: string, field: string): void {
  requiredText(value, field, 1_024);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("://") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new ApplicationError("VALIDATION_FAILED", `${field} must be a safe GCS object path`);
}

function publicPreviewUrl(bucket: string, object: string): string {
  if (!bucket.trim())
    throw new ApplicationError(
      "PROVIDER_CONFIGURATION_ERROR",
      "SITES_TEMPLATE_GCS_BUCKET is required to resolve template previews",
    );
  const encodedObject = object.split("/").map(encodeURIComponent).join("/");
  return `https://storage.googleapis.com/${encodeURIComponent(bucket.trim())}/${encodedObject}`;
}

export function toPublicSiteTemplate(
  template: SiteTemplate,
  previewBucket: string,
): PublicSiteTemplate {
  const previews: SiteTemplatePreviews = {
    ...(template.previews.desktop
      ? { desktop: publicPreviewUrl(previewBucket, template.previews.desktop) }
      : {}),
    ...(template.previews.tablet
      ? { tablet: publicPreviewUrl(previewBucket, template.previews.tablet) }
      : {}),
    ...(template.previews.mobile
      ? { mobile: publicPreviewUrl(previewBucket, template.previews.mobile) }
      : {}),
  };
  return {
    id: template.id,
    templateKey: template.templateKey,
    version: template.version,
    name: template.name,
    description: template.description,
    categoryId: template.categoryId,
    tags: [...template.tags],
    routes: template.routes.map((route) => ({ ...route })),
    previews,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

export function toPublicSiteCategory(category: SiteCategory): PublicSiteCategory {
  return {
    id: category.id,
    categoryKey: category.categoryKey,
    name: category.name,
    description: category.description,
    sortOrder: category.sortOrder,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

export function isSiteCatalogKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function isSiteCatalogTag(value: string): boolean {
  return TAG_PATTERN.test(value);
}
