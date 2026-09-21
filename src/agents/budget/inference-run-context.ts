import { ApplicationError } from "../../app/errors/application-error.js";
import type { AgentProvider } from "../agent-provider.js";
import type { AgentId } from "../contracts/agent-contract.js";
import { resolveAgentPrompt } from "../prompts/agent-prompt-resolution.js";
import type {
  AgentCapabilities,
  AgentRequest,
  AgentResponse,
  RateLimitMetadata,
  TransportHook,
} from "../agent-types.js";
import {
  type BudgetExhaustedReason,
  type InferenceBudgetLimits,
  type InferenceBudgetUsage,
  type InferenceStage,
  resolveBudgetLimits,
} from "./agent-run-budget.js";

export interface PhysicalAttemptRecord {
  readonly stage: InferenceStage;
  readonly provider: string;
  readonly model?: string;
  readonly logicalRequestId: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly status?: number;
  readonly errorCategory?: string;
  readonly rateLimit?: RateLimitMetadata;
}

export interface StageTelemetrySummary {
  readonly logicalRequests: number;
  readonly physicalRequests: number;
  readonly retries: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

export interface InferenceRunSummary {
  readonly runId: string;
  readonly logicalRequests: number;
  readonly physicalRequests: number;
  readonly retries: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  /** Successful provider responses only; absent optional fields mean the provider did not report them for every response. */
  readonly providerUsage?: {
    readonly inputTokens: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number;
    readonly totalTokens: number;
  };
  readonly stages: Readonly<Record<InferenceStage, StageTelemetrySummary>>;
  readonly providersUsed: readonly string[];
  readonly modelsUsed: readonly string[];
  readonly elapsedMs: number;
  readonly budgetExceeded: boolean;
  readonly failureReason?: string;
  readonly attempts: readonly PhysicalAttemptRecord[];
  readonly promptExecutions: readonly PromptExecutionTelemetry[];
}

export interface PromptExecutionTelemetry {
  readonly agentId: AgentId;
  readonly agentContractVersion: number;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly stage: InferenceStage;
  readonly provider: string;
  readonly model?: string;
  readonly reasoningPolicyId: string;
  readonly contextPolicyId: string;
  readonly logicalRequestCount: number;
  readonly physicalRequestCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly success: boolean;
  readonly errorCategory?: string;
}

export class InferenceBudget {
  logicalRequests = 0;
  physicalRequests = 0;
  retries = 0;
  inputTokens = 0;
  outputTokens = 0;
  reasoningTokens = 0;
  totalTokens = 0;
  startedAt: number;
  exhaustedReason?: BudgetExhaustedReason;
  budgetExceeded = false;

  constructor(
    readonly limits: InferenceBudgetLimits,
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = this.clock();
  }

  get elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /**
   * Synchronously checks limits and reserves a logical request.
   * Atomic check-and-increment with NO `await` between check and state mutation.
   */
  reserveLogicalRequest(
    _stage: InferenceStage,
    signal?: AbortSignal,
    maxOutputTokensRequested?: number,
    options?: { readonly minSafeOutputTokens?: number | undefined },
  ): { clampedMaxOutputTokens: number } {
    if (signal?.aborted) {
      throw new ApplicationError("JOB_CANCELLED", "Sites job was cancelled");
    }
    if (this.limits.maxRunDurationMs && this.elapsedMs > this.limits.maxRunDurationMs) {
      this.markExhausted("RUN_DURATION_LIMIT");
      throw new ApplicationError("AGENT_RUN_BUDGET_EXCEEDED", "Inference budget exceeded: RUN_DURATION_LIMIT", {
        metadata: {
          exhaustedReason: "RUN_DURATION_LIMIT",
          elapsedMs: this.elapsedMs,
          limitMs: this.limits.maxRunDurationMs,
        },
      });
    }
    if (this.budgetExceeded) {
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference budget already exhausted: ${this.exhaustedReason}`,
        {
          metadata: {
            exhaustedReason: this.exhaustedReason,
            tokens: this.totalTokens,
            logicalRequests: this.logicalRequests,
          },
        },
      );
    }
    if (this.logicalRequests >= this.limits.maxLogicalRequests) {
      this.markExhausted("LOGICAL_REQUEST_LIMIT");
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference budget exceeded: LOGICAL_REQUEST_LIMIT (max ${this.limits.maxLogicalRequests})`,
        {
          metadata: {
            exhaustedReason: "LOGICAL_REQUEST_LIMIT",
            logicalRequests: this.logicalRequests,
            maxLogicalRequests: this.limits.maxLogicalRequests,
          },
        },
      );
    }
    if (this.totalTokens >= this.limits.maxTotalTokens) {
      this.markExhausted("TOTAL_TOKEN_LIMIT");
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference budget exceeded: TOTAL_TOKEN_LIMIT (${this.totalTokens} tokens >= ${this.limits.maxTotalTokens})`,
        {
          metadata: {
            exhaustedReason: "TOTAL_TOKEN_LIMIT",
            totalTokens: this.totalTokens,
            maxTotalTokens: this.limits.maxTotalTokens,
          },
        },
      );
    }

    const remainingTokens = this.limits.maxTotalTokens - this.totalTokens;
    if (remainingTokens <= 0) {
      this.markExhausted("OUTPUT_TOKEN_LIMIT");
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        "Inference budget exceeded: OUTPUT_TOKEN_LIMIT (no output tokens remaining)",
        {
          metadata: { exhaustedReason: "OUTPUT_TOKEN_LIMIT", remainingTokens },
        },
      );
    }

    if (options?.minSafeOutputTokens && remainingTokens < options.minSafeOutputTokens) {
      this.markExhausted("TOTAL_TOKEN_LIMIT");
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference budget preflight check failed: remaining tokens (${remainingTokens}) is less than minimum safe output allowance (${options.minSafeOutputTokens})`,
        {
          metadata: {
            exhaustedReason: "TOTAL_TOKEN_LIMIT",
            remainingTokens,
            minSafeOutputTokens: options.minSafeOutputTokens,
          },
        },
      );
    }

