import type { SiteSpec } from "./site-spec.js";
import { canonicalizeIdentifier } from "../../agents/validation/generation-completion.js";
import type { GenerationCompletionRequirements } from "../../agents/validation/generation-completion.js";

/**
 * Compact model-facing projection of the canonical SiteSpec for website generation.
 *
 * Excluded fields and safety rationale:
 * 1. `runtime` (SiteRuntimeSpec): Contains orchestrator-only configuration such as local
 *    preview ports, container images, and runtime runner flags. Generated frontend code
 *    has no use for runner infrastructure settings.
 * 2. `technical.profileId`: Internal Sites configuration identifier, irrelevant to code generation.
 * 3. `technical.bundler` & `technical.packageManager`: Fixed deterministically by the Sites
 *    scaffold (Vite + npm). Stated clearly in the compact runtime contract instead.
 *
 * Retained fields (lossless for frontend generation):
 * - Project name & description
 * - Site type
 * - Canonical pages and sections
 * - Full content plan, copy, headlines, testimonials, brand voice
 * - Full design tokens (colors, typography, theme, style, spacing)
 * - Features and functional requirements
 * - Integrations & authentication specifications
 */
export interface GenerationSiteSpec {
  readonly project: {
    readonly name: string;
    readonly description?: string | undefined;
  };
  readonly siteType: string;
  readonly pages: readonly {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly purpose?: string | undefined;
  }[];
  readonly sections: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly features: readonly string[];
  readonly design: SiteSpec["design"];
  readonly content?: SiteSpec["content"] | undefined;
  readonly technical: {
    readonly framework: string;
    readonly language: string;
    readonly styling: string;
  };
  readonly integrations?: SiteSpec["integrations"] | undefined;
  readonly auth?: SiteSpec["auth"] | undefined;
}

/**
 * Transforms a canonical SiteSpec into a compact, model-focused GenerationSiteSpec projection.
 */
export function toGenerationSiteSpec(
  spec: SiteSpec,
  requirements?: GenerationCompletionRequirements | undefined,
): GenerationSiteSpec {
  const pages = (spec.requirements?.pages ?? []).map((p) => {
    const id = canonicalizeIdentifier(p.name || p.path || "home");
    return {
      id,
      name: p.name,
      path: p.path,
      ...(p.purpose ? { purpose: p.purpose } : {}),
    };
  });

  const sectionIds = new Set<string>();
  if (spec.content?.sectionCopy) {
    for (const key of Object.keys(spec.content.sectionCopy)) {
      sectionIds.add(key);
    }
  }
  if (requirements?.requiredSections) {
    for (const s of requirements.requiredSections) {
      sectionIds.add(s);
    }
  }

  const sections = Array.from(sectionIds).map((name) => {
    const id = canonicalizeIdentifier(name);
    return {
      id,
      name,
    };
  });

  return {
    project: {
      name: spec.project.name,
      ...(spec.project.description ? { description: spec.project.description } : {}),
    },
    siteType: spec.requirements.siteType,
    pages,
    sections,
    features: spec.requirements.features ?? [],
    design: spec.design,
    ...(spec.content ? { content: spec.content } : {}),
    technical: {
      framework: spec.technical.framework,
      language: spec.technical.language,
      styling: spec.technical.styling,
    },
    ...(spec.integrations ? { integrations: spec.integrations } : {}),
    ...(spec.auth ? { auth: spec.auth } : {}),
  };
}
