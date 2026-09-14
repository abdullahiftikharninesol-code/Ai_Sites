import type { SiteRequirementSpec, SiteDesignSpec } from "../planning/planning.js";
import type { SiteSpec } from "../sites/domain/site-spec.js";

export const PRODUCT_ACCEPTANCE_STATUSES = [
  "PASS",
  "PASS_WITH_WARNINGS",
  "FAILED",
  "BLOCKED",
] as const;
export type ProductAcceptanceStatus = (typeof PRODUCT_ACCEPTANCE_STATUSES)[number];
export const PRODUCT_ACCEPTANCE_ISSUE_CATEGORIES = [
  "ARCHITECTURE_BUG",
  "GENERATION_BUG",
  "PLANNING_BUG",
  "MOCK_AGENT_LIMITATION",
  "RUNTIME_BUG",
  "AUTH_SECURITY_BUG",
  "DEPLOYMENT_BUG",
  "HOSTING_BUG",
  "VERSIONING_BUG",
  "VISUAL_QA_BUG",
  "PRODUCT_UX_ISSUE",
  "TEST_FIXTURE_ISSUE",
  "INTENTIONAL_V1_LIMITATION",
] as const;
export type ProductAcceptanceIssueCategory = (typeof PRODUCT_ACCEPTANCE_ISSUE_CATEGORIES)[number];
export type ProductAcceptanceSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ProductQualityDimension =
  | "planning"
  | "generatedStructure"
  | "build"
  | "navigation"
  | "responsiveLayout"
  | "visualQA"
  | "runtime"
  | "authentication"
  | "dataPolicies"
  | "externalActions"
  | "deployment"
  | "editing"
  | "versionContinuity"
  | "rollback"
  | "restartPersistence"
  | "cleanup";
export interface ProductAcceptanceExpectation {
  readonly pages: readonly string[];
  readonly runtimeEnabled: boolean;
  readonly collections: readonly string[];
  readonly authEnabled: boolean;
  readonly actions: readonly string[];
  readonly form?: "contact" | "reservation" | "appointment" | "inquiry";
}
export interface ProductAcceptanceScenario {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly prompt: string;
  readonly expected: ProductAcceptanceExpectation;
  readonly edits: readonly string[];
  readonly tags: readonly string[];
}
export interface ProductAcceptanceIssue {
  readonly id: string;
  readonly scenarioId: string;
  readonly category: ProductAcceptanceIssueCategory;
  readonly severity: ProductAcceptanceSeverity;
  readonly title: string;
  readonly description: string;
  readonly lifecycleArea: ProductQualityDimension;
  readonly reproducible: boolean;
  readonly fixed: boolean;
  readonly resolution?: string;
  readonly discoveredAt: string;
}
export interface ProductAcceptanceCheck {
  readonly dimension: ProductQualityDimension;
  readonly status: "PASS" | "WARNING" | "FAIL" | "NOT_APPLICABLE";
  readonly detail: string;
  readonly durationMs?: number;
}
export interface ProductAcceptanceRunOutput {
  readonly requirements: SiteRequirementSpec;
  readonly design: SiteDesignSpec;
  readonly siteSpec?: SiteSpec;
  readonly checks: readonly ProductAcceptanceCheck[];
  readonly issues?: readonly ProductAcceptanceIssue[];
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly cleanupPassed: boolean;
}
export interface ProductAcceptanceResult {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: ProductAcceptanceStatus;
  readonly prompt: string;
  readonly expectedCapabilities: ProductAcceptanceExpectation;
  readonly actualSpecs?: {
    readonly requirements: SiteRequirementSpec;
    readonly design: SiteDesignSpec;
    readonly siteSpec?: SiteSpec;
  };
  readonly checks: readonly ProductAcceptanceCheck[];
  readonly issues: readonly ProductAcceptanceIssue[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly cleanup: { readonly passed: boolean };
  readonly reproducibility: {
    readonly sourceFingerprint: string;
    readonly configFingerprint: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly architecture: string;
  };
  readonly totalMs: number;
}
export interface AgentProviderQualityMetric {
  readonly firstBuildSuccess?: boolean;
  readonly buildAttempts?: number;
  readonly repairCount?: number;
  readonly agentTurns?: number;
  readonly toolCalls?: number;
  readonly filesCreated?: number;
  readonly filesModified?: number;
  readonly filesTouchedOnEdit?: number;
  readonly targetedEditMinimality?: number;
  readonly visualQaScore?: number;
  readonly visualRepairCount?: number;
  readonly functionalAcceptance?: number;
  readonly runtimeAcceptance?: number;
  readonly securityViolations?: number;
  readonly tokenInput?: number;
  readonly tokenOutput?: number;
  readonly cachedTokens?: number;
  readonly latencyMs?: number;
  readonly estimatedModelCostUsd?: number;
  readonly actualModelCostUsd?: number | null;
  readonly humanReviewScore?: number;
}
