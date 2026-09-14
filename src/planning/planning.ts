import type { SitePageSpec, SiteSpec } from "../sites/domain/site-spec.js";
import { validateSiteSpec } from "../sites/domain/site-spec.js";
import type { AgentGateway } from "../agents/gateway/agent-gateway.js";
import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteRuntimeCollectionSpec, SiteRuntimeSpec } from "../site-runtime/runtime-types.js";
import type {
  SiteCapabilityPlan,
  SiteContentPlan,
} from "../agents/intelligence/intelligence-types.js";
import { stripOuterMarkdownFence } from "../agents/shared/structured-response-parser.js";
import { getDefaultProfile } from "../cli/runtime/site-technical-profile.js";

export interface SiteRequirementSpec {
  readonly siteType: string;
  readonly pages: readonly SitePageSpec[];
  readonly features: readonly string[];
  readonly responsiveRequirements: readonly string[];
  readonly contentRequirements: readonly string[];
  readonly goal?: string;
  readonly targetAudience?: string;
  readonly sections?: readonly string[];
  readonly contentNeeds?: readonly string[];
  readonly navigationStructure?: readonly string[];
  readonly runtime?: SiteRuntimeSpec;
}

export interface SiteDesignSpec {
  readonly style: string;
  readonly theme: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly typography: Readonly<Record<string, string>>;
  readonly spacing: Readonly<Record<string, string>>;
  readonly layoutDirection: "LTR" | "RTL";
  readonly responsiveStrategy: string;
  readonly visualDirection?: string;
  readonly navigationStyle?: string;
  readonly heroStyle?: string;
  readonly cardStyle?: string;
  readonly motionDirection?: string;
  readonly imageDirection?: string;
}

export interface RequirementsPlanner {
  plan(prompt: string): Promise<SiteRequirementSpec>;
}

export interface DesignPlanner {
  plan(requirements: SiteRequirementSpec): Promise<SiteDesignSpec>;
}

export class DeterministicRequirementsPlanner implements RequirementsPlanner {
  async plan(prompt: string): Promise<SiteRequirementSpec> {
    const normalized = prompt.toLowerCase();
    const has = (...terms: readonly string[]) => terms.some((term) => normalized.includes(term));
    const forbidsForms = has("no forms", "without forms");
    const forbidsLogin = has("no login", "no member login", "no forms or login", "without login");
    const siteType = has("portfolio")
      ? "portfolio"
      : has("restaurant")
        ? "restaurant"
        : has("dental", "clinic")
          ? "clinic"
          : has("saas")
            ? "saas"
            : has("real estate", "property listings")
              ? "real-estate"
              : has("member portal", "member dashboard")
                ? "member-portal"
                : "business";
    const pageCandidates = [
      { name: "Home", path: "/", purpose: "Primary landing page", include: true },
      { name: "About", path: "/about", include: has("about") },
      { name: "Services", path: "/services", include: has("services") },
      { name: "Menu", path: "/menu", include: has("menu") },
      { name: "Dentists", path: "/dentists", include: has("dentist") },
      { name: "Pricing", path: "/pricing", include: has("pricing") },
      { name: "Integrations", path: "/integrations", include: has("integrations") },
      { name: "Properties", path: "/properties", include: has("property") },
      { name: "Agents", path: "/agents", include: has("agents") },
      { name: "Case Studies", path: "/case-studies", include: has("case studies") },
      { name: "Team", path: "/team", include: has("team") },
      { name: "Resources", path: "/resources", include: has("resources") },
      { name: "FAQ", path: "/faq", include: has("faq") },
      {
        name: "Dashboard",
        path: "/dashboard",
        include: has("dashboard", "member login", "sign up"),
      },
    ];
    const pages = pageCandidates
      .filter(({ include }) => include)
      .map(({ name, path, purpose }) => ({ name, path, ...(purpose ? { purpose } : {}) }));
    const collections: SiteRuntimeCollectionSpec[] = [];
    const submission = (name: string): SiteRuntimeCollectionSpec => ({
      name,
      fields: [
        { name: "name", type: "string", required: true, maxLength: 200 },
        { name: "email", type: "email", required: true, maxLength: 320 },
        { name: "message", type: "text", required: true, maxLength: 4000 },
      ],
      access: { public: { create: true, read: false, update: false, delete: false } },
    });
    let formFeature: string | undefined;
    if (!forbidsForms && has("reservation")) {
      collections.push(submission("reservation_requests"));
      formFeature = "reservation form";
    } else if (!forbidsForms && has("appointment")) {
      collections.push(submission("appointment_requests"));
      formFeature = "appointment form";
    } else if (!forbidsForms && has("inquiry form")) {
      collections.push(submission("inquiries"));
      formFeature = "inquiry form";
    } else if (!forbidsForms && has("demo request")) {
      collections.push(submission("demo_requests"));
      formFeature = "demo request form";
    } else if (
      !forbidsForms &&
      (has("contact form", "contact details") || (has("contact") && has("member login")))
    ) {
      collections.push(submission("contact_submissions"));
      formFeature = "contact form";
    }
    if (has("testimonials"))
      collections.push({
        name: "testimonials",
        fields: [{ name: "quote", type: "text", required: true }],
        access: { public: { read: true } },
      });
    if (has("menu categories"))
      collections.push({
        name: "menu_items",
        fields: [
          { name: "name", type: "string", required: true },
          { name: "price", type: "number", required: true },
        ],
        access: { public: { read: true } },
      });
    if (has("property listings"))
      collections.push({
        name: "properties",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "price", type: "number", required: true },
          { name: "bedrooms", type: "number", required: true },
        ],
        access: { public: { read: true } },
      });
    if (has("private notes"))
      collections.push({
        name: "member_notes",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "body", type: "text" },
        ],
        access: { owner: { create: true, read: true, update: true, delete: true } },
      });
    const auth =
      !forbidsLogin &&
      has("sign up", "login", "member login", "authenticated users", "protected dashboard");
    const action = has("company insights", "external service");
    return {
      siteType,
      pages,
      features: [
        ...(formFeature ? [formFeature] : []),
        ...(auth ? ["site authentication", "protected dashboard"] : []),
        ...(action ? ["named action: companyInsights.get"] : []),
        ...(!collections.length && !auth && !action ? ["static content"] : []),
      ],
      responsiveRequirements: ["mobile", "tablet", "desktop"],
      contentRequirements: ["clear heading", "supporting copy", "primary action"],
      ...(collections.length || auth || action
        ? {
            runtime: {
              enabled: true,
              collections,
            } satisfies SiteRuntimeSpec,
          }
        : {}),
    };
  }
}

