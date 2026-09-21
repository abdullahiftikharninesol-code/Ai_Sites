import { ApplicationError } from "../../app/errors/application-error.js";
import {
  AGENT_CONTRACT_REGISTRY,
  type AgentId,
} from "../contracts/agent-contract.js";
import type { PromptDefinition } from "../prompts/prompt-registry.js";
import { PROMPT_REGISTRY } from "../prompts/prompt-registry.js";

export type PromptEvalMode = "OFFLINE" | "LIVE";
export type PromptEvalScalar = string | number | boolean;
export type PromptEvalMetrics = Readonly<Record<string, PromptEvalScalar>>;
export type PromptEvalAssertionOperator = "EQUALS" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN_OR_EQUAL" | "GREATER_THAN" | "LESS_THAN";
export type PromptEvalMetricCategory = "SAFETY" | "QUALITY" | "BUDGET" | "CONTRACT";
export type PromptEvalMetricDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER" | "EQUAL_REQUIRED";

export interface PromptEvalAssertion {
  readonly metric: string;
  readonly operator: PromptEvalAssertionOperator;
  readonly expected: PromptEvalScalar;
  readonly category: PromptEvalMetricCategory;
  readonly direction?: PromptEvalMetricDirection;
}

export interface PromptEvalExpectation {
  readonly assertions: readonly PromptEvalAssertion[];
}

export interface PromptEvalCase {
  readonly id: string;
  readonly description: string;
  readonly agentId: AgentId;
  readonly inputFixture: unknown;
  readonly expected: PromptEvalExpectation;
  readonly tags: readonly string[];
  /** Deterministic mock observation used by offline runs. */
  readonly offlineObservation: PromptEvalMetrics;
}

export interface PromptEvalSuite {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly description: string;
  readonly agentId: AgentId;
  readonly mode: PromptEvalMode;
  readonly cases: readonly PromptEvalCase[];
}

export interface PromptEvalPromptIdentity {
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
}

export interface PromptEvalFailure {
  readonly metric: string;
  readonly category: PromptEvalMetricCategory;
  readonly expected: PromptEvalScalar;
  readonly actual?: PromptEvalScalar;
  readonly message: string;
}

export interface PromptEvalResult extends PromptEvalPromptIdentity {
  readonly caseId: string;
  readonly agentId: AgentId;
  readonly contractVersion: number;
  readonly passed: boolean;
  readonly metrics: PromptEvalMetrics;
  readonly assertions: readonly PromptEvalAssertion[];
  readonly failures: readonly PromptEvalFailure[];
}

export interface PromptEvalRequestAccounting {
  readonly logicalRequests: number;
  readonly physicalRequests: number;
  readonly totalTokens?: number;
}

export interface PromptEvalRun {
  readonly evalRunId: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly mode: PromptEvalMode;
  readonly agentId: AgentId;
  readonly contractVersion: number;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningPolicy?: string;
  readonly requestAccounting?: PromptEvalRequestAccounting;
  readonly cases: readonly PromptEvalResult[];
}

export type PromptEvalComparisonStatus = "BETTER" | "EQUAL" | "WORSE" | "INCOMPARABLE";

export interface PromptEvalMetricComparison {
  readonly caseId: string;
  readonly metric: string;
  readonly category: PromptEvalMetricCategory;
  readonly direction: PromptEvalMetricDirection;
  readonly baseline?: PromptEvalScalar;
  readonly candidate?: PromptEvalScalar;
  readonly status: "IMPROVED" | "UNCHANGED" | "REGRESSED" | "MISSING";
}

export interface PromptEvalComparison {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly agentId: AgentId;
  readonly baseline: PromptEvalPromptIdentity;
  readonly candidate: PromptEvalPromptIdentity;
  readonly status: PromptEvalComparisonStatus;
  readonly safetyRegressions: readonly PromptEvalMetricComparison[];
  readonly qualityRegressions: readonly PromptEvalMetricComparison[];
  readonly budgetRegressions: readonly PromptEvalMetricComparison[];
  readonly metrics: readonly PromptEvalMetricComparison[];
}

export interface PromptEvalMetricSummary {
  readonly metric: string;
  readonly observedCount: number;
  readonly passingCount: number;
  readonly passRate: number;
}

export interface PromptEvalSummary {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly agentId: AgentId;
  readonly caseCount: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly passRate: number;
  readonly metrics: readonly PromptEvalMetricSummary[];
}

export function createPromptEvalCase(input: PromptEvalCase): PromptEvalCase {
  if (!input.id.trim() || !input.description.trim())
    throw new ApplicationError("VALIDATION_FAILED", "Prompt evaluation cases require an ID and description");
  if (input.expected.assertions.length === 0)
    throw new ApplicationError("VALIDATION_FAILED", `Prompt evaluation case '${input.id}' requires assertions`);
  return deepFreeze({ ...input, tags: [...input.tags], expected: { assertions: [...input.expected.assertions] } });
}

