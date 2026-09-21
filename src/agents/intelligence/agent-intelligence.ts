import type { AgentProvider } from "../agent-provider.js";
import type {
  AgentResponse,
  AgentResponseContract,
  StructuredResponseTelemetry,
} from "../agent-types.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  DeterministicDesignPlanner,
  DeterministicRequirementsPlanner,
} from "../../planning/planning.js";
import { IntelligenceValidators } from "./intelligence-validators.js";
import type {
  AgentTaskKind,
  AgentTaskTelemetry,
  IntelligenceRunResult,
  PlanningExecutionStrategy,
  PlanningMode,
  SiteIntent,
  SiteIntentResult,
  SitePlanningBundle,
} from "./intelligence-types.js";
import type { SitePlan } from "../../sites/domain/site-plan.js";
import {
  validateSitePlan,
  planningBundleToSitePlan,
  sitePlanToPlanningBundle,
} from "../../sites/domain/site-plan.js";
import { SITE_PLAN_JSON_SCHEMA } from "../../sites/domain/site-plan-schema.js";
import {
  AGENT_CONTRACT_REGISTRY,
  type AgentContractRegistry,
} from "../contracts/agent-contract.js";
import {
  PROMPT_REGISTRY,
  type PromptDefinition,
  type PromptRegistry,
} from "../prompts/prompt-registry.js";
import {
  parseStructuredResponse,
  stripOuterMarkdownFence,
} from "../shared/structured-response-parser.js";
import { SitePlanCache, defaultSitePlanCache } from "../../planning/site-plan-cache.js";

import type { InferenceRunContext } from "../budget/inference-run-context.js";

export const LOGICAL_PLANNING_TASKS: readonly AgentTaskKind[] = [
  "REQUIREMENTS_PLANNING",
  "DESIGN_PLANNING",
  "CAPABILITY_PLANNING",
  "RUNTIME_PLANNING",
  "AUTH_PLANNING",
  "INTEGRATION_PLANNING",
  "CONTENT_GENERATION",
];

export const CONSOLIDATED_PLANNING_TASKS: readonly AgentTaskKind[] = [
  "INTENT_CLASSIFICATION",
  "REQUIREMENTS_PLANNING",
  "DESIGN_PLANNING",
  "CAPABILITY_PLANNING",
  "RUNTIME_PLANNING",
  "AUTH_PLANNING",
  "INTEGRATION_PLANNING",
  "CONTENT_GENERATION",
];

