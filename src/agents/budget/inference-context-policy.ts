import type { AgentToolDefinition, ReasoningPolicy } from "../agent-types.js";
import type { InferenceStage } from "./agent-run-budget.js";
import { getStageAgentTools } from "../tool-catalog.js";
import type { SiteSpec } from "../../sites/domain/site-spec.js";

export type { ReasoningPolicy };

export type ContextStrategy =
  | "ZERO_WORKSPACE"
  | "RUNTIME_CONTRACT_ONLY"
  | "TARGETED_FILES"
  | "FULL_WORKSPACE";

export interface OutputPolicy {
  readonly defaultMaxOutputTokens: number;
  readonly minOutputTokens: number;
  readonly maxOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly complexityAware?: boolean;
}

export interface ObservationPolicy {
  readonly compactReceipts: boolean;
  readonly maxSearchMatches?: number;
  readonly maxSearchBytes?: number;
  readonly normalizeBuildLogs?: boolean;
}

export interface InferenceContextPolicy {
  readonly stage: InferenceStage;
  readonly tools: readonly AgentToolDefinition[];
  readonly contextStrategy: ContextStrategy;
  readonly outputPolicy: OutputPolicy;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly observationPolicy: ObservationPolicy;
}

export interface GenerationOutputAllowanceParams {
  readonly siteSpec?: SiteSpec | undefined;
  readonly pageCount?: number | undefined;
  readonly sectionCount?: number | undefined;
  readonly contentLength?: number | undefined;
  readonly featureCount?: number | undefined;
  readonly minAllowed?: number | undefined;
  readonly maxAllowed?: number | undefined;
  readonly safetyMargin?: number | undefined;
}

/**
 * Calculates a deterministic, complexity-aware output allowance for website generation.
 * Simple sites receive a tighter allowance (~4,096-5,000 tokens) while complex multi-page
 * sites receive a generous allowance (up to 16,384 tokens) to emit all code and finalization in 1 turn.
 */
export function calculateGenerationOutputAllowance(params: GenerationOutputAllowanceParams): number {
  const minAllowed = params.minAllowed ?? 4_096;
  const maxAllowed = params.maxAllowed ?? 16_384;
  const safetyMargin = params.safetyMargin ?? 512;

  let pageCount = params.pageCount ?? 1;
  let sectionCount = params.sectionCount ?? 3;
  let contentLength = params.contentLength ?? 500;
  let featureCount = params.featureCount ?? 1;

  if (params.siteSpec) {
    pageCount = Math.max(1, params.siteSpec.requirements?.pages?.length ?? 1);
    const sections = params.siteSpec.content?.sectionCopy
      ? Object.keys(params.siteSpec.content.sectionCopy)
      : [];
    sectionCount = Math.max(pageCount * 2, sections.length);
    featureCount = Math.max(1, params.siteSpec.requirements?.features?.length ?? 1);

    let charSum = 0;
    if (params.siteSpec.content?.sectionCopy) {
      for (const val of Object.values(params.siteSpec.content.sectionCopy)) {
        charSum += JSON.stringify(val).length;
      }
    }
    if (params.siteSpec.content) {
      charSum +=
        (params.siteSpec.content.headline?.length ?? 0) +
        (params.siteSpec.content.subheading?.length ?? 0) +
        (params.siteSpec.content.primaryCta?.length ?? 0) +
        JSON.stringify(params.siteSpec.content.faq ?? []).length;
    }
    contentLength = Math.max(charSum, 500);
  }

  const baseAllowance = 2_048; // React boilerplate, router, imports, base CSS layout
  const pageAllowance = pageCount * 512;
  const sectionAllowance = sectionCount * 256;
  const contentAllowance = Math.ceil(contentLength / 4);
  const featureAllowance = featureCount * 200;

  const rawAllowance =
    baseAllowance +
    pageAllowance +
    sectionAllowance +
    contentAllowance +
    featureAllowance +
    safetyMargin;

  return Math.max(minAllowed, Math.min(rawAllowance, maxAllowed));
}