export function createPromptEvalSuite(input: PromptEvalSuite): PromptEvalSuite {
  if (!input.suiteId.trim() || !Number.isInteger(input.suiteVersion) || input.suiteVersion <= 0)
    throw new ApplicationError("VALIDATION_FAILED", "Prompt evaluation suites require a positive version and ID");
  if (input.cases.length === 0)
    throw new ApplicationError("VALIDATION_FAILED", `Prompt evaluation suite '${input.suiteId}' requires cases`);
  const ids = input.cases.map(({ id }) => id);
  if (new Set(ids).size !== ids.length)
    throw new ApplicationError("VALIDATION_FAILED", `Prompt evaluation suite '${input.suiteId}' contains duplicate cases`);
  for (const testCase of input.cases) {
    if (testCase.agentId !== input.agentId)
      throw new ApplicationError("VALIDATION_FAILED", `Prompt evaluation case '${testCase.id}' targets a different agent`);
  }
  return deepFreeze({ ...input, cases: [...input.cases].sort((left, right) => left.id.localeCompare(right.id)) });
}

export class PromptEvalSuiteRegistry {
  readonly #suites = new Map<string, Map<number, PromptEvalSuite>>();

  constructor(suites: readonly PromptEvalSuite[] = []) {
    for (const suite of suites) this.register(suite);
  }

  register(suite: PromptEvalSuite): void {
    const validated = createPromptEvalSuite(suite);
    let versions = this.#suites.get(validated.suiteId);
    if (!versions) {
      versions = new Map<number, PromptEvalSuite>();
      this.#suites.set(validated.suiteId, versions);
    }
    if (versions.has(validated.suiteVersion))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Prompt evaluation suite '${validated.suiteId}' version ${validated.suiteVersion} is already registered`,
      );
    versions.set(validated.suiteVersion, validated);
  }

  getSuite(suiteId: string, suiteVersion: number): PromptEvalSuite {
    const versions = this.#suites.get(suiteId);
    if (!versions) throw new ApplicationError("VALIDATION_FAILED", `Unknown prompt evaluation suite '${suiteId}'`);
    const suite = versions.get(suiteVersion);
    if (!suite)
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Prompt evaluation suite '${suiteId}' version ${suiteVersion} is not registered`,
      );
    return suite;
  }

  listSuites(): readonly PromptEvalSuite[] {
    return Object.freeze(
      [...this.#suites.values()]
        .flatMap((versions) => [...versions.values()])
        .sort((left, right) => left.suiteId.localeCompare(right.suiteId) || left.suiteVersion - right.suiteVersion),
    );
  }
}

export interface PromptEvalRunOptions {
  readonly evalRunId?: string;
  readonly prompt?: PromptEvalPromptIdentity | Pick<PromptDefinition, "promptId" | "promptVersion" | "promptHash">;
  readonly observations?: Readonly<Record<string, PromptEvalMetrics>>;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningPolicy?: string;
  readonly requestAccounting?: PromptEvalRequestAccounting;
}