export interface IntelligenceOptions {
  readonly mode?: PlanningMode;
  readonly strategy?: PlanningExecutionStrategy;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export class AgentPlanningPipeline {
  readonly #validators = new IntelligenceValidators();
  readonly #requirements = new DeterministicRequirementsPlanner();
  readonly #design = new DeterministicDesignPlanner();
  constructor(
    private readonly agent: AgentProvider,
    private readonly options: IntelligenceOptions = {},
  ) {}
  async planSite(
    prompt: string,
    signal?: AbortSignal,
    runContext?: InferenceRunContext,
  ): Promise<IntelligenceRunResult<SitePlan>> {
    const cacheKey = SitePlanCache.createKey(
      prompt,
      this.options.model ? { model: this.options.model } : {},
    );
    const cached = defaultSitePlanCache.get(cacheKey);
    if (cached) {
      return {
        value: cached,
        telemetry: CONSOLIDATED_PLANNING_TASKS.map((kind) => ({
          taskKind: kind,
          provider: this.agent.id,
          model: this.options.model ?? this.agent.getCapabilities().models[0] ?? "unknown",
          attempted: false,
          supported: true,
          success: true,
          fallbackUsed: false,
          latencyMs: 0,
          turns: 0,
          toolCalls: 0,
          status: "PASS",
          invocationGroup: "site_planning",
        })),
      };
    }
    const mode = this.options.mode ?? "AGENT_WITH_FALLBACK";
    if (mode === "DETERMINISTIC") return this.#fallbackPlan(prompt, false);
    const contract: AgentResponseContract = {
      type: "JSON_SCHEMA",
      name: "SitePlan",
      schema: SITE_PLAN_JSON_SCHEMA,
    };
    try {
      const scopedAgent = runContext
        ? runContext.createScopedProvider(this.agent, "SITE_PLANNING")
        : this.agent;
      const response = await request(
        scopedAgent,
        this.options.model,
        "SITE_PLANNING",
        prompt,
        signal,
        this.options.timeoutMs,
        contract,
        resolveSitePlanningPrompt().systemPrompt,
      );
      const capability =
        scopedAgent.getCapabilities().structuredOutputCapability ?? "FALLBACK_TEXT";
      const parseResult = parseStructuredResponse<SitePlan>({
        content: response.message.content,
        contract,
        capability,
        validate: (parsed) => {
          try {
            return validateSitePlan(parsed);
          } catch {
            const bundle = this.#validators.validateBundle(parsed);
            return planningBundleToSitePlan(bundle, deterministicIntent(prompt));
          }
        },
        errorContext: "Site planning",
      });
      const plan = parseResult.value;
      defaultSitePlanCache.set(cacheKey, plan);
      return {
        value: plan,
        telemetry: CONSOLIDATED_PLANNING_TASKS.map((kind) =>
          telemetry(
            this.agent,
            kind,
            response,
            "PASS",
            kind === "REQUIREMENTS_PLANNING",
            "site_planning",
            parseResult.telemetry,
          ),
        ),
      };
    } catch (cause) {
      if (mode === "AGENT") throw cause;
      const fallback = await this.#fallbackPlan(prompt, true);
      return {
        ...fallback,
        telemetry: CONSOLIDATED_PLANNING_TASKS.map((kind) =>
          failureTelemetry(this.agent, kind, cause, true, "site_planning"),
        ),
      };
    }
  }
  async plan(
    prompt: string,
    signal?: AbortSignal,
    runContext?: InferenceRunContext,
  ): Promise<IntelligenceRunResult<SitePlanningBundle>> {
    const mode = this.options.mode ?? "AGENT_WITH_FALLBACK";
    if (mode === "DETERMINISTIC") return this.#fallback(prompt, false);
    if (this.options.strategy === "SEPARATE") {
      const results = [];
      const scopedAgent = runContext
        ? runContext.createScopedProvider(this.agent, "SITE_PLANNING")
        : this.agent;
      for (const kind of LOGICAL_PLANNING_TASKS) {
        const response = await request(
          scopedAgent,
          this.options.model,
          kind,
          prompt,
          signal,
          this.options.timeoutMs,
        );
        results.push({
          kind,
          response,
          bundle: this.#validators.validateBundle(parse(response)),
        });
      }
      const byKind = new Map(results.map((item) => [item.kind, item.bundle]));
      const baseline = results[0]!.bundle;
      return {
        value: {
          requirements:
            byKind.get("REQUIREMENTS_PLANNING")?.requirements ?? baseline.requirements,
          design: byKind.get("DESIGN_PLANNING")?.design ?? baseline.design,
          capabilities: {
            runtime:
              byKind.get("RUNTIME_PLANNING")?.capabilities.runtime ??
              baseline.capabilities.runtime,
            auth: byKind.get("AUTH_PLANNING")?.capabilities.auth ?? baseline.capabilities.auth,
            integrations:
              byKind.get("INTEGRATION_PLANNING")?.capabilities.integrations ??
              baseline.capabilities.integrations,
          },
          content: byKind.get("CONTENT_GENERATION")?.content ?? baseline.content,
        },
        telemetry: results.map(({ kind, response }) =>
          telemetry(this.agent, kind, response, "PASS"),
        ),
      };
    }
    const sitePlanResult = await this.planSite(prompt, signal, runContext);
    return {
      value: sitePlanToPlanningBundle(sitePlanResult.value),
      telemetry: sitePlanResult.telemetry.filter((t) => t.taskKind !== "INTENT_CLASSIFICATION"),
    };
  }
  async #fallbackPlan(
    prompt: string,
    attempted: boolean,
  ): Promise<IntelligenceRunResult<SitePlan>> {
    const bundleResult = await this.#fallback(prompt, attempted);
    const intent = deterministicIntent(prompt);
    const plan = planningBundleToSitePlan(bundleResult.value, intent);
    return {
      value: plan,
      telemetry: CONSOLIDATED_PLANNING_TASKS.map((kind) => ({
        taskKind: kind,
        provider: this.agent.id,
        model: this.options.model ?? this.agent.getCapabilities().models[0] ?? "unknown",
        attempted,
        supported: true,
        success: true,
        fallbackUsed: attempted,
        latencyMs: 0,
        turns: 0,
        toolCalls: 0,
        status: attempted ? "FALLBACK" : "PASS",
        invocationGroup: "site_planning",
      })),
    };
  }
  async #fallback(
    prompt: string,
    attempted: boolean,
  ): Promise<IntelligenceRunResult<SitePlanningBundle>> {
    const requirements = await this.#requirements.plan(prompt);
    const design = await this.#design.plan(requirements);
    const runtime = requirements.runtime ?? { enabled: false, collections: [] };
    const authRequired = requirements.features.includes("site authentication");
    const ownerCollections = runtime.collections
      .filter((item) => item.access?.owner)
      .map((item) => item.name);
    const actions = requirements.features
      .filter((item) => item.startsWith("named action:"))
      .map((item) => ({
        name: item.slice(13).trim(),
        purpose: "Execute the requested named integration",
        inputFields: [],
        authRequired: true,
        secretRefs: [],
      }));
    const value: SitePlanningBundle = {
      requirements,
      design,
      capabilities: {
        runtime,
        auth: {
          authRequired,
          publicPages: requirements.pages
            .filter((page) => page.path !== "/dashboard")
            .map((page) => page.path),
          protectedPages: authRequired ? ["/dashboard"] : [],
          capabilities: authRequired ? ["SIGNUP", "LOGIN", "LOGOUT"] : [],
          ownerCollections,
        },
        integrations: { actions },
      },
      content: {
        headline: `${requirements.siteType[0]?.toUpperCase()}${requirements.siteType.slice(1)} website`,
        subheading: "Clear, useful information for every visitor.",
        primaryCta: "Get started",
        sectionCopy: {},
        faq: [],
      },
    };
    return {
      value,
      telemetry: LOGICAL_PLANNING_TASKS.map((kind) => ({
        taskKind: kind,
        provider: this.agent.id,
        model: this.options.model ?? this.agent.getCapabilities().models[0] ?? "unknown",
        attempted,
        supported: true,
        success: true,
        fallbackUsed: attempted,
        latencyMs: 0,
        turns: 0,
        toolCalls: 0,
        status: attempted ? "FALLBACK" : "PASS",
      })),
    };
  }
}

