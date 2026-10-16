import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  isSiteCatalogKey,
  SITE_TEMPLATE_STATUSES,
  validateSiteTemplate,
  type SiteTemplateRoute,
  type SiteTemplateStatus,
} from "../domain/site-template.js";

export const TEMPLATE_MANIFEST_FILE = "site-template.json";

export interface TemplateManifest {
  readonly templateKey: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly categoryKey: string;
  readonly tags: readonly string[];
  readonly status: SiteTemplateStatus;
  readonly routes: readonly SiteTemplateRoute[];
}

const ALLOWED_FIELDS = new Set([
  "templateKey",
  "version",
  "name",
  "description",
  "categoryKey",
  "tags",
  "status",
  "routes",
]);
const ROUTE_FIELDS = new Set(["path", "label"]);

const manifestError = (message: string, cause?: unknown): ApplicationError =>
  new ApplicationError("MANIFEST_INVALID", message, cause === undefined ? {} : { cause });

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw manifestError(`${context} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw manifestError(`${field} must be a string`);
  return value;
}

function routes(value: unknown): readonly SiteTemplateRoute[] {
  if (!Array.isArray(value)) throw manifestError("routes must be an array");
  return value.map((item, index) => {
    const route = record(item, `routes[${index}]`);
    const unexpected = Object.keys(route).find((field) => !ROUTE_FIELDS.has(field));
    if (unexpected) throw manifestError(`routes[${index}] contains forbidden field: ${unexpected}`);
    return {
      path: text(route.path, `routes[${index}].path`),
      label: text(route.label, `routes[${index}].label`),
    };
  });
}

export function parseTemplateManifest(value: unknown): TemplateManifest {
  const input = record(value, "site-template.json");
  const unexpected = Object.keys(input).find((field) => !ALLOWED_FIELDS.has(field));
  if (unexpected) throw manifestError(`site-template.json contains forbidden field: ${unexpected}`);
  const status = text(input.status, "status");
  if (!SITE_TEMPLATE_STATUSES.includes(status as SiteTemplateStatus))
    throw manifestError("status is invalid");
  if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))
    throw manifestError("tags must be an array of strings");
  if (typeof input.version !== "number") throw manifestError("version must be a number");
  const manifest: TemplateManifest = {
    templateKey: text(input.templateKey, "templateKey"),
    version: input.version,
    name: text(input.name, "name"),
    description: text(input.description, "description"),
    categoryKey: text(input.categoryKey, "categoryKey"),
    tags: input.tags as string[],
    status: status as SiteTemplateStatus,
    routes: routes(input.routes),
  };
  if (!isSiteCatalogKey(manifest.categoryKey))
    throw manifestError("categoryKey must be lowercase and URL-safe");
  try {
    validateSiteTemplate({
      id: "manifest-validation",
      templateKey: manifest.templateKey,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description,
      categoryId: "publisher-category-placeholder",
      tags: manifest.tags,
      status: manifest.status,
      routes: manifest.routes,
      ...(manifest.status === "active"
        ? {
            sourceObject: "sites/templates/publisher-validation/v1/source/template.zip",
            sourceSha256: "0".repeat(64),
            previews: {
              desktop: "sites/templates/publisher-validation/v1/previews/desktop.webp",
              tablet: "sites/templates/publisher-validation/v1/previews/tablet.webp",
              mobile: "sites/templates/publisher-validation/v1/previews/mobile.webp",
            },
          }
        : { previews: {} }),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  } catch (error) {
    throw manifestError(
      error instanceof Error ? error.message : "manifest validation failed",
      error,
    );
  }
  return manifest;
}

export async function loadTemplateManifest(directory: string): Promise<TemplateManifest> {
  try {
    const contents = await readFile(join(directory, TEMPLATE_MANIFEST_FILE), "utf8");
    return parseTemplateManifest(JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "MANIFEST_INVALID") throw error;
    throw manifestError(`Unable to read ${TEMPLATE_MANIFEST_FILE}`, error);
  }
}
