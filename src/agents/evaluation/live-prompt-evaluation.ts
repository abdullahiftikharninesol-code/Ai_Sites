import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentProvider } from "../agent-provider.js";
import type { AgentContract, AgentId } from "../contracts/agent-contract.js";
import { AGENT_CONTRACT_REGISTRY } from "../contracts/agent-contract.js";
import { getStageAgentTools, isApprovedAgentTool } from "../tool-catalog.js";
import type { AgentResponse, AgentResponseContract, ReasoningPolicy } from "../agent-types.js";
import { SITE_EDIT_PLAN_JSON_SCHEMA, SITE_PLAN_JSON_SCHEMA } from "../../sites/domain/site-plan-schema.js";
import { IntelligenceValidators } from "../intelligence/intelligence-validators.js";
import { validateSitePlan } from "../../sites/domain/site-plan.js";
import { stripOuterMarkdownFence } from "../shared/structured-response-parser.js";
import { PROMPT_REGISTRY, type PromptDefinition } from "../prompts/prompt-registry.js";
import { CANDIDATE_PROMPT_IDS } from "./prompt-v2-candidates.js";

export interface PromptEvalBudget {
  readonly maxCases: number;
  readonly maxLogicalRequests: number;
  readonly maxPhysicalRequests: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxEstimatedCostUsd?: number;
  readonly timeoutMs: number;
}

export interface LivePromptEvaluationManifest {
  readonly evalRunId: string;
  readonly createdAt: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly reasoningPolicyId: string;
  readonly contextPolicyId: string;
  readonly baselinePromptVersion: number;
  readonly candidatePromptVersion: number;
  readonly agentIds: readonly AgentId[];
  readonly budget: PromptEvalBudget;
  readonly status: "RUNNING" | "COMPLETED" | "PARTIAL" | "BLOCKED";
}

export interface LivePromptEvaluationArtifactPaths {
  readonly directory: string;
  readonly manifest: string;
  readonly results: string;
  readonly summary: string;
  readonly failures: string;
  readonly raw: string;
}

export interface LivePromptEvaluationArtifactStore {
  readonly paths: LivePromptEvaluationArtifactPaths;
  begin(manifest: Omit<LivePromptEvaluationManifest, "status">): void;
  getCompletedResult(identity: {
    readonly agentId: AgentId;
    readonly caseId: string;
    readonly promptVersion: number;
  }): LivePromptCaseResult | undefined;
  persistResult(result: LivePromptCaseResult, normalizedResponse?: Readonly<Record<string, unknown>>): void;
  finalize(summary: Readonly<Record<string, unknown>>, status: LivePromptEvaluationManifest["status"]): void;
}

export interface LivePromptEvaluationRequest {
  readonly agentId: AgentId;
  readonly baselinePromptVersion: number;
  readonly candidatePromptVersion: number;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly caseIds: readonly string[];
  readonly provider: AgentProvider;
  readonly model: string;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly budget: PromptEvalBudget;
  readonly evalRunId?: string;
  readonly artifactStore?: LivePromptEvaluationArtifactStore;
  readonly resume?: boolean;
}

export interface LivePromptCaseResult {
  readonly evalRunId: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly caseId: string;
  readonly agentId: AgentId;
  readonly agentContractVersion: number;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningPolicyId: string;
  readonly contextPolicyId: string;
  readonly logicalRequests: number;
  readonly physicalRequests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly toolNames: readonly string[];
  readonly responseCharacters: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly responseProtocolValid: boolean;
  readonly validStructuredResponse?: boolean;
  readonly validationResults: Readonly<Record<string, boolean>>;
  readonly changedFiles: readonly string[];
  readonly managedFileViolations: number;
  readonly dependencyViolations: number;
  readonly qualityMetrics: Readonly<Record<string, string | number | boolean>>;
  readonly safetyMetrics: Readonly<Record<string, string | number | boolean>>;
  readonly budgetMetrics: Readonly<Record<string, string | number | boolean>>;
  readonly classification: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly errorClassification?: string;
}

