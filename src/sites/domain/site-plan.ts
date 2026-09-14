import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteRuntimeSpec } from "../../site-runtime/runtime-types.js";
import { SiteRuntimeSpecValidator } from "../../site-runtime/runtime-validator.js";
import type {
  SiteAuthSpec,
  SiteCapabilityPlan,
  SiteContentPlan,
  SiteEditPlan,
  SiteIntegrationSpec,
  SiteIntent,
  SiteIntentResult,
  SitePlanningBundle,
} from "../../agents/intelligence/intelligence-types.js";
import { IntelligenceValidators } from "../../agents/intelligence/intelligence-validators.js";
import { SITE_INTENTS } from "../../agents/intelligence/intelligence-types.js";
import type { SiteDesignSpec, SiteRequirementSpec } from "../../planning/planning.js";
import type { SitePageSpec, SiteSpec } from "./site-spec.js";
import { validateSiteSpec } from "./site-spec.js";
import { getDefaultProfile } from "../../cli/runtime/site-technical-profile.js";

export interface SitePlanIntent {
  readonly type: SiteIntent;
  readonly confidence?: number;
  readonly reason?: string;
}

export interface SitePlanMetadata {
  readonly category?: string;
  readonly name?: string;
  readonly purpose?: string;
  readonly targetAudience?: string;
}

export interface SitePlanRequirements {
  readonly pages: readonly SitePageSpec[];
  readonly features: readonly string[];
  readonly constraints?: readonly string[];
  readonly responsiveRequirements?: readonly string[];
  readonly contentRequirements?: readonly string[];
  readonly sections?: readonly string[];
}

export interface SitePlanDesign {
  readonly direction: string;
  readonly tone?: string;
  readonly layout?: string;
  readonly colorDirection?: string;
  readonly typographyDirection?: string;
  readonly responsiveness: boolean;
  readonly style?: string;
  readonly theme?: string;
  readonly colors?: Readonly<Record<string, string>>;
  readonly typography?: Readonly<Record<string, string>>;
  readonly spacing?: Readonly<Record<string, string>>;
  readonly layoutDirection?: "LTR" | "RTL";
  readonly responsiveStrategy?: string;
}

export interface SitePlanImplementation {
  readonly framework: "react-vite";
  readonly language: "typescript";
  readonly stylingStrategy: string;
}

export interface SitePlan {
  readonly intent: SitePlanIntent;
  readonly site: SitePlanMetadata;
  readonly requirements: SitePlanRequirements;
  readonly design: SitePlanDesign;
  readonly implementation: SitePlanImplementation;
  readonly capabilities?: SiteCapabilityPlan;
  readonly content?: SiteContentPlan;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string, max = 500): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    invalid(`${label} is required and must be under ${max} characters`);
  return value.trim();
};

const optionalText = (value: unknown, label: string, max = 500): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max)
    invalid(`${label} must be under ${max} characters`);
  return value.trim() || undefined;
};

const strings = (value: unknown, label: string, max = 32): string[] => {
  if (!Array.isArray(value) || value.length > max)
    invalid(`${label} must be a bounded array (max ${max})`);
  const output: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "string") invalid(`${label} must contain only strings`);
    if (item.trim()) output.push(item.trim());
  }
  return output;
};