export function runOfflinePromptEval(
  suite: PromptEvalSuite,
  options: PromptEvalRunOptions = {},
): PromptEvalRun {
  if (suite.mode !== "OFFLINE")
    throw new ApplicationError("VALIDATION_FAILED", `Suite '${suite.suiteId}' is not an OFFLINE suite`);
  let defaultPromptVersion = options.prompt?.promptVersion;
  if (defaultPromptVersion === undefined) {
    try {
      defaultPromptVersion = PROMPT_REGISTRY.getCurrentPrompt(suite.agentId).promptVersion;
    } catch (cause) {
      // Retired agents remain evaluable as historical fixtures, but must never
      // become executable through the production registry.
      if (!(cause instanceof ApplicationError)) throw cause;
      const versions = PROMPT_REGISTRY.listPromptVersions(suite.agentId);
      if (versions.length === 0) throw cause;
      defaultPromptVersion = versions.at(-1)!;
    }
  }
  const promptDefinition = PROMPT_REGISTRY.getPrompt(suite.agentId, defaultPromptVersion);
  const prompt = options.prompt ?? promptDefinition;
  let contractVersion = 1;
  try {
    const contract = AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(suite.agentId);
    if (contract.stage !== promptDefinition.stage)
      throw new ApplicationError("PROMPT_STAGE_MISMATCH", `Prompt stage does not match current contract`);
    contractVersion = contract.contractVersion;
  } catch (cause) {
    // Offline historical evaluations may compare a retired prompt after its
    // executable agent has been removed. They retain identity only; they do
    // not create a runnable production resolution.
    if (!(promptDefinition.lifecycle.status === "DEPRECATED" && cause instanceof ApplicationError)) throw cause;
  }
  if (prompt.promptId !== suite.agentId)
    throw new ApplicationError("VALIDATION_FAILED", `Prompt '${prompt.promptId}' does not target '${suite.agentId}'`);
  if (!Number.isInteger(prompt.promptVersion) || prompt.promptVersion <= 0 || !/^[a-f0-9]{64}$/.test(prompt.promptHash))
    throw new ApplicationError("VALIDATION_FAILED", "Prompt evaluation requires an exact prompt version and hash");

  const cases = suite.cases.map((testCase) => {
    const metrics = options.observations?.[testCase.id] ?? testCase.offlineObservation;
    return evaluatePromptEvalCase(testCase, metrics, {
      agentId: suite.agentId,
      contractVersion,
      prompt,
    });
  });
  return deepFreeze({
    evalRunId: options.evalRunId ?? `offline:${suite.suiteId}@${suite.suiteVersion}:${prompt.promptId}@${prompt.promptVersion}`,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    mode: "OFFLINE",
    agentId: suite.agentId,
      contractVersion,
    promptId: prompt.promptId,
    promptVersion: prompt.promptVersion,
    promptHash: prompt.promptHash,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningPolicy ? { reasoningPolicy: options.reasoningPolicy } : {}),
    ...(options.requestAccounting ? { requestAccounting: options.requestAccounting } : {}),
    cases: cases.sort((left, right) => left.caseId.localeCompare(right.caseId)),
  });
}

export function evaluatePromptEvalCase(
  testCase: PromptEvalCase,
  metrics: PromptEvalMetrics,
  identity: {
    readonly agentId: AgentId;
    readonly contractVersion: number;
    readonly prompt: PromptEvalPromptIdentity;
  },
): PromptEvalResult {
  const failures: PromptEvalFailure[] = [];
  for (const assertion of testCase.expected.assertions) {
    const actual = metrics[assertion.metric];
    if (!satisfies(actual, assertion.operator, assertion.expected)) {
      failures.push({
        metric: assertion.metric,
        category: assertion.category,
        expected: assertion.expected,
        ...(actual !== undefined ? { actual } : {}),
        message: `${assertion.metric} expected ${assertion.operator} ${String(assertion.expected)} but was ${String(actual)}`,
      });
    }
  }
  return {
    caseId: testCase.id,
    agentId: identity.agentId,
    contractVersion: identity.contractVersion,
    promptId: identity.prompt.promptId,
    promptVersion: identity.prompt.promptVersion,
    promptHash: identity.prompt.promptHash,
    passed: failures.length === 0,
    metrics,
    assertions: testCase.expected.assertions,
    failures,
  };
}

export function comparePromptEvalRuns(
  baseline: PromptEvalRun,
  candidate: PromptEvalRun,
): PromptEvalComparison {
  if (
    baseline.suiteId !== candidate.suiteId ||
    baseline.suiteVersion !== candidate.suiteVersion ||
    baseline.agentId !== candidate.agentId ||
    baseline.contractVersion !== candidate.contractVersion
  )
    throw new ApplicationError("VALIDATION_FAILED", "Prompt evaluation runs are not comparable");
  if (
    baseline.provider !== candidate.provider ||
    baseline.model !== candidate.model ||
    baseline.reasoningPolicy !== candidate.reasoningPolicy
  )
    throw new ApplicationError(
      "VALIDATION_FAILED",
      "Prompt evaluation runs must use the same provider, model, and reasoning policy",
    );
  const baselineCases = new Map(baseline.cases.map((result) => [result.caseId, result]));
  const candidateCases = new Map(candidate.cases.map((result) => [result.caseId, result]));
  const metricComparisons: PromptEvalMetricComparison[] = [];
  for (const [caseId, baselineResult] of baselineCases) {
    const candidateResult = candidateCases.get(caseId);
    if (!candidateResult) {
      metricComparisons.push({
        caseId,
        metric: "case",
        category: "CONTRACT",
        direction: "EQUAL_REQUIRED",
        status: "MISSING",
      });
      continue;
    }
    const assertions = new Map(
      (findSuiteCaseAssertions(baseline, caseId) ?? []).map((assertion) => [assertion.metric, assertion]),
    );
    const metrics = new Set([...Object.keys(baselineResult.metrics), ...Object.keys(candidateResult.metrics)]);
    for (const metric of metrics) {
      const assertion = assertions.get(metric);
      const direction = assertion?.direction ?? defaultDirection(assertion?.category);
      const category = assertion?.category ?? "QUALITY";
      const before = baselineResult.metrics[metric];
      const after = candidateResult.metrics[metric];
      metricComparisons.push({
        caseId,
        metric,
        category,
        direction,
        ...(before !== undefined ? { baseline: before } : {}),
        ...(after !== undefined ? { candidate: after } : {}),
        status: compareMetric(before, after, direction),
      });
    }
  }
  const regressions = metricComparisons.filter(({ status }) => status === "REGRESSED");
  const safetyRegressions = regressions.filter(({ category }) => category === "SAFETY");
  const qualityRegressions = regressions.filter(({ category }) => category === "QUALITY");
  const budgetRegressions = regressions.filter(({ category }) => category === "BUDGET");
  const improved = metricComparisons.some(({ status }) => status === "IMPROVED");
  const missing = metricComparisons.some(({ status }) => status === "MISSING");
  const status: PromptEvalComparisonStatus =
    missing ? "INCOMPARABLE" : regressions.length > 0 ? "WORSE" : improved ? "BETTER" : "EQUAL";
  return {
    suiteId: baseline.suiteId,
    suiteVersion: baseline.suiteVersion,
    agentId: baseline.agentId,
    baseline: identityOf(baseline),
    candidate: identityOf(candidate),
    status,
    safetyRegressions,
    qualityRegressions,
    budgetRegressions,
    metrics: metricComparisons.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.metric.localeCompare(right.metric)),
  };
}

