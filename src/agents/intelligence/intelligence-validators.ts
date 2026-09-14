import { ApplicationError } from "../../app/errors/application-error.js";
import {
  DeterministicDesignPlanner,
  type SiteDesignSpec,
  type SiteRequirementSpec,
} from "../../planning/planning.js";
import { SiteRuntimeSpecValidator } from "../../site-runtime/runtime-validator.js";
import type {
  SiteAuthSpec,
  SiteContentPlan,
  SiteEditPlan,
  SiteIntegrationSpec,
  SiteIntentResult,
  SitePlanningBundle,
} from "./intelligence-types.js";
import { SITE_INTENTS } from "./intelligence-types.js";

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const strings = (value: unknown, label: string, max = 24): string[] => {
  if (!Array.isArray(value) || value.length > max)
    invalid(`${label} must be a bounded string array`);
  const output: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "string") invalid(`${label} must be a bounded string array`);
    if (item.trim()) output.push(item.trim());
  }
  return output;
};
const text = (value: unknown, label: string, max = 500): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    invalid(`${label} is invalid`);
  return value.trim();
};
const bool = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") invalid(`${label} must be boolean`);
  return value;
};

export class IntelligenceValidators {
  validateIntent(value: unknown): SiteIntentResult {
    const input = object(value, "intent");
    if (!SITE_INTENTS.includes(input.intent as SiteIntentResult["intent"]))
      invalid("Unsupported intent");
    if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
      invalid("Intent confidence is invalid");
    return {
      intent: input.intent as SiteIntentResult["intent"],
      confidence: input.confidence,
      reason: text(input.reason, "intent reason", 240),
    };
  }
  validateRequirements(value: unknown): SiteRequirementSpec {
    const input = object(value, "requirements");
    const pages = Array.isArray(input.pages) ? input.pages : invalid("Pages must be an array");
    if (pages.length < 1 || pages.length > 12) invalid("Page count is outside V1 limits");
    const seen = new Set<string>();
    const normalizedPages = pages.map((candidate) => {
      const page = object(candidate, "page");
      const path = text(page.path, "page path", 100);
      if (!path.startsWith("/") || path.includes("..") || seen.has(path))
        invalid("Page path is unsafe or duplicated");
      seen.add(path);
      return {
        name: text(page.name, "page name", 80),
        path,
        ...(typeof page.purpose === "string" ? { purpose: page.purpose.slice(0, 240) } : {}),
      };
    });
    return {
      siteType: text(input.siteType, "site type", 80),
      pages: normalizedPages,
      features: strings(input.features, "features"),
      responsiveRequirements: strings(input.responsiveRequirements, "responsive requirements", 8),
      contentRequirements: strings(input.contentRequirements, "content requirements"),
      ...(typeof input.goal === "string" ? { goal: input.goal.slice(0, 500) } : {}),
      ...(typeof input.targetAudience === "string"
        ? { targetAudience: input.targetAudience.slice(0, 500) }
        : {}),
      ...(Array.isArray(input.sections) ? { sections: strings(input.sections, "sections") } : {}),
    };
  }
  validateDesign(value: unknown): SiteDesignSpec {
    const input = object(value, "design");
    const allowedStyles = new Set([
      "modern",
      "minimal",
      "professional",
      "editorial",
      "playful",
      "bold",
    ]);
    const style = text(input.style, "design style", 40).toLowerCase();
    if (!allowedStyles.has(style)) invalid("Unsupported design style");
    const direction = input.layoutDirection;
    if (direction !== "LTR" && direction !== "RTL") invalid("Unsupported layout direction");
    const record = (candidate: unknown, label: string) => {
      const source = object(candidate, label);
      const output: Record<string, string> = {};
      if (Object.keys(source).length > 12) invalid(`${label} is too large`);
      for (const [key, val] of Object.entries(source))
        output[text(key, `${label} key`, 40)] = text(val, `${label} value`, 100);
      return output;
    };
    return {
      style,
      theme: text(input.theme, "theme", 40),
      colors: record(input.colors, "colors"),
      typography: record(input.typography, "typography"),
      spacing: record(input.spacing, "spacing"),
      layoutDirection: direction,
      responsiveStrategy: text(input.responsiveStrategy, "responsive strategy", 120),
    };
  }
  validateAuth(value: unknown): SiteAuthSpec {
    const input = object(value, "auth");
    const allowed = new Set(["SIGNUP", "LOGIN", "LOGOUT"]);
    const capabilities = strings(input.capabilities, "auth capabilities", 3);
    if (capabilities.some((item) => !allowed.has(item)))
      invalid("Agent cannot define authentication mechanics");
    return {
      authRequired: bool(input.authRequired, "authRequired"),
      publicPages: strings(input.publicPages, "public pages", 12),
      protectedPages: strings(input.protectedPages, "protected pages", 12),
      capabilities: capabilities as SiteAuthSpec["capabilities"],
      ownerCollections: strings(input.ownerCollections, "owner collections", 12),
    };
  }
  validateIntegrations(value: unknown): SiteIntegrationSpec {
    const input = object(value, "integrations");
    if (!Array.isArray(input.actions) || input.actions.length > 8)
      invalid("Actions must be bounded");
    return {
      actions: input.actions.map((candidate) => {
        const action = object(candidate, "action");
        const name = text(action.name, "action name", 63);
        if (!/^[a-z][a-zA-Z0-9_.]{0,62}$/.test(name)) invalid("Unsafe action name");
        const secretRefs = strings(action.secretRefs, "secret refs", 8);
        if (secretRefs.some((ref) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(ref)))
          invalid("Unsafe secret reference name");
        return {
          name,
          purpose: text(action.purpose, "action purpose", 240),
          inputFields: strings(action.inputFields, "action input fields", 16),
          authRequired: bool(action.authRequired, "action authRequired"),
          secretRefs,
        };
      }),
    };
  }
  validateContent(value: unknown): SiteContentPlan {
    const input = object(value, "content");
    const sectionInput = object(input.sectionCopy, "section copy");
    if (Object.keys(sectionInput).length > 16) invalid("Section copy is too large");
    const sectionCopy = Object.fromEntries(
      Object.entries(sectionInput).map(([key, val]) => [
        text(key, "section name", 80),
        text(val, "section copy", 800),
      ]),
    );
    const faqInput = Array.isArray(input.faq) ? input.faq : [];
    if (faqInput.length > 10) invalid("FAQ is too large");
    return {
      headline: text(input.headline, "headline", 160),
      subheading: text(input.subheading, "subheading", 320),
      primaryCta: text(input.primaryCta, "CTA", 80),
      sectionCopy,
      faq: faqInput.map((entry) => {
        const item = object(entry, "FAQ");
        return {
          question: text(item.question, "FAQ question", 240),
          answer: text(item.answer, "FAQ answer", 800),
        };
      }),
    };
  }
  validateBundle(value: unknown): SitePlanningBundle {
    const input = object(value, "planning bundle");
    const capabilities = object(input.capabilities, "capabilities");
    const runtime = new SiteRuntimeSpecValidator().validate(
      input.runtime === undefined ? (capabilities.runtime as never) : (input.runtime as never),
    );
    const auth = this.validateAuth(capabilities.auth);
    const integrations = this.validateIntegrations(capabilities.integrations);
    if (!runtime.enabled && runtime.collections.length)
      invalid("Static plan cannot contain runtime collections");
    for (const name of auth.ownerCollections) {
      const collection = runtime.collections.find((item) => item.name === name);
      if (!collection?.access?.owner) invalid(`OWNER collection is not enforced: ${name}`);
    }
    return {
      requirements: this.validateRequirements(input.requirements),
      design: this.validateDesign(input.design),
      capabilities: { runtime, auth, integrations },
      content: this.validateContent(input.content),
    };
  }
  validateEdit(value: unknown): SiteEditPlan {
    const input = object(value, "edit plan");
    const mutations = object(input.mutations, "edit mutations");
    return {
      requestedChanges: strings(input.requestedChanges, "requested changes"),
      mustPreserve: strings(input.mustPreserve, "must preserve"),
      likelyAffectedAreas: strings(input.likelyAffectedAreas, "affected areas"),
      mutations: {
        runtime: bool(mutations.runtime, "runtime mutation"),
        auth: bool(mutations.auth, "auth mutation"),
        integration: bool(mutations.integration, "integration mutation"),
      },
    };
  }
}

export const defaultDesign = async (): Promise<SiteDesignSpec> =>
  new DeterministicDesignPlanner().plan({
    siteType: "business",
    pages: [{ name: "Home", path: "/" }],
    features: [],
    responsiveRequirements: [],
    contentRequirements: [],
  });
function invalid(message: string): never {
  throw new ApplicationError("VALIDATION_FAILED", message);
}