export function validateSitePlan(value: unknown): SitePlan {
  const root = object(value, "SitePlan");
  const rawIntent = object(root.intent ?? { type: "CREATE_SITE" }, "SitePlan.intent");
  const rawIntentType = String(rawIntent.type ?? "CREATE_SITE");
  if (!SITE_INTENTS.includes(rawIntentType as SiteIntent)) {
    invalid(`Unsupported site intent: ${rawIntentType}`);
  }
  const reason = optionalText(rawIntent.reason, "intent reason", 300);
  const intent: SitePlanIntent = {
    type: rawIntentType as SiteIntent,
    ...(typeof rawIntent.confidence === "number"
      ? { confidence: Math.max(0, Math.min(1, rawIntent.confidence)) }
      : { confidence: 0.95 }),
    ...(reason ? { reason } : {}),
  };

  const rawSite = object(root.site ?? {}, "SitePlan.site");
  const category = optionalText(rawSite.category, "site category", 80);
  const siteName = optionalText(rawSite.name, "site name", 120);
  const purpose = optionalText(rawSite.purpose, "site purpose", 500);
  const targetAudience = optionalText(rawSite.targetAudience, "site targetAudience", 500);
  const site: SitePlanMetadata = {
    ...(category ? { category } : {}),
    ...(siteName ? { name: siteName } : {}),
    ...(purpose ? { purpose } : {}),
    ...(targetAudience ? { targetAudience } : {}),
  };

  const rawReq = object(root.requirements, "SitePlan.requirements");
  const rawPages = Array.isArray(rawReq.pages) ? rawReq.pages : invalid("Pages must be an array");
  if (rawPages.length < 1 || rawPages.length > 16)
    invalid("SitePlan must specify between 1 and 16 pages");
  const paths = new Set<string>();
  const pages: SitePageSpec[] = rawPages.map((candidate) => {
    const page = object(candidate, "page");
    const path = text(page.path, "page path", 100);
    if (!path.startsWith("/") || path.includes("..") || paths.has(path))
      invalid(`Invalid or duplicate page path: ${path}`);
    paths.add(path);
    const pagePurpose = optionalText(page.purpose, "page purpose", 240);
    return {
      name: text(page.name, "page name", 80),
      path,
      ...(pagePurpose ? { purpose: pagePurpose } : {}),
    };
  });

  const requirements: SitePlanRequirements = {
    pages,
    features: strings(rawReq.features ?? [], "features", 32),
    ...(Array.isArray(rawReq.constraints)
      ? { constraints: strings(rawReq.constraints, "constraints", 16) }
      : {}),
    ...(Array.isArray(rawReq.responsiveRequirements)
      ? {
          responsiveRequirements: strings(
            rawReq.responsiveRequirements,
            "responsiveRequirements",
            8,
          ),
        }
      : {}),
    ...(Array.isArray(rawReq.contentRequirements)
      ? { contentRequirements: strings(rawReq.contentRequirements, "contentRequirements", 24) }
      : {}),
    ...(Array.isArray(rawReq.sections)
      ? { sections: strings(rawReq.sections, "sections", 24) }
      : {}),
  };

  const rawDesign = object(root.design, "SitePlan.design");
  const colorsRecord: Record<string, string> = {};
  if (rawDesign.colors && typeof rawDesign.colors === "object") {
    for (const [k, v] of Object.entries(rawDesign.colors as Record<string, unknown>)) {
      if (typeof v === "string") colorsRecord[k.slice(0, 40)] = v.slice(0, 60);
    }
  }
  const typographyRecord: Record<string, string> = {};
  if (rawDesign.typography && typeof rawDesign.typography === "object") {
    for (const [k, v] of Object.entries(rawDesign.typography as Record<string, unknown>)) {
      if (typeof v === "string") typographyRecord[k.slice(0, 40)] = v.slice(0, 80);
    }
  }
  const spacingRecord: Record<string, string> = {};
  if (rawDesign.spacing && typeof rawDesign.spacing === "object") {
    for (const [k, v] of Object.entries(rawDesign.spacing as Record<string, unknown>)) {
      if (typeof v === "string") spacingRecord[k.slice(0, 40)] = v.slice(0, 60);
    }
  }

  const tone = optionalText(rawDesign.tone, "design tone", 120);
  const layout = optionalText(rawDesign.layout, "design layout", 120);
  const colorDirection = optionalText(rawDesign.colorDirection, "design colorDirection", 120);
  const typographyDirection = optionalText(
    rawDesign.typographyDirection,
    "design typographyDirection",
    120,
  );
  const design: SitePlanDesign = {
    direction: text(rawDesign.direction ?? rawDesign.style ?? "modern", "design direction", 120),
    ...(tone ? { tone } : {}),
    ...(layout ? { layout } : {}),
    ...(colorDirection ? { colorDirection } : {}),
    ...(typographyDirection ? { typographyDirection } : {}),
    responsiveness: typeof rawDesign.responsiveness === "boolean" ? rawDesign.responsiveness : true,
    style: optionalText(rawDesign.style, "design style", 60) ?? "modern",
    theme: optionalText(rawDesign.theme, "design theme", 60) ?? "light",
    colors: Object.keys(colorsRecord).length
      ? colorsRecord
      : { primary: "#2563eb", background: "#ffffff", text: "#111827" },
    typography: Object.keys(typographyRecord).length
      ? typographyRecord
      : { heading: "system-ui", body: "system-ui" },
    spacing: Object.keys(spacingRecord).length
      ? spacingRecord
      : { section: "4rem", content: "1.5rem" },
    layoutDirection: rawDesign.layoutDirection === "RTL" ? "RTL" : "LTR",
    responsiveStrategy:
      optionalText(rawDesign.responsiveStrategy, "responsiveStrategy", 120) ?? "mobile-first",
  };

  const rawImpl = object(root.implementation ?? {}, "SitePlan.implementation");
  const implementation: SitePlanImplementation = {
    framework: "react-vite",
    language: "typescript",
    stylingStrategy: optionalText(rawImpl.stylingStrategy, "stylingStrategy", 80) ?? "plain-css",
  };

  let capabilities: SiteCapabilityPlan | undefined;
  if (root.capabilities && typeof root.capabilities === "object") {
    const caps = root.capabilities as Record<string, unknown>;
    const runtime = caps.runtime
      ? new SiteRuntimeSpecValidator().validate(caps.runtime as SiteRuntimeSpec)
      : { enabled: false, collections: [] };
    capabilities = {
      runtime,
      auth: (caps.auth as SiteAuthSpec) ?? {
        authRequired: false,
        publicPages: pages.map((p) => p.path),
        protectedPages: [],
        capabilities: [],
        ownerCollections: [],
      },
      integrations: (caps.integrations as SiteIntegrationSpec) ?? { actions: [] },
    };
  }

  let content: SiteContentPlan | undefined;
  if (root.content && typeof root.content === "object") {
    const rawContent = root.content as Record<string, unknown>;
    content = {
      headline:
        optionalText(rawContent.headline, "headline", 160) ?? `${site.name ?? "Modern"} Website`,
      subheading:
        optionalText(rawContent.subheading, "subheading", 320) ??
        "Clear, useful information for every visitor.",
      primaryCta: optionalText(rawContent.primaryCta, "primaryCta", 80) ?? "Get started",
      sectionCopy: (rawContent.sectionCopy as Record<string, string>) ?? {},
      faq: Array.isArray(rawContent.faq)
        ? (rawContent.faq as Array<{ question: string; answer: string }>)
        : [],
    };
  }

  return {
    intent,
    site,
    requirements,
    design,
    implementation,
    ...(capabilities ? { capabilities } : {}),
    ...(content ? { content } : {}),
  };
}