    // Atomic synchronous reservation
    this.logicalRequests++;

    const clampedMaxOutputTokens = Math.max(
      1,
      Math.min(maxOutputTokensRequested ?? 8192, remainingTokens),
    );

    return { clampedMaxOutputTokens };
  }

  /**
   * Synchronously checks physical request limits and reserves an attempt.
   * Atomic check-and-increment with NO `await` between check and state mutation.
   */
  reservePhysicalRequest(_stage: InferenceStage, attempt: number, signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ApplicationError("JOB_CANCELLED", "Sites job was cancelled");
    }
    if (this.limits.maxRunDurationMs && this.elapsedMs > this.limits.maxRunDurationMs) {
      this.markExhausted("RUN_DURATION_LIMIT");
      throw new ApplicationError("AGENT_RUN_BUDGET_EXCEEDED", "Inference budget exceeded: RUN_DURATION_LIMIT", {
        metadata: {
          exhaustedReason: "RUN_DURATION_LIMIT",
          elapsedMs: this.elapsedMs,
          limitMs: this.limits.maxRunDurationMs,
        },
      });
    }
    if (this.budgetExceeded) {
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference budget already exhausted: ${this.exhaustedReason}`,
        {
          metadata: {
            exhaustedReason: this.exhaustedReason,
            tokens: this.totalTokens,
            physicalRequests: this.physicalRequests,
          },
        },
      );
    }
    if (this.physicalRequests >= this.limits.maxPhysicalRequests) {
      this.markExhausted("PHYSICAL_REQUEST_LIMIT");
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference budget exceeded: PHYSICAL_REQUEST_LIMIT (max ${this.limits.maxPhysicalRequests})`,
        {
          metadata: {
            exhaustedReason: "PHYSICAL_REQUEST_LIMIT",
            physicalRequests: this.physicalRequests,
            maxPhysicalRequests: this.limits.maxPhysicalRequests,
          },
        },
      );
    }

    // Atomic synchronous reservation
    this.physicalRequests++;
    if (attempt > 0) {
      this.retries++;
    }
  }

  recordUsage(
    usage: { readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens?: number },
    _stage: InferenceStage,
  ): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const reasoning = usage.reasoningTokens ?? 0;

    this.inputTokens += input;
    this.outputTokens += output;
    this.reasoningTokens += reasoning;
    this.totalTokens += input + output + reasoning;

    if (this.limits.maxInputTokens && this.inputTokens >= this.limits.maxInputTokens) {
      this.markExhausted("INPUT_TOKEN_LIMIT");
    } else if (this.limits.maxOutputTokens && this.outputTokens >= this.limits.maxOutputTokens) {
      this.markExhausted("OUTPUT_TOKEN_LIMIT");
    } else if (this.limits.maxReasoningTokens && this.reasoningTokens >= this.limits.maxReasoningTokens) {
      this.markExhausted("REASONING_TOKEN_LIMIT");
    } else if (this.totalTokens >= this.limits.maxTotalTokens) {
      this.markExhausted("TOTAL_TOKEN_LIMIT");
    }
  }

  markExhausted(reason: BudgetExhaustedReason): void {
    this.budgetExceeded = true;
    if (!this.exhaustedReason) {
      this.exhaustedReason = reason;
    }
  }

  get usage(): InferenceBudgetUsage {
    return this.toSnapshot();
  }

  toSnapshot(): InferenceBudgetUsage {
    return {
      logicalRequests: this.logicalRequests,
      physicalRequests: this.physicalRequests,
      retries: this.retries,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      totalTokens: this.totalTokens,
      startedAt: this.startedAt,
      elapsedMs: this.elapsedMs,
      budgetExceeded: this.budgetExceeded,
      ...(this.exhaustedReason ? { exhaustedReason: this.exhaustedReason } : {}),
    };
  }
}

