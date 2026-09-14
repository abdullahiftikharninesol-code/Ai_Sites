import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteRuntimeSpec } from "../../site-runtime/runtime-types.js";
import type {
  SiteAuthSpec,
  SiteContentPlan,
  SiteIntegrationSpec,
} from "../../agents/intelligence/intelligence-types.js";
import { SiteRuntimeSpecValidator } from "../../site-runtime/runtime-validator.js";

export interface SitePageSpec {
  readonly name: string;
  readonly path: string;
  readonly purpose?: string;
}

export interface SiteSpec {
  readonly runtime?: SiteRuntimeSpec;
  readonly auth?: SiteAuthSpec;
  readonly integrations?: SiteIntegrationSpec;
  readonly content?: SiteContentPlan;
  readonly project: { readonly name: string; readonly description?: string };
  readonly requirements: {
    readonly siteType: string;
    readonly pages: readonly SitePageSpec[];
    readonly features: readonly string[];
  };
  readonly design: {
    readonly style?: string;
    readonly theme?: string;
    readonly typography?: Readonly<Record<string, unknown>>;
    readonly colors?: Readonly<Record<string, string>>;
    readonly spacing?: Readonly<Record<string, string>>;
  };
  readonly technical: {
    readonly framework: string;
    readonly language: string;
    readonly styling: string;
    readonly profileId?: string;
    readonly bundler?: string;
    readonly packageManager?: string;
  };
}

export function validateSiteSpec(value: unknown): SiteSpec {
  if (!value || typeof value !== "object") return invalid("SiteSpec must be an object");
  const spec = value as Partial<SiteSpec>;
  if (!spec.project?.name?.trim()) return invalid("Project name is required");
  if (!spec.requirements?.siteType?.trim()) return invalid("Site type is required");
  if (!Array.isArray(spec.requirements.pages) || spec.requirements.pages.length === 0)
    return invalid("At least one page is required");
  const paths = new Set<string>();
  for (const candidate of spec.requirements.pages as readonly unknown[]) {
    if (!candidate || typeof candidate !== "object") return invalid("Each page must be an object");
    const page = candidate as { readonly name?: unknown; readonly path?: unknown };
    if (
      typeof page.name !== "string" ||
      !page.name.trim() ||
      typeof page.path !== "string" ||
      !page.path.startsWith("/")
    )
      return invalid("Page name and absolute path are required");
    if (paths.has(page.path)) return invalid(`Duplicate page path: ${page.path}`);
    paths.add(page.path);
  }
  if (
    !spec.technical?.framework?.trim() ||
    !spec.technical.language?.trim() ||
    !spec.technical.styling?.trim()
  )
    return invalid("Technical choices are required");
  if (spec.runtime) new SiteRuntimeSpecValidator().validate(spec.runtime);
  return spec as SiteSpec;
}

function invalid(message: string): never {
  throw new ApplicationError("VALIDATION_FAILED", message);
}