export type { SiteEditPlan };

export function validateSiteEditPlan(value: unknown): SiteEditPlan {
  return new IntelligenceValidators().validateEdit(value);
}

export function sitePlanToSiteSpec(
  projectName: string,
  userPrompt: string,
  plan: SitePlan,
): SiteSpec {
  const profile = getDefaultProfile();
  return validateSiteSpec({
    ...(plan.capabilities?.runtime?.enabled ? { runtime: plan.capabilities.runtime } : {}),
    ...(plan.capabilities?.auth ? { auth: plan.capabilities.auth } : {}),
    ...(plan.capabilities?.integrations ? { integrations: plan.capabilities.integrations } : {}),
    ...(plan.content ? { content: plan.content } : {}),
    project: {
      name: plan.site.name?.trim() || projectName,
      description: plan.site.purpose?.trim() || userPrompt,
    },
    requirements: {
      siteType: plan.site.category?.trim() || "business",
      pages: plan.requirements.pages,
      features: plan.requirements.features,
    },
    design: {
      style: plan.design.style ?? plan.design.direction,
      theme: plan.design.theme,
      colors: plan.design.colors,
      typography: plan.design.typography,
      spacing: plan.design.spacing,
    },
    technical: {
      framework: profile.framework,
      language: profile.language,
      styling: plan.implementation.stylingStrategy || profile.styling,
      profileId: profile.id,
      bundler: profile.bundler,
      packageManager: profile.packageManager.name,
    },
  });
}

