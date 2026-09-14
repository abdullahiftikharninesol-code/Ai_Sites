import type { SiteDesignSpec, SiteRequirementSpec } from "../../planning/planning.js";
import type { SiteRuntimeSpec } from "../../site-runtime/runtime-types.js";

export const AGENT_TASK_KINDS = [
  "INTENT_CLASSIFICATION",
  "REQUIREMENTS_PLANNING",
  "DESIGN_PLANNING",
  "CAPABILITY_PLANNING",
  "CODE_GENERATION",
  "TOOL_LOOP",
  "BUILD_REPAIR",
  "TARGETED_EDIT",
  "RUNTIME_PLANNING",
  "AUTH_PLANNING",
  "INTEGRATION_PLANNING",
  "VISUAL_REVIEW",
  "VISUAL_REPAIR",
  "CONTENT_GENERATION",
] as const;
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];

export const SITE_INTENTS = [
  "CREATE_SITE",
  "EDIT_SITE",
  "CONTINUE_SITE",
  "INSPECT_SITE",
  "PUBLISH_SITE",
  "ROLLBACK_SITE",
  "UNPUBLISH_SITE",
  "UNSUPPORTED_OR_OTHER",
] as const;
export type SiteIntent = (typeof SITE_INTENTS)[number];

export interface SiteIntentResult {
  readonly intent: SiteIntent;
  readonly confidence: number;
  readonly reason: string;
}
export interface SiteAuthSpec {
  readonly authRequired: boolean;
  readonly publicPages: readonly string[];
  readonly protectedPages: readonly string[];
  readonly capabilities: readonly ("SIGNUP" | "LOGIN" | "LOGOUT")[];
  readonly ownerCollections: readonly string[];
}
export interface SiteActionSpec {
  readonly name: string;
  readonly purpose: string;
  readonly inputFields: readonly string[];
  readonly authRequired: boolean;
  readonly secretRefs: readonly string[];
}
export interface SiteIntegrationSpec {
  readonly actions: readonly SiteActionSpec[];
}
export interface SiteContentPlan {
  readonly headline: string;
  readonly subheading: string;
  readonly primaryCta: string;
  readonly sectionCopy: Readonly<Record<string, string>>;
  readonly faq: readonly { readonly question: string; readonly answer: string }[];
}
export interface SiteCapabilityPlan {
  readonly runtime: SiteRuntimeSpec;
  readonly auth: SiteAuthSpec;
  readonly integrations: SiteIntegrationSpec;
}
export interface SitePlanningBundle {
  readonly requirements: SiteRequirementSpec;
  readonly design: SiteDesignSpec;
  readonly capabilities: SiteCapabilityPlan;
  readonly content: SiteContentPlan;
}
export interface SiteEditPlan {
  readonly requestedChanges: readonly string[];
  readonly mustPreserve: readonly string[];
  readonly likelyAffectedAreas: readonly string[];
  readonly mutations: {
    readonly runtime: boolean;
    readonly auth: boolean;
    readonly integration: boolean;
  };
}
export type PlanningExecutionStrategy = "COMBINED" | "SEPARATE";
export type PlanningMode = "AGENT" | "DETERMINISTIC" | "AGENT_WITH_FALLBACK";
export type VisualAgentMode = "OFF" | "REVIEW_ONLY" | "REVIEW_AND_REPAIR";
export type IntelligenceTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "PASS"
  | "FALLBACK"
  | "NOT_NEEDED"
  | "UNSUPPORTED"
  | "DISABLED"
  | "FAILED"
  | "NOT_REACHED";
export interface AgentTaskTelemetry {
  readonly taskKind: AgentTaskKind;
  readonly provider: string;
  readonly model: string;
  readonly attempted: boolean;
  readonly supported: boolean;
  readonly success: boolean;
  readonly fallbackUsed: boolean;
  readonly latencyMs: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly errorCategory?: string;
  readonly status: IntelligenceTaskStatus;
  readonly invocationGroup?: string;
  readonly physicalCallIndex?: number;
  readonly satisfiedPurposes?: readonly AgentTaskKind[];
  readonly responseContractType?: "TEXT" | "JSON_SCHEMA";
  readonly structuredOutputMode?: string;
  readonly structuredOutputValidated?: boolean;
  readonly responseParseFailureReason?: string;
  readonly providerBoundaryCharacters?: number;
  readonly providerBoundaryEstimatedTokens?: number;
  readonly responseSchemaCharacters?: number;
  readonly responseSchemaEstimatedTokens?: number;
}
export interface IntelligenceRunResult<T> {
  readonly value: T;
  readonly telemetry: readonly AgentTaskTelemetry[];
}