export class InferenceTelemetryCollector {
  private readonly attempts: PhysicalAttemptRecord[] = [];
  private readonly providersUsed = new Set<string>();
  private readonly modelsUsed = new Set<string>();
  private readonly stageStats = new Map<
    InferenceStage,
    {
      logicalRequests: number;
      physicalRequests: number;
      retries: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      latencyMs: number;
    }
  >();
  private readonly promptExecutions: PromptExecutionTelemetry[] = [];
  private readonly providerTokens = {
    responses: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cachedComplete: true,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningComplete: true,
    totalTokens: 0,
  };

  constructor(_clock: () => number = Date.now) {
    const stages: InferenceStage[] = [
      "SITE_PLANNING",
      "GENERATE_SITE",
      "BUILD_REPAIR",
      "MOTION_REPAIR",
      "EDIT_PLANNING",
      "TARGETED_EDIT",
      "VISUAL_REVIEW",
      "VISUAL_REPAIR",
      "ASSET_PLANNING",
    ];
    for (const stage of stages) {
      this.stageStats.set(stage, {
        logicalRequests: 0,
        physicalRequests: 0,
        retries: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
      });
    }
  }

  recordPhysicalAttempt(record: PhysicalAttemptRecord): void {
    this.attempts.push(record);
    this.providersUsed.add(record.provider);
    if (record.model) this.modelsUsed.add(record.model);

    const stage = this.stageStats.get(record.stage);
    if (stage) {
      stage.physicalRequests++;
      if (record.attempt > 0) {
        stage.retries++;
      }
      stage.latencyMs += record.latencyMs;
    }
  }

  recordLogicalSuccess(info: {
    readonly stage: InferenceStage;
    readonly provider: string;
    readonly model?: string;
    readonly usage: { readonly inputTokens: number; readonly cachedInputTokens?: number; readonly outputTokens: number; readonly reasoningTokens?: number; readonly totalTokens?: number };
    readonly latencyMs: number;
  }): void {
    this.providersUsed.add(info.provider);
    if (info.model) this.modelsUsed.add(info.model);

    const tokens = this.providerTokens;
    tokens.responses++;
    tokens.inputTokens += info.usage.inputTokens;
    tokens.outputTokens += info.usage.outputTokens;
    tokens.totalTokens += info.usage.totalTokens ?? (info.usage.inputTokens + info.usage.outputTokens);
    if (info.usage.cachedInputTokens === undefined) tokens.cachedComplete = false;
    else tokens.cachedInputTokens += info.usage.cachedInputTokens;
    if (info.usage.reasoningTokens === undefined) tokens.reasoningComplete = false;
    else tokens.reasoningTokens += info.usage.reasoningTokens;

    const stage = this.stageStats.get(info.stage);
    if (stage) {
      stage.logicalRequests++;
      stage.inputTokens += info.usage.inputTokens ?? 0;
      stage.outputTokens += info.usage.outputTokens ?? 0;
      stage.reasoningTokens += info.usage.reasoningTokens ?? 0;
      stage.totalTokens +=
        (info.usage.inputTokens ?? 0) +
        (info.usage.outputTokens ?? 0) +
        (info.usage.reasoningTokens ?? 0);
    }
  }

  recordLogicalFailure(info: {
    readonly stage: InferenceStage;
    readonly provider: string;
    readonly model?: string;
    readonly cause: unknown;
  }): void {
    this.providersUsed.add(info.provider);
    if (info.model) this.modelsUsed.add(info.model);

    const stage = this.stageStats.get(info.stage);
    if (stage) {
      stage.logicalRequests++;
    }
  }