export function sitePlanToRequirementSpec(plan: SitePlan): SiteRequirementSpec {
  return {
    siteType: plan.site.category || "business",
    pages: plan.requirements.pages,
    features: plan.requirements.features,
    responsiveRequirements: plan.requirements.responsiveRequirements ?? [
      "mobile",
      "tablet",
      "desktop",
    ],
    contentRequirements: plan.requirements.contentRequirements ?? [
      "clear heading",
      "supporting copy",
    ],
    ...(plan.site.purpose ? { goal: plan.site.purpose } : {}),
    ...(plan.site.targetAudience ? { targetAudience: plan.site.targetAudience } : {}),
    ...(plan.requirements.sections ? { sections: plan.requirements.sections } : {}),
    ...(plan.capabilities?.runtime?.enabled ? { runtime: plan.capabilities.runtime } : {}),
  };
}

export function sitePlanToDesignSpec(plan: SitePlan): SiteDesignSpec {
  return {
    style: plan.design.style ?? plan.design.direction,
    theme: plan.design.theme ?? "light",
    colors: plan.design.colors ?? { primary: "#2563eb", background: "#ffffff", text: "#111827" },
    typography: plan.design.typography ?? { heading: "system-ui", body: "system-ui" },
    spacing: plan.design.spacing ?? { section: "4rem", content: "1.5rem" },
    layoutDirection: plan.design.layoutDirection ?? "LTR",
    responsiveStrategy: plan.design.responsiveStrategy ?? "mobile-first",
    visualDirection: plan.design.direction,
  };
}

export function sitePlanToIntentResult(plan: SitePlan): SiteIntentResult {
  return {
    intent: plan.intent.type,
    confidence: plan.intent.confidence ?? 0.95,
    reason: plan.intent.reason ?? "Derived from consolidated SitePlan",
  };
}

export function sitePlanToPlanningBundle(plan: SitePlan): SitePlanningBundle {
  return {
    requirements: sitePlanToRequirementSpec(plan),
    design: sitePlanToDesignSpec(plan),
    capabilities: plan.capabilities ?? {
      runtime: { enabled: false, collections: [] },
      auth: {
        authRequired: false,
        publicPages: plan.requirements.pages.map((p) => p.path),
        protectedPages: [],
        capabilities: [],
        ownerCollections: [],
      },
      integrations: { actions: [] },
    },
    content: plan.content ?? {
      headline: plan.site.name ?? "Website",
      subheading: plan.site.purpose ?? "Clear, useful information.",
      primaryCta: "Get started",
      sectionCopy: {},
      faq: [],
    },
  };
}

export function planningBundleToSitePlan(
  bundle: SitePlanningBundle,
  intent?: SiteIntentResult,
  metadata?: SitePlanMetadata,
): SitePlan {
  return {
    intent: {
      type: intent?.intent ?? "CREATE_SITE",
      confidence: intent?.confidence ?? 0.95,
      reason: intent?.reason ?? "Deterministic bundle conversion",
    },
    site: {
      category: bundle.requirements.siteType,
      name: metadata?.name ?? bundle.content.headline,
      ...((metadata?.purpose ?? bundle.requirements.goal)
        ? { purpose: metadata?.purpose ?? bundle.requirements.goal }
        : {}),
      ...((metadata?.targetAudience ?? bundle.requirements.targetAudience)
        ? { targetAudience: metadata?.targetAudience ?? bundle.requirements.targetAudience }
        : {}),
    },
    requirements: {
      pages: bundle.requirements.pages,
      features: bundle.requirements.features,
      responsiveRequirements: bundle.requirements.responsiveRequirements,
      contentRequirements: bundle.requirements.contentRequirements,
      ...(bundle.requirements.sections ? { sections: bundle.requirements.sections } : {}),
    },
    design: {
      direction: bundle.design.visualDirection ?? bundle.design.style,
      style: bundle.design.style,
      theme: bundle.design.theme,
      colors: bundle.design.colors,
      typography: bundle.design.typography,
      spacing: bundle.design.spacing,
      layoutDirection: bundle.design.layoutDirection,
      responsiveStrategy: bundle.design.responsiveStrategy,
      responsiveness: true,
    },
    implementation: {
      framework: "react-vite",
      language: "typescript",
      stylingStrategy: "plain-css",
    },
    capabilities: bundle.capabilities,
    content: bundle.content,
  };
}

function invalid(message: string): never {
  throw new ApplicationError("VALIDATION_FAILED", message);
}