async function request(
  agent: AgentProvider,
  model: string | undefined,
  task: string,
  content: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  responseContract?: AgentResponseContract,
  systemInstructions?: string,
): Promise<AgentResponse> {
  if (signal?.aborted) throw new ApplicationError("JOB_CANCELLED", "Agent task was cancelled");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  try {
    return await agent.createResponse({
      model: model ?? agent.getCapabilities().models[0] ?? "unknown",
      systemInstructions:
        systemInstructions ??
        `SITES_AGENT_TASK:${task}\nReturn only the requested compact JSON. Never include secrets, credentials, hidden reasoning, source code, or unsupported capabilities.`,
      messages: [{ role: "user", content }],
      maxOutputTokens: 1_500,
      reasoningPolicy: "LOW",
      signal: controller.signal,
      ...(responseContract ? { responseContract } : {}),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/** Resolve and verify the planner's static prompt before provider dispatch. */
export function resolveSitePlanningPrompt(
  agentContracts: Pick<AgentContractRegistry, "getCurrentAgentContract"> = AGENT_CONTRACT_REGISTRY,
  prompts: Pick<PromptRegistry, "getCurrentPrompt" | "getPrompt"> = PROMPT_REGISTRY,
): PromptDefinition {
  const agentContract = agentContracts.getCurrentAgentContract("sites.site-planner");
  const prompt =
    agentContract.prompt.promptVersion === undefined
      ? prompts.getCurrentPrompt(agentContract.prompt.promptId)
      : prompts.getPrompt(agentContract.prompt.promptId, agentContract.prompt.promptVersion);
  if (prompt.stage !== agentContract.stage) {
    throw new ApplicationError(
      "PROMPT_STAGE_MISMATCH",
      `Site planning prompt stage '${prompt.stage}' does not match agent stage '${agentContract.stage}'`,
    );
  }
  if (
    !prompt.compatibleAgentContracts.some(
      (compatible) =>
        compatible.agentId === agentContract.agentId &&
        compatible.contractVersion === agentContract.contractVersion,
    )
  ) {
    throw new ApplicationError(
      "PROMPT_AGENT_CONTRACT_MISMATCH",
      "Site planning prompt is not compatible with the active agent contract",
    );
  }
  if (prompt.lifecycle.status !== "ACTIVE") {
    throw new ApplicationError(
      "INVALID_PROMPT_DEFINITION",
      "Site planning requires an ACTIVE prompt for a new run",
    );
  }
  return prompt;
}
function parse(response: AgentResponse): unknown {
  const { content } = stripOuterMarkdownFence(response.message.content);
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new ApplicationError("STRUCTURED_RESPONSE_PARSE_FAILED", "Agent returned invalid JSON", {
      cause,
      metadata: { reason: "STRUCTURED_RESPONSE_PARSE_FAILED" },
    });
  }
}
function telemetry(
  agent: AgentProvider,
  kind: AgentTaskKind,
  response: AgentResponse,
  status: "PASS",
  includeUsage = true,
  invocationGroup?: string,
  structuredTelemetry?: StructuredResponseTelemetry,
): AgentTaskTelemetry {
  const boundary = response.providerBoundaryTelemetry;
  const struct = structuredTelemetry ?? response.structuredOutputTelemetry;
  return {
    taskKind: kind,
    provider: agent.id,
    model: response.model,
    attempted: true,
    supported: true,
    success: true,
    fallbackUsed: struct?.fallbackParserUsed ?? false,
    latencyMs: response.latencyMs,
    turns: 1,
    toolCalls: response.toolCalls.length,
    ...(includeUsage
      ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
      : {}),
    status,
    ...(invocationGroup ? { invocationGroup } : {}),
    ...(struct?.responseContractType ? { responseContractType: struct.responseContractType } : {}),
    ...(struct?.structuredOutputMode ? { structuredOutputMode: struct.structuredOutputMode } : {}),
    ...(struct?.structuredOutputValidated !== undefined
      ? { structuredOutputValidated: struct.structuredOutputValidated }
      : {}),
    ...(boundary?.providerBoundaryCharacters !== undefined
      ? { providerBoundaryCharacters: boundary.providerBoundaryCharacters }
      : {}),
    ...(boundary?.providerBoundaryEstimatedTokens !== undefined
      ? { providerBoundaryEstimatedTokens: boundary.providerBoundaryEstimatedTokens }
      : {}),
    ...(boundary?.responseSchemaCharacters !== undefined
      ? { responseSchemaCharacters: boundary.responseSchemaCharacters }
      : {}),
    ...(boundary?.responseSchemaEstimatedTokens !== undefined
      ? { responseSchemaEstimatedTokens: boundary.responseSchemaEstimatedTokens }
      : {}),
  };
}
function failureTelemetry(
  agent: AgentProvider,
  kind: AgentTaskKind,
  cause: unknown,
  fallbackUsed: boolean,
  invocationGroup?: string,
  structuredTelemetry?: Partial<StructuredResponseTelemetry>,
): AgentTaskTelemetry {
  const providerStatus =
    cause instanceof ApplicationError && typeof cause.metadata?.status === "number"
      ? cause.metadata.status
      : undefined;
  const structuredFailureReason =
    cause instanceof ApplicationError &&
    (cause.code === "STRUCTURED_RESPONSE_EMPTY" ||
      cause.code === "STRUCTURED_RESPONSE_PARSE_FAILED" ||
      cause.code === "STRUCTURED_RESPONSE_SCHEMA_INVALID")
      ? cause.code
      : cause instanceof ApplicationError && typeof cause.metadata?.reason === "string"
        ? cause.metadata.reason
        : structuredTelemetry?.responseParseFailureReason;
  return {
    taskKind: kind,
    provider: agent.id,
    model: agent.getCapabilities().models[0] ?? "unknown",
    attempted: true,
    supported: true,
    success: false,
    fallbackUsed,
    latencyMs: 0,
    turns: 1,
    toolCalls: 0,
    errorCategory:
      providerStatus === 429
        ? "RATE_LIMIT"
        : cause instanceof ApplicationError
          ? cause.code
          : cause instanceof Error && cause.name === "AbortError"
            ? "TIMEOUT_OR_CANCELLED"
            : "AGENT_FAILED",
    status: fallbackUsed ? "FALLBACK" : "FAILED",
    ...(invocationGroup ? { invocationGroup } : {}),
    ...(structuredFailureReason ? { responseParseFailureReason: structuredFailureReason } : {}),
  };
}
function deterministicIntent(prompt: string, explicit?: SiteIntent): SiteIntentResult {
  if (explicit) return { intent: explicit, confidence: 1, reason: "Explicit application route" };
  const value = prompt.toLowerCase();
  const intent: SiteIntent = /rollback/.test(value)
    ? "ROLLBACK_SITE"
    : /unpublish/.test(value)
      ? "UNPUBLISH_SITE"
      : /publish/.test(value)
        ? "PUBLISH_SITE"
        : /edit|change|update|make/.test(value)
          ? "EDIT_SITE"
          : /build|create|website|site/.test(value)
            ? "CREATE_SITE"
            : "UNSUPPORTED_OR_OTHER";
  return { intent, confidence: 0.7, reason: "Deterministic fallback classification" };
}

export { AgentPlanningPipeline as AgentSitePlanner };