  recordPromptExecution(record: PromptExecutionTelemetry): void {
    this.promptExecutions.push(record);
  }

  getSummary(runId: string, budget: InferenceBudget): InferenceRunSummary {
    const stages: Record<string, StageTelemetrySummary> = {};
    for (const [key, value] of this.stageStats.entries()) {
      stages[key] = { ...value };
    }

    return {
      runId,
      logicalRequests: budget.logicalRequests,
      physicalRequests: budget.physicalRequests,
      retries: budget.retries,
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      reasoningTokens: budget.reasoningTokens,
      totalTokens: budget.totalTokens,
      ...(this.providerTokens.responses ? { providerUsage: {
        inputTokens: this.providerTokens.inputTokens,
        ...(this.providerTokens.cachedComplete ? { cachedInputTokens: this.providerTokens.cachedInputTokens } : {}),
        outputTokens: this.providerTokens.outputTokens,
        ...(this.providerTokens.reasoningComplete ? { reasoningTokens: this.providerTokens.reasoningTokens } : {}),
        totalTokens: this.providerTokens.totalTokens,
      } } : {}),
      stages: stages as Readonly<Record<InferenceStage, StageTelemetrySummary>>,
      providersUsed: Array.from(this.providersUsed),
      modelsUsed: Array.from(this.modelsUsed),
      elapsedMs: budget.elapsedMs,
      budgetExceeded: budget.budgetExceeded,
      ...(budget.exhaustedReason ? { failureReason: budget.exhaustedReason } : {}),
      attempts: [...this.attempts],
      promptExecutions: [...this.promptExecutions],
    };
  }
}

export class RunScopedAgentProvider implements AgentProvider {
  readonly id: string;
  private logicalSeq = 0;

  constructor(
    private readonly delegate: AgentProvider,
    private readonly context: InferenceRunContext,
    private readonly stage: InferenceStage,
  ) {
    this.id = delegate.id;
  }

  getCapabilities(): AgentCapabilities {
    return this.delegate.getCapabilities();
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const logicalRequestId = `${this.context.runId}-${this.stage}-${++this.logicalSeq}`;
    const signal = request.signal ?? this.context.signal;

    // 1. Synchronous atomic logical reservation
    const minSafeOutputTokens = this.stage === "GENERATE_SITE" ? 4_096 : undefined;
    const { clampedMaxOutputTokens } = this.context.budget.reserveLogicalRequest(
      this.stage,
      signal,
      request.maxOutputTokens,
      minSafeOutputTokens !== undefined ? { minSafeOutputTokens } : undefined,
    );

    let attemptStartedAt = 0;
    const promptIdentity = promptIdentityForStage(this.stage);
    const promptStartedAt = new Date().toISOString();

    // 2. Transport hook attached for physical accounting
    const transportHook: TransportHook = {
      beforePhysicalAttempt: async (attempt: number) => {
        attemptStartedAt = Date.now();
        // Synchronous atomic physical reservation
        this.context.budget.reservePhysicalRequest(this.stage, attempt, signal);
      },
      afterPhysicalAttempt: async (attempt: number, error?: unknown, _response?: unknown) => {
        const latencyMs = attemptStartedAt > 0 ? Date.now() - attemptStartedAt : 0;
        const candidate = error as { metadata?: Record<string, unknown>; status?: number; code?: string } | undefined;
        const rateLimit = (candidate?.metadata?.rateLimit ?? undefined) as RateLimitMetadata | undefined;
        const status = typeof candidate?.status === "number" ? candidate.status : (candidate?.metadata?.status as number | undefined);

        this.context.telemetry.recordPhysicalAttempt({
          stage: this.stage,
          provider: this.delegate.id,
          model: request.model,
          logicalRequestId,
          attempt,
          startedAt: attemptStartedAt,
          latencyMs,
          success: !error,
          ...(status !== undefined ? { status } : {}),
          ...(candidate?.code ? { errorCategory: candidate.code } : {}),
          ...(rateLimit ? { rateLimit } : {}),
        });
      },
    };

    try {
      const response = await this.delegate.createResponse({
        ...request,
        maxOutputTokens: clampedMaxOutputTokens,
        ...(signal ? { signal } : {}),
        transportHook,
      });

      this.context.budget.recordUsage(response.usage, this.stage);
      this.context.telemetry.recordLogicalSuccess({
        stage: this.stage,
        provider: this.delegate.id,
        model: response.model,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });
      if (promptIdentity) this.context.telemetry.recordPromptExecution({
        ...promptIdentity,
        stage: this.stage,
        provider: this.delegate.id,
        ...(response.model ? { model: response.model } : {}),
        logicalRequestCount: 1,
        physicalRequestCount: 1 + (response.usage.retryCount ?? 0),
        inputTokens: response.usage.inputTokens,
        cachedInputTokens: response.usage.cachedInputTokens ?? 0,
        outputTokens: response.usage.outputTokens,
        startedAt: promptStartedAt,
        completedAt: new Date().toISOString(),
        success: true,
      });

      return response;
    } catch (cause) {
      this.context.telemetry.recordLogicalFailure({
        stage: this.stage,
        provider: this.delegate.id,
        model: request.model,
        cause,
      });
      if (promptIdentity) this.context.telemetry.recordPromptExecution({
        ...promptIdentity,
        stage: this.stage,
        provider: this.delegate.id,
        ...(request.model ? { model: request.model } : {}),
        logicalRequestCount: 1,
        physicalRequestCount: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        startedAt: promptStartedAt,
        completedAt: new Date().toISOString(),
        success: false,
        ...(cause instanceof ApplicationError ? { errorCategory: cause.code } : {}),
      });
      throw cause;
    }
  }
}

