import type { SiteSpec } from "../../sites/domain/site-spec.js";
import type { AssetManifest } from "../../sites/assets/asset-domain.js";
import type { AgentImagePart, ReasoningPolicy } from "../../agents/agent-types.js";
import type { InferenceRunContext } from "../../agents/budget/inference-run-context.js";
import type { InferenceStage } from "../../agents/budget/agent-run-budget.js";
import type { ResolvedTemplateDesignReference } from "../../templates/application/template-design-context.js";
export interface CliTask {
  readonly jobId: string;
  readonly siteId: string;
  readonly operation: "REPLACE_TEXT" | "GENERATE_SITE" | "EDIT_SITE";
  readonly runtime?: "LOCAL_CLI" | "SANDBOX_CLI";
  readonly agentProvider?: string;
  readonly userRequest: string;
  readonly siteSpec?: SiteSpec;
  readonly assetManifest?: AssetManifest;
  readonly templateDesignReference?: ResolvedTemplateDesignReference;
  /** Transient images supplied to this coder request; never persisted in project/job records. */
  readonly referenceImages?: readonly AgentImagePart[];
  readonly target?: { readonly path: string; readonly find: string; readonly replace: string };
  readonly generationMode?: "FAST_GENERATION" | "ITERATIVE_FALLBACK";
  readonly runContext?: InferenceRunContext;
  readonly stage?: InferenceStage;
  readonly reasoningPolicy?: ReasoningPolicy;
  readonly limits?: {
    readonly timeoutMs?: number;
    readonly maxFiles?: number;
    readonly maxAgentTurns?: number;
    readonly maxModelRequests?: number;
    readonly maxLogicalRequests?: number;
    readonly maxPhysicalRequests?: number;
    readonly maxTotalTokens?: number;
    readonly maxConversationBytes?: number;
    readonly maxOutputTokens?: number;
    readonly maxToolCalls?: number;
    readonly maxBuildRepairs?: number;
    readonly maxContextFiles?: number;
    readonly maxContextBytes?: number;
    readonly maxFileBytes?: number;
    readonly maxLogBytes?: number;
    readonly maxTotalWrittenBytes?: number;
  };
}
export interface CliResult {
  readonly success: boolean;
  readonly operation: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly details?: Readonly<Record<string, unknown>>;
}