export interface LivePromptEvaluationRun {
  readonly evalRunId: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly agentId: AgentId;
  readonly agentContractVersion: number;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningPolicyId: string;
  readonly contextPolicyId: string;
  readonly mode: "LIVE";
  readonly logicalRequests: number;
  readonly physicalRequests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd?: number;
  readonly costStatus: "UNAVAILABLE" | "RECORDED";
  readonly cases: readonly LivePromptCaseResult[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly errorClassifications: readonly string[];
}

export interface LivePromptEvaluationResult {
  readonly request: Omit<LivePromptEvaluationRequest, "provider" | "artifactStore"> & { readonly provider: string };
  readonly baseline: LivePromptEvaluationRun;
  readonly candidate: LivePromptEvaluationRun;
  readonly quotaOrRateLimitEvents: number;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function safeArtifactSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!segment || segment === "." || segment === "..") throw new Error("Invalid live evaluation artifact ID");
  return segment;
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${canonicalJson(value)}\n`, { encoding: "utf8" });
  renameSync(temporaryPath, path);
}

function isCompleteCaseResult(value: unknown): value is LivePromptCaseResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LivePromptCaseResult>;
  return typeof result.evalRunId === "string" && typeof result.agentId === "string" &&
    typeof result.caseId === "string" && typeof result.promptVersion === "number" &&
    typeof result.promptHash === "string" && typeof result.classification === "string" &&
    typeof result.completedAt === "string";
}

/** Filesystem persistence for explicit live evals. Raw provider content is intentionally not stored. */
export class FileLivePromptEvaluationArtifactStore implements LivePromptEvaluationArtifactStore {
  readonly paths: LivePromptEvaluationArtifactPaths;
  #invalidResultLines = 0;

  constructor(rootDirectory = resolve("artifacts", "prompt-evals"), evalRunId: string) {
    const directory = resolve(rootDirectory, safeArtifactSegment(evalRunId));
    this.paths = {
      directory,
      manifest: resolve(directory, "manifest.json"),
      results: resolve(directory, "results.jsonl"),
      summary: resolve(directory, "summary.json"),
      failures: resolve(directory, "failures.jsonl"),
      raw: resolve(directory, "raw"),
    };
  }

  begin(manifest: Omit<LivePromptEvaluationManifest, "status">): void {
    mkdirSync(this.paths.raw, { recursive: true });
    if (existsSync(this.paths.manifest)) {
      const existing = JSON.parse(readFileSync(this.paths.manifest, "utf8")) as LivePromptEvaluationManifest;
      const sameRun = existing.evalRunId === manifest.evalRunId && existing.suiteId === manifest.suiteId &&
        existing.suiteVersion === manifest.suiteVersion && existing.provider === manifest.provider &&
        existing.model === manifest.model && existing.baselinePromptVersion === manifest.baselinePromptVersion &&
        existing.candidatePromptVersion === manifest.candidatePromptVersion;
      if (!sameRun) throw new Error("Live evaluation artifact manifest does not match the requested run");
    }
    writeJsonAtomically(this.paths.manifest, { ...manifest, status: "RUNNING" });
  }

  #readResults(): LivePromptCaseResult[] {
    if (!existsSync(this.paths.results)) return [];
    const results: LivePromptCaseResult[] = [];
    for (const line of readFileSync(this.paths.results, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isCompleteCaseResult(value)) results.push(value);
        else this.#invalidResultLines++;
      } catch {
        this.#invalidResultLines++;
      }
    }
    return results;
  }

  getCompletedResult(identity: { readonly agentId: AgentId; readonly caseId: string; readonly promptVersion: number }): LivePromptCaseResult | undefined {
    return this.#readResults().find((result) => result.agentId === identity.agentId && result.caseId === identity.caseId && result.promptVersion === identity.promptVersion);
  }

  persistResult(result: LivePromptCaseResult, normalizedResponse?: Readonly<Record<string, unknown>>): void {
    const existing = this.getCompletedResult({ agentId: result.agentId, caseId: result.caseId, promptVersion: result.promptVersion });
    if (existing) return;
    appendFileSync(this.paths.results, `${canonicalJson(result)}\n`, { encoding: "utf8" });
    if (result.classification !== "PASS") appendFileSync(this.paths.failures, `${canonicalJson(result)}\n`, { encoding: "utf8" });
    if (normalizedResponse) {
      const rawPath = resolve(this.paths.raw, `${safeArtifactSegment(result.caseId)}-${result.promptVersion}.json`);
      writeJsonAtomically(rawPath, normalizedResponse);
    }
  }

  finalize(summary: Readonly<Record<string, unknown>>, status: LivePromptEvaluationManifest["status"]): void {
    const persistedSummary = { ...summary, invalidResultLines: this.#invalidResultLines };
    writeJsonAtomically(this.paths.summary, persistedSummary);
    const manifest = JSON.parse(readFileSync(this.paths.manifest, "utf8")) as LivePromptEvaluationManifest;
    writeJsonAtomically(this.paths.manifest, { ...manifest, status });
  }
}

const DEFAULT_CANARY_CASES: Readonly<Record<(typeof CANDIDATE_PROMPT_IDS)[number], readonly string[]>> = {
  "sites.site-planner": ["simple-business", "ambiguous-request"],
  "sites.site-coder": ["simple-static", "multi-page"],
  "sites.build-repair": ["type-mismatch", "invalid-prop"],
  "sites.targeted-edit": ["hero-text", "preserve-scope"],
};

export const LIVE_CANARY_CASES = Object.freeze(DEFAULT_CANARY_CASES);

function assertBudget(budget: PromptEvalBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
      throw new Error(`Live prompt evaluation budget '${name}' must be finite and non-negative`);
  }
  if (budget.maxCases < 1 || budget.maxLogicalRequests < 1 || budget.maxPhysicalRequests < 1 || budget.timeoutMs < 1)
    throw new Error("Live prompt evaluation budget limits must be positive");
}

function promptFor(agentId: AgentId, version: number): PromptDefinition {
  const prompt = PROMPT_REGISTRY.getPrompt(agentId, version);
  const contract = AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(agentId);
  if (prompt.stage !== contract.stage || !prompt.compatibleAgentContracts.some(
    (item) => item.agentId === agentId && item.contractVersion === contract.contractVersion,
  )) throw new Error(`Prompt '${agentId}@${version}' is incompatible with its active contract`);
  return prompt;
}

function responseContract(contract: AgentContract): AgentResponseContract | undefined {
  if (contract.responseContract.kind !== "JSON_SCHEMA") return undefined;
  return contract.responseContract.schemaId === "SitePlan"
    ? { type: "JSON_SCHEMA", name: "SitePlan", schema: SITE_PLAN_JSON_SCHEMA, strict: true }
    : contract.responseContract.schemaId === "SiteEditPlan"
      ? { type: "JSON_SCHEMA", name: "SiteEditPlan", schema: SITE_EDIT_PLAN_JSON_SCHEMA, strict: true }
      : undefined;
}

function errorClass(cause: unknown): string {
  const value = cause as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  if (value.code === "QUOTA_EXCEEDED" || value.code === "INSUFFICIENT_CREDITS" || message.includes("quota")) return "PROVIDER_QUOTA";
  if (value.code === "RATE_LIMIT" || (typeof value.status === "number" && value.status === 429) || message.includes("rate limit")) return "PROVIDER_RATE_LIMIT";
  if (value.code === "PROVIDER_NOT_AVAILABLE" || message.includes("eacces") || message.includes("econn") || message.includes("network") || message.includes("fetch")) return "PROVIDER_NETWORK";
  if (message.includes("timeout") || message.includes("aborted")) return "PROVIDER_TIMEOUT";
  if (value.code === "AGENT_FAILED" && value.cause && value.cause !== cause) return errorClass(value.cause);
  if (typeof value.code === "string") return value.code === "AGENT_FAILED" ? "PROMPT_FAILURE" : value.code;
  return cause instanceof Error ? cause.name : "HARNESS_ERROR";
}

function caseClassification(
  responseProtocolValid: boolean,
  validStructuredResponse: boolean | undefined,
  errorClassification?: string,
): LivePromptCaseResult["classification"] {
  if (errorClassification) {
    return errorClassification.startsWith("PROVIDER_") ? "INCONCLUSIVE" : "FAIL";
  }
  return responseProtocolValid && (validStructuredResponse === undefined || validStructuredResponse) ? "PASS" : "FAIL";
}

function parseJson(content: string): unknown {
  return JSON.parse(stripOuterMarkdownFence(content).content);
}

function assessResponse(agentId: AgentId, contract: AgentContract, response: AgentResponse): {
  readonly responseProtocolValid: boolean;
  readonly validStructuredResponse?: boolean;
  readonly validationResults: Readonly<Record<string, boolean>>;
} {
  const allowedTools = new Set(getStageAgentTools(contract.stage).map(({ name }) => name));
  const responseProtocolValid = response.toolCalls.every(
    (call) => allowedTools.has(call.name) && isApprovedAgentTool(call.name),
  );
  if (contract.responseContract.kind !== "JSON_SCHEMA") {
    return { responseProtocolValid, validationResults: { responseProtocolValid } };
  }
  try {
    const parsed = parseJson(response.message.content);
    const valid = agentId === "sites.site-planner"
      ? (() => { validateSitePlan(parsed); return true; })()
      : new IntelligenceValidators().validateEdit(parsed) !== undefined;
    return {
      responseProtocolValid,
      validStructuredResponse: valid,
      validationResults: { responseProtocolValid, validStructuredResponse: valid },
    };
  } catch {
    return {
      responseProtocolValid,
      validStructuredResponse: false,
      validationResults: { responseProtocolValid, validStructuredResponse: false },
    };
  }
}

async function runVersion(
  request: LivePromptEvaluationRequest,
  prompt: PromptDefinition,
  cases: readonly { readonly id: string; readonly inputFixture: unknown }[],
  evalRunId: string,
): Promise<LivePromptEvaluationRun> {
  const contract = AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(request.agentId);
  const started = Date.now();
  let logicalRequests = 0;
  let physicalRequests = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  const results: LivePromptCaseResult[] = [];
  const errors: string[] = [];
  for (const testCase of cases) {
    const caseStarted = Date.now();
    const caseStartedAt = new Date(caseStarted).toISOString();
    const existing = request.resume === true
      ? request.artifactStore?.getCompletedResult({ agentId: request.agentId, caseId: testCase.id, promptVersion: prompt.promptVersion })
      : undefined;
    if (existing) {
      results.push(existing);
      physicalRequests += existing.physicalRequests;
      inputTokens += existing.inputTokens;
      cachedInputTokens += existing.cachedInputTokens;
      outputTokens += existing.outputTokens;
      if (existing.errorClassification) errors.push(existing.errorClassification);
      continue;
    }
    if (logicalRequests >= request.budget.maxLogicalRequests || physicalRequests >= request.budget.maxPhysicalRequests)
      throw new Error("LIVE_EVAL_BUDGET_EXCEEDED");
    const input = JSON.stringify(testCase.inputFixture);
    if (request.budget.maxInputTokens !== undefined && input.length / 3 > request.budget.maxInputTokens)
      throw new Error("LIVE_EVAL_INPUT_BUDGET_EXCEEDED");
    logicalRequests += 1;
    try {
      const structuredContract = responseContract(contract);
      const responseRequest = {
        model: request.model,
        systemInstructions: prompt.systemPrompt,
        messages: [{ role: "user", content: input }],
        tools: getStageAgentTools(contract.stage),
        maxOutputTokens: Math.min(request.budget.maxOutputTokens ?? 2_048, 2_048),
        reasoningPolicy: request.reasoningPolicy,
        signal: AbortSignal.timeout(request.budget.timeoutMs),
      } as const;
      const response = await request.provider.createResponse(
        structuredContract ? { ...responseRequest, responseContract: structuredContract } : responseRequest,
      );
      const retries = response.usage.retryCount ?? 0;
      physicalRequests += 1 + retries;
      inputTokens += response.usage.inputTokens;
      cachedInputTokens += response.usage.cachedInputTokens ?? 0;
      outputTokens += response.usage.outputTokens;
      const assessed = assessResponse(request.agentId, contract, response);
      const completedAt = new Date().toISOString();
      const result: LivePromptCaseResult = {
        evalRunId, suiteId: request.suiteId, suiteVersion: request.suiteVersion, caseId: testCase.id,
        agentId: request.agentId, agentContractVersion: contract.contractVersion,
        promptId: prompt.promptId, promptVersion: prompt.promptVersion, promptHash: prompt.promptHash,
        provider: request.provider.id, model: response.model,
        reasoningPolicyId: contract.reasoningPolicy.id, contextPolicyId: contract.contextPolicy.id,
        logicalRequests: 1, physicalRequests: 1 + retries,
        inputTokens: response.usage.inputTokens, cachedInputTokens: response.usage.cachedInputTokens ?? 0,
        outputTokens: response.usage.outputTokens, toolCalls: response.toolCalls.length,
        toolNames: Object.freeze(response.toolCalls.map(({ name }) => name)),
        responseCharacters: response.message.content.length, startedAt: caseStartedAt, completedAt, durationMs: Date.now() - caseStarted,
        changedFiles: [], managedFileViolations: 0, dependencyViolations: 0,
        qualityMetrics: { responseProtocolValid: assessed.responseProtocolValid, ...(assessed.validStructuredResponse !== undefined ? { validStructuredResponse: assessed.validStructuredResponse } : {}) },
        safetyMetrics: { managedFileViolations: 0, dependencyViolations: 0 },
        budgetMetrics: { logicalRequests: 1, physicalRequests: 1 + retries },
        classification: caseClassification(assessed.responseProtocolValid, assessed.validStructuredResponse),
        ...assessed,
      };
      results.push(result);
      request.artifactStore?.persistResult(result, {
        responseId: response.id, model: response.model, finishReason: response.finishReason,
        usage: response.usage, toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map(({ name }) => name),
        responseProtocolValid: assessed.responseProtocolValid, validStructuredResponse: assessed.validStructuredResponse,
      });
    } catch (cause) {
      const classification = errorClass(cause);
      errors.push(classification);
      physicalRequests += 1;
      const completedAt = new Date().toISOString();
      const result: LivePromptCaseResult = {
        evalRunId, suiteId: request.suiteId, suiteVersion: request.suiteVersion, caseId: testCase.id,
        agentId: request.agentId, agentContractVersion: contract.contractVersion,
        promptId: prompt.promptId, promptVersion: prompt.promptVersion, promptHash: prompt.promptHash,
        provider: request.provider.id, model: request.model,
        reasoningPolicyId: contract.reasoningPolicy.id, contextPolicyId: contract.contextPolicy.id,
        logicalRequests: 1, physicalRequests: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        toolCalls: 0, toolNames: [], responseCharacters: 0, startedAt: caseStartedAt, completedAt, durationMs: Date.now() - caseStarted,
        responseProtocolValid: false, validationResults: { responseProtocolValid: false }, changedFiles: [],
        managedFileViolations: 0, dependencyViolations: 0,
        qualityMetrics: { responseProtocolValid: false }, safetyMetrics: { managedFileViolations: 0, dependencyViolations: 0 },
        budgetMetrics: { logicalRequests: 1, physicalRequests: 1 }, classification: caseClassification(false, false, classification),
        errorClassification: classification,
      };
      results.push(result);
      request.artifactStore?.persistResult(result, { errorClassification: classification });
      if (classification.startsWith("PROVIDER_")) throw cause;
    }
  }
  const completedAt = new Date().toISOString();
  return Object.freeze({
    evalRunId, suiteId: request.suiteId, suiteVersion: request.suiteVersion, agentId: request.agentId,
    agentContractVersion: contract.contractVersion, promptId: prompt.promptId, promptVersion: prompt.promptVersion,
    promptHash: prompt.promptHash, provider: request.provider.id, model: request.model,
    reasoningPolicyId: contract.reasoningPolicy.id, contextPolicyId: contract.contextPolicy.id, mode: "LIVE",
    logicalRequests, physicalRequests, inputTokens, cachedInputTokens, outputTokens,
    costStatus: "UNAVAILABLE", cases: Object.freeze(results), startedAt: new Date(started).toISOString(),
    completedAt, durationMs: Date.now() - started, errorClassifications: Object.freeze([...new Set(errors)]),
  });
}

/** Explicit live entry point. It is not imported by production runtime startup or npm test. */
export async function runLivePromptEvaluation(
  request: LivePromptEvaluationRequest,
): Promise<LivePromptEvaluationResult> {
  assertBudget(request.budget);
  if (request.baselinePromptVersion === request.candidatePromptVersion)
    throw new Error("Live evaluation requires distinct baseline and candidate prompt versions");
  if (!request.caseIds.length || request.caseIds.length * 2 > request.budget.maxCases)
    throw new Error("Live evaluation case selection exceeds maxCases");
  if (request.budget.maxLogicalRequests < request.caseIds.length * 2 || request.budget.maxPhysicalRequests < request.caseIds.length * 2)
    throw new Error("Live evaluation request budget is too small for the selected cases");
  const baselinePrompt = promptFor(request.agentId, request.baselinePromptVersion);
  const candidatePrompt = promptFor(request.agentId, request.candidatePromptVersion);
  const suiteModule = await import("./core-prompt-eval-suites.js");
  const suite = suiteModule.CORE_PROMPT_EVAL_REGISTRY.getSuite(request.suiteId, request.suiteVersion);
  if (suite.agentId !== request.agentId) throw new Error("Live evaluation suite targets a different agent");
  const selected = request.caseIds.map((id) => {
    const testCase = suite.cases.find(({ id: candidateId }) => candidateId === id);
    if (!testCase) throw new Error(`Unknown live evaluation case '${id}'`);
    return { id: testCase.id, inputFixture: testCase.inputFixture };
  });
  const runId = request.evalRunId ?? `live:${randomUUID()}`;
  const artifactStore = request.artifactStore ?? new FileLivePromptEvaluationArtifactStore(undefined, runId);
  artifactStore.begin({
    evalRunId: runId, createdAt: new Date().toISOString(), suiteId: request.suiteId, suiteVersion: request.suiteVersion,
    provider: request.provider.id, model: request.model,
    reasoningPolicyId: contractFor(request.agentId).reasoningPolicy.id,
    contextPolicyId: contractFor(request.agentId).contextPolicy.id,
    baselinePromptVersion: request.baselinePromptVersion, candidatePromptVersion: request.candidatePromptVersion,
    agentIds: [request.agentId], budget: request.budget,
  });
  const persistedRequest = { ...request, artifactStore, resume: request.resume ?? true };
  let baseline: LivePromptEvaluationRun;
  let candidate: LivePromptEvaluationRun;
  try {
    baseline = await runVersion(persistedRequest, baselinePrompt, selected, `${runId}:v${request.baselinePromptVersion}`);
    candidate = await runVersion(persistedRequest, candidatePrompt, selected, `${runId}:v${request.candidatePromptVersion}`);
  } catch (cause) {
    artifactStore.finalize({ evalRunId: runId, status: "BLOCKED", errorClassification: errorClass(cause) }, "BLOCKED");
    throw cause;
  }
  const quotaOrRateLimitEvents = [...baseline.errorClassifications, ...candidate.errorClassifications]
    .filter((item) => item === "PROVIDER_QUOTA" || item === "PROVIDER_RATE_LIMIT").length;
  const allCases = [...baseline.cases, ...candidate.cases];
  artifactStore.finalize({
    evalRunId: runId, status: "COMPLETED", suiteId: request.suiteId, suiteVersion: request.suiteVersion,
    baseline: { promptVersion: baseline.promptVersion, cases: baseline.cases.length, passed: baseline.cases.filter(({ classification }) => classification === "PASS").length },
    candidate: { promptVersion: candidate.promptVersion, cases: candidate.cases.length, passed: candidate.cases.filter(({ classification }) => classification === "PASS").length },
    logicalRequests: baseline.logicalRequests + candidate.logicalRequests,
    physicalRequests: baseline.physicalRequests + candidate.physicalRequests,
    inputTokens: baseline.inputTokens + candidate.inputTokens,
    cachedInputTokens: baseline.cachedInputTokens + candidate.cachedInputTokens,
    outputTokens: baseline.outputTokens + candidate.outputTokens,
    quotaOrRateLimitEvents,
    persistedCaseResults: allCases.length,
  }, "COMPLETED");
  const { artifactStore: _artifactStore, ...requestMetadata } = request;
  return Object.freeze({
    request: { ...requestMetadata, provider: request.provider.id },
    baseline, candidate, quotaOrRateLimitEvents,
  });
}

function contractFor(agentId: AgentId): AgentContract {
  return AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(agentId);
}

export function canaryCasesFor(agentId: (typeof CANDIDATE_PROMPT_IDS)[number]): readonly string[] {
  return LIVE_CANARY_CASES[agentId];
}