const AGENT_FOR_STAGE: Partial<Record<InferenceStage, AgentId>> = {
  SITE_PLANNING: "sites.site-planner",
  GENERATE_SITE: "sites.site-coder",
  BUILD_REPAIR: "sites.build-repair",
  MOTION_REPAIR: "sites.motion-repair",
  EDIT_PLANNING: "sites.edit-planner",
  TARGETED_EDIT: "sites.targeted-edit",
  ASSET_PLANNING: "sites.asset-planner",
  VISUAL_REVIEW: "sites.visual-review",
  VISUAL_REPAIR: "sites.visual-repair",
};

function promptIdentityForStage(stage: InferenceStage): Omit<PromptExecutionTelemetry, "stage" | "provider" | "model" | "logicalRequestCount" | "physicalRequestCount" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "startedAt" | "completedAt" | "success" | "errorCategory"> | undefined {
  const agentId = AGENT_FOR_STAGE[stage];
  if (!agentId) return undefined;
  try {
    const resolved = resolveAgentPrompt(agentId, { expectedStage: stage });
    return {
      agentId,
      agentContractVersion: resolved.agentContract.contractVersion,
      promptId: resolved.prompt.promptId,
      promptVersion: resolved.prompt.promptVersion,
      promptHash: resolved.prompt.promptHash,
      reasoningPolicyId: resolved.agentContract.reasoningPolicy.id,
      contextPolicyId: resolved.agentContract.contextPolicy.id,
    };
  } catch {
    return undefined;
  }
}

export interface InferenceRunContextOptions {
  readonly runId: string;
  readonly limits?:
    | ({
        readonly [K in keyof InferenceBudgetLimits]?: InferenceBudgetLimits[K] | undefined;
      } & {
        readonly maxModelRequests?: number | undefined;
        readonly timeoutMs?: number | undefined;
      })
    | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly clock?: (() => number) | undefined;
}

export interface InferenceRunContext {
  readonly runId: string;
  readonly budget: InferenceBudget;
  readonly telemetry: InferenceTelemetryCollector;
  readonly startedAt: number;
  readonly signal?: AbortSignal | undefined;
  createScopedProvider(provider: AgentProvider, stage: InferenceStage): AgentProvider;
  getSummary(): InferenceRunSummary;
}

export function createInferenceRunContext(options: InferenceRunContextOptions): InferenceRunContext {
  const clock = options.clock ?? Date.now;
  const limits = resolveBudgetLimits(options.limits);
  const budget = new InferenceBudget(limits, clock);
  const telemetry = new InferenceTelemetryCollector(clock);

  return {
    runId: options.runId,
    budget,
    telemetry,
    startedAt: budget.startedAt,
    ...(options.signal ? { signal: options.signal } : {}),
    createScopedProvider(provider: AgentProvider, stage: InferenceStage): AgentProvider {
      return new RunScopedAgentProvider(provider, this, stage);
    },
    getSummary(): InferenceRunSummary {
      return telemetry.getSummary(options.runId, budget);
    },
  };
}
