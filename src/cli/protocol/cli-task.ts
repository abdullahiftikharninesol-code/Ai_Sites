import type { SiteSpec } from "../../sites/domain/site-spec.js";
import type { AssetManifest } from "../../sites/assets/asset-domain.js";
export interface CliTask {
  readonly jobId: string;
  readonly siteId: string;
  readonly operation: "REPLACE_TEXT" | "GENERATE_SITE" | "EDIT_SITE";
  readonly runtime?: "LOCAL_CLI" | "SANDBOX_CLI";
  readonly agentProvider?: string;
  readonly userRequest: string;
  readonly siteSpec?: SiteSpec;
  readonly assetManifest?: AssetManifest;
  /** Transient images supplied to this coder request; never persisted in project/job records. */
  readonly referenceImages?: readonly import("../../agents/agent-types.js").AgentImagePart[];
  readonly target?: { readonly path: string; readonly find: string; readonly replace: string };
  readonly generationMode?: "FAST_GENERATION" | "ITERATIVE_FALLBACK";
  readonly runContext?: import("../../agents/budget/inference-run-context.js").InferenceRunContext;
  readonly stage?: import("../../agents/budget/agent-run-budget.js").InferenceStage;
  readonly reasoningPolicy?: import("../../agents/agent-types.js").ReasoningPolicy;
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