export function summarizePromptEvalRun(run: PromptEvalRun): PromptEvalSummary {
  const metrics = new Map<string, { observedCount: number; passingCount: number }>();
  for (const result of run.cases) {
    const failedMetrics = new Set(result.failures.map(({ metric }) => metric));
    for (const metric of Object.keys(result.metrics)) {
      const current = metrics.get(metric) ?? { observedCount: 0, passingCount: 0 };
      current.observedCount += 1;
      if (!failedMetrics.has(metric)) current.passingCount += 1;
      metrics.set(metric, current);
    }
  }
  const metricSummary = [...metrics.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metric, value]) => ({
      metric,
      ...value,
      passRate: value.observedCount === 0 ? 0 : value.passingCount / value.observedCount,
    }));
  const passedCases = run.cases.filter(({ passed }) => passed).length;
  return {
    suiteId: run.suiteId,
    suiteVersion: run.suiteVersion,
    agentId: run.agentId,
    caseCount: run.cases.length,
    passedCases,
    failedCases: run.cases.length - passedCases,
    passRate: run.cases.length === 0 ? 0 : passedCases / run.cases.length,
    metrics: metricSummary,
  };
}

export function serializePromptEvalRun(run: PromptEvalRun): string {
  return JSON.stringify(sortKeys({ ...run, cases: [...run.cases].sort((left, right) => left.caseId.localeCompare(right.caseId)) }));
}

function findSuiteCaseAssertions(run: PromptEvalRun, caseId: string): readonly PromptEvalAssertion[] | undefined {
  const result = run.cases.find((item) => item.caseId === caseId);
  return result?.assertions;
}

function identityOf(run: PromptEvalRun): PromptEvalPromptIdentity {
  return { promptId: run.promptId, promptVersion: run.promptVersion, promptHash: run.promptHash };
}

function defaultDirection(category: PromptEvalMetricCategory | undefined): PromptEvalMetricDirection {
  if (category === "BUDGET") return "LOWER_IS_BETTER";
  if (category === "QUALITY") return "HIGHER_IS_BETTER";
  return "EQUAL_REQUIRED";
}

function compareMetric(
  baseline: PromptEvalScalar | undefined,
  candidate: PromptEvalScalar | undefined,
  direction: PromptEvalMetricDirection,
): PromptEvalMetricComparison["status"] {
  if (baseline === undefined || candidate === undefined) return "MISSING";
  if (baseline === candidate) return "UNCHANGED";
  if (typeof baseline !== typeof candidate) return "MISSING";
  if (direction === "EQUAL_REQUIRED") return "REGRESSED";
  if (typeof baseline === "number" && typeof candidate === "number") {
    if (direction === "HIGHER_IS_BETTER") return candidate > baseline ? "IMPROVED" : "REGRESSED";
    if (direction === "LOWER_IS_BETTER") return candidate < baseline ? "IMPROVED" : "REGRESSED";
  }
  return candidate === true ? "IMPROVED" : "REGRESSED";
}

function satisfies(
  actual: PromptEvalScalar | undefined,
  operator: PromptEvalAssertionOperator,
  expected: PromptEvalScalar,
): boolean {
  if (actual === undefined || typeof actual !== typeof expected) return false;
  switch (operator) {
    case "EQUALS":
      return actual === expected;
    case "GREATER_THAN_OR_EQUAL":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "LESS_THAN_OR_EQUAL":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "GREATER_THAN":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "LESS_THAN":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