export function getInferenceContextPolicy(
  stage: InferenceStage,
  options?: {
    readonly completionRequirements?: {
      readonly requiredPages?: readonly string[] | undefined;
      readonly requiredSections?: readonly string[] | undefined;
    } | undefined;
    readonly siteSpec?: SiteSpec | undefined;
    readonly overrideReasoning?: ReasoningPolicy | undefined;
    readonly overrideMaxOutput?: number | undefined;
  },
): InferenceContextPolicy {
  switch (stage) {
    case "SITE_PLANNING":
      return {
        stage,
        tools: [],
        contextStrategy: "ZERO_WORKSPACE",
        outputPolicy: {
          defaultMaxOutputTokens: options?.overrideMaxOutput ?? 1_500,
          minOutputTokens: 512,
          maxOutputTokens: 2_048,
          safetyMarginTokens: 256,
          complexityAware: false,
        },
        reasoningPolicy: options?.overrideReasoning ?? "LOW",
        observationPolicy: {
          compactReceipts: true,
        },
      };

    case "GENERATE_SITE": {
      const computedOutput = options?.overrideMaxOutput ??
        (options?.siteSpec
          ? calculateGenerationOutputAllowance({ siteSpec: options.siteSpec })
          : 8_192);

      return {
        stage,
        tools: getStageAgentTools("GENERATE_SITE", options?.completionRequirements),
        contextStrategy: "RUNTIME_CONTRACT_ONLY",
        outputPolicy: {
          defaultMaxOutputTokens: computedOutput,
          minOutputTokens: 4_096,
          maxOutputTokens: 16_384,
          safetyMarginTokens: 512,
          complexityAware: true,
        },
        reasoningPolicy: options?.overrideReasoning ?? "AUTO",
        observationPolicy: {
          compactReceipts: true,
          normalizeBuildLogs: true,
        },
      };
    }

    case "BUILD_REPAIR":
      return {
        stage,
        tools: getStageAgentTools("BUILD_REPAIR"),
        contextStrategy: "TARGETED_FILES",
        outputPolicy: {
          defaultMaxOutputTokens: options?.overrideMaxOutput ?? 4_096,
          minOutputTokens: 1_024,
          maxOutputTokens: 8_192,
          safetyMarginTokens: 256,
          complexityAware: false,
        },
        reasoningPolicy: options?.overrideReasoning ?? "LOW",
        observationPolicy: {
          compactReceipts: true,
          normalizeBuildLogs: true,
          maxSearchMatches: 5,
          maxSearchBytes: 2_000,
        },
      };

    case "EDIT_PLANNING":
      return {
        stage,
        tools: [],
        contextStrategy: "ZERO_WORKSPACE",
        outputPolicy: {
          defaultMaxOutputTokens: options?.overrideMaxOutput ?? 1_024,
          minOutputTokens: 256,
          maxOutputTokens: 2_048,
          safetyMarginTokens: 256,
          complexityAware: false,
        },
        reasoningPolicy: options?.overrideReasoning ?? "LOW",
        observationPolicy: {
          compactReceipts: true,
        },
      };

    case "TARGETED_EDIT":
      return {
        stage,
        tools: getStageAgentTools("TARGETED_EDIT"),
        contextStrategy: "FULL_WORKSPACE",
        outputPolicy: {
          defaultMaxOutputTokens: options?.overrideMaxOutput ?? 4_096,
          minOutputTokens: 1_024,
          maxOutputTokens: 8_192,
          safetyMarginTokens: 256,
          complexityAware: false,
        },
        reasoningPolicy: options?.overrideReasoning ?? "LOW",
        observationPolicy: {
          compactReceipts: true,
          maxSearchMatches: 10,
          maxSearchBytes: 4_000,
        },
      };

    case "VISUAL_REVIEW":
      return {
        stage,
        tools: [],
        contextStrategy: "ZERO_WORKSPACE",
        outputPolicy: {
          defaultMaxOutputTokens: options?.overrideMaxOutput ?? 1_024,
          minOutputTokens: 256,
          maxOutputTokens: 2_048,
          safetyMarginTokens: 256,
          complexityAware: false,
        },
        reasoningPolicy: options?.overrideReasoning ?? "LOW",
        observationPolicy: {
          compactReceipts: true,
        },
      };

    case "VISUAL_REPAIR":
      return {
        stage,
        tools: getStageAgentTools("BUILD_REPAIR"),
        contextStrategy: "TARGETED_FILES",
        outputPolicy: {
          defaultMaxOutputTokens: options?.overrideMaxOutput ?? 4_096,
          minOutputTokens: 1_024,
          maxOutputTokens: 8_192,
          safetyMarginTokens: 256,
          complexityAware: false,
        },
        reasoningPolicy: options?.overrideReasoning ?? "LOW",
        observationPolicy: {
          compactReceipts: true,
          normalizeBuildLogs: true,
        },
      };
  }
}

export interface PreflightBudgetEvaluation {
  readonly ok: boolean;
  readonly requiredTokens: number;
  readonly remainingBudgetTokens: number;
  readonly reason?: string | undefined;
}

export function evaluatePreflightBudget(params: {
  readonly stage: InferenceStage;
  readonly conservativeEstimatedInputTokens: number;
  readonly requestedOutputAllowance: number;
  readonly minSafeOutputTokens: number;
  readonly reasoningAllowanceTokens?: number | undefined;
  readonly safetyMarginTokens?: number | undefined;
  readonly remainingBudgetTokens: number;
}): PreflightBudgetEvaluation {
  const reasoning = params.reasoningAllowanceTokens ?? 0;
  const safety = params.safetyMarginTokens ?? 0;

  // 1. Check if remaining budget can even satisfy the absolute minimum safe output
  if (params.remainingBudgetTokens < params.minSafeOutputTokens) {
    return {
      ok: false,
      requiredTokens: params.minSafeOutputTokens,
      remainingBudgetTokens: params.remainingBudgetTokens,
      reason: `Remaining budget (${params.remainingBudgetTokens}) is less than minimum safe output allowance (${params.minSafeOutputTokens})`,
    };
  }

  // 2. Check overall projected request envelope
  const totalRequired =
    params.conservativeEstimatedInputTokens +
    params.requestedOutputAllowance +
    reasoning +
    safety;

  if (params.remainingBudgetTokens < totalRequired) {
    return {
      ok: false,
      requiredTokens: totalRequired,
      remainingBudgetTokens: params.remainingBudgetTokens,
      reason: `Projected request envelope (${totalRequired} tokens = ${params.conservativeEstimatedInputTokens} input + ${params.requestedOutputAllowance} output + ${reasoning} reasoning + ${safety} safety) exceeds remaining budget (${params.remainingBudgetTokens})`,
    };
  }

  return {
    ok: true,
    requiredTokens: totalRequired,
    remainingBudgetTokens: params.remainingBudgetTokens,
  };
}