export class DeterministicDesignPlanner implements DesignPlanner {
  async plan(requirements: SiteRequirementSpec): Promise<SiteDesignSpec> {
    void requirements;
    return {
      style: "modern",
      theme: "light",
      colors: { primary: "#2563eb", background: "#ffffff", text: "#111827" },
      typography: { heading: "system-ui", body: "system-ui" },
      spacing: { section: "4rem", content: "1.5rem" },
      layoutDirection: "LTR",
      responsiveStrategy: "mobile-first",
    };
  }
}
export class AgentRequirementsPlanner implements RequirementsPlanner {
  constructor(
    private readonly gateway: AgentGateway,
    private readonly provider: string,
  ) {}
  async plan(prompt: string): Promise<SiteRequirementSpec> {
    const result = await this.gateway.createResponse({
      jobId: "planning",
      siteId: "planning",
      provider: this.provider,
      operation: "GENERATE_SITE",
      userRequest: prompt,
      agentRequest: {
        model: "",
        systemInstructions:
          "Return only JSON matching SiteRequirementSpec. Do not generate source code.",
        messages: [{ role: "user", content: prompt }],
      },
    });
    try {
      return JSON.parse(
        stripOuterMarkdownFence(result.response.message.content).content,
      ) as SiteRequirementSpec;
    } catch (cause) {
      throw new ApplicationError(
        "PLANNING_FAILED",
        "Agent requirements planner returned invalid JSON",
        { cause },
      );
    }
  }
}
export class AgentDesignPlanner implements DesignPlanner {
  constructor(
    private readonly gateway: AgentGateway,
    private readonly provider: string,
  ) {}
  async plan(requirements: SiteRequirementSpec): Promise<SiteDesignSpec> {
    const result = await this.gateway.createResponse({
      jobId: "planning",
      siteId: "planning",
      provider: this.provider,
      operation: "GENERATE_SITE",
      userRequest: "Plan the design",
      agentRequest: {
        model: "",
        systemInstructions:
          "Return only JSON matching SiteDesignSpec. Describe design intent, not CSS or source code.",
        messages: [{ role: "user", content: JSON.stringify(requirements) }],
      },
    });
    try {
      return JSON.parse(
        stripOuterMarkdownFence(result.response.message.content).content,
      ) as SiteDesignSpec;
    } catch (cause) {
      throw new ApplicationError("PLANNING_FAILED", "Agent design planner returned invalid JSON", {
        cause,
      });
    }
  }
}

export function assembleSiteSpec(
  name: string,
  prompt: string,
  requirements: SiteRequirementSpec,
  design: SiteDesignSpec,
  capabilities?: SiteCapabilityPlan,
  content?: SiteContentPlan,
): SiteSpec {
  const profile = getDefaultProfile();
  return validateSiteSpec({
    ...((capabilities?.runtime ?? requirements.runtime)
      ? { runtime: capabilities?.runtime ?? requirements.runtime }
      : {}),
    ...(capabilities ? { auth: capabilities.auth, integrations: capabilities.integrations } : {}),
    ...(content ? { content } : {}),
    project: { name, description: prompt },
    requirements: {
      siteType: requirements.siteType,
      pages: requirements.pages,
      features: requirements.features,
    },
    design: {
      style: design.style,
      theme: design.theme,
      colors: design.colors,
      typography: design.typography,
      spacing: design.spacing,
    },
    technical: {
      framework: profile.framework,
      language: profile.language,
      styling: profile.styling,
      profileId: profile.id,
      bundler: profile.bundler,
      packageManager: profile.packageManager.name,
    },
  });
}
