import { ApplicationError } from "../../app/errors/application-error.js";
import { isSiteCatalogKey, isSiteCatalogTag } from "../domain/site-template.js";

export interface TemplateCatalogQuery {
  readonly category?: string;
  readonly search?: string;
  readonly tags: readonly string[];
  readonly page: number;
  readonly limit: number;
}

const integer = (
  value: string | null,
  fallback: number,
  field: string,
  maximum?: number,
): number => {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) invalid(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum))
    invalid(`${field} must be between 1 and ${maximum ?? Number.MAX_SAFE_INTEGER}`);
  return parsed;
};

const invalid = (message: string): never => {
  throw new ApplicationError("VALIDATION_FAILED", message);
};

export function parseTemplateCatalogQuery(parameters: URLSearchParams): TemplateCatalogQuery {
  const category = parameters.get("category")?.trim();
  if (category && !isSiteCatalogKey(category)) invalid("category must be lowercase and URL-safe");
  const search = parameters.get("search")?.trim();
  if (search && search.length > 100) invalid("search must not exceed 100 characters");
  const tags = [
    ...new Set(
      parameters
        .getAll("tags")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (tags.length > 10 || tags.some((tag) => !isSiteCatalogTag(tag)))
    invalid("tags must contain at most 10 lowercase URL-safe values");
  return {
    ...(category ? { category } : {}),
    ...(search ? { search } : {}),
    tags,
    page: integer(parameters.get("page"), 1, "page"),
    limit: integer(parameters.get("limit"), 24, "limit", 100),
  };
}

export function parseTemplateVersion(parameters: URLSearchParams): number | undefined {
  const raw = parameters.get("version");
  return raw === null ? undefined : integer(raw, 1, "version");
}

export function validateTemplateKey(value: string): string {
  if (!isSiteCatalogKey(value)) invalid("templateKey must be lowercase and URL-safe");
  return value;
}
