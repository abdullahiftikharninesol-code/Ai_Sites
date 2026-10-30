import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import { GatewayAgentProvider } from "../../agents/gateway/gateway-agent.provider.js";
import type { AgentGateway } from "../../agents/gateway/agent-gateway.js";
import type { AgentProviderRegistry } from "../../agents/registry/agent-provider-registry.js";
import { SitesToolExecutor } from "../../agents/tool-executor.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import type { CliTask } from "../protocol/cli-task.js";
import {
  createInferenceRunContext,
  type InferenceRunContext,
} from "../../agents/budget/inference-run-context.js";
import type { InferenceStage } from "../../agents/budget/agent-run-budget.js";
import {
  scaffoldDeterministicReactVite,
  summarizeDesignSystem,
} from "../../sites/scaffold/react-vite-scaffold.js";
import {
  selectEditContextFiles,
  isBroadFunctionalEdit,
  broadFunctionalEditChangesStyle,
  BASELINE_STYLESHEET,
  designTokenExcerpt,
  patchableStyleExcerpt,
  selectEditRepairContext,
  type EditContextFile,
} from "./edit-context-selection.js";

/**
 * Below this much application source (roughly 6k tokens), an edit sends the whole
 * editable project inside the cached prefix instead of a per-instruction
 * selection: the prefix then clears the provider's minimum cacheable length and
 * is reused by every later edit to the same site.
 */
const INLINE_ALL_SOURCE_LIMIT = 24_000;
import {
  buildCompletionRequirements,
  type GenerationCompletionTelemetry,
} from "../../agents/validation/generation-completion.js";
import { normalizeBuildLog } from "./build-log-normalizer.js";
import {
  getInferenceContextPolicy,
  evaluatePreflightBudget,
} from "../../agents/budget/inference-context-policy.js";
import {
  estimateTokensConservative,
  measureRequestSize,
} from "../../agents/budget/token-estimator.js";
import { toGenerationSiteSpec } from "../../sites/domain/site-spec-projection.js";
import {
  resolveAgentPrompt,
  resolveSiteCoderPrompt,
} from "../../agents/prompts/agent-prompt-resolution.js";
import { resolveCapabilities } from "../../sites/generation/capability-resolver.js";
import type { ResolvedCapabilities } from "../../sites/generation/capability-resolver.js";
import { buildResolvedDependencyManifest } from "../../sites/generation/resolved-dependency-manifest.js";
import type { ResolvedDependencyManifest } from "../../sites/generation/resolved-dependency-manifest.js";
import { GeneratedImportValidator } from "../../sites/generation/import-validator.js";
import {
  APPROVED_UI_PACKAGE_VERSIONS,
  materializeOptionalDependencies,
} from "../../sites/generation/optional-dependencies.js";
import { validateAssetReferences } from "../../sites/assets/asset-reference-validator.js";
import { applyDeterministicAutofix, applyDeterministicBuildRepair } from "../../sites/generation/deterministic-autofix.js";
import {
  SITE_CODER_FILE_BUNDLE_JSON_SCHEMA,
  SITE_CODER_EDIT_FILE_BUNDLE_JSON_SCHEMA,
  BUILD_REPAIR_PATCH_BUNDLE_JSON_SCHEMA,
  applyBuildRepairPatchBundle,
  materializeSiteCoderFileBundle,
  validateSiteCoderFileBundle,
  validateSiteCoderBundleCompletion,
  validateBuildRepairPatchBundle,
  SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA,
  applySiteEditPatchBundle,
  validateSiteEditPatchBundle,
  type SiteCoderFileBundle,
  type SiteEditPatchBundle,
} from "./site-coder-file-bundle.js";
import { createBuildRepairSourceSnapshot, type BuildRepairSourceSnapshot } from "./build-repair-source.js";
import type { BuildRepairEvidence } from "./build-repair-patch-resolver.js";
import type { AssetManifest } from "../../sites/assets/asset-domain.js";
import {
  assertStructuredResponseComplete,
  parseStructuredResponse,
  parseStructuredAgentResponse,
} from "../../agents/shared/structured-response-parser.js";
import { SITES_UI_REGISTRY } from "../../sites/generation/sites-ui-registry.js";
import { buildCapabilityAwareGenerationContext } from "./capability-aware-generation-context.js";
import { GENERATION_NAVIGATION_RULES } from "./reference-interaction-validator.js";
import { templateDesignPrompt } from "../../templates/application/template-design-context.js";
import { validateTemplateReferenceBundle } from "../../templates/application/template-reference-generation-contract.js";
import type { FailedCandidateEvidence } from "../../sites/generation/failed-candidate-evidence.js";
import { recordGenerationTelemetry, referenceContextTelemetry, type GenerationDevelopmentTelemetry } from "../../sites/generation/generation-development-telemetry.js";
import {
  parseEditRequirements,
  containsRenameLiteral,
  readEditRequirementFiles,
  validateEditRequirements,
  suppliedEditRequirementContext,
  mandatoryEditRequirements,
  editPlanCoverageDiagnostics,
  editRequirementDiagnostics,
  type EditRequirementContext,
  type EditRequirementDiagnostic,
  type EditRequirementName,
  type EditRequirements,
} from "./edit-requirements.js";
import { isEditableSiteEditPath } from "./site-coder-file-bundle.js";
import { targetedEditScopeGuidance, validateEditScopeCompletion, validateProtectedEditValues } from "./edit-scope.js";
import { analyzeRequestProfile } from "../../sites/generation/request-profile.js";
import { assertFunctionalBackendSupport, functionalGenerationContract, validateFunctionalBackendBundle } from "../../sites/generation/functional-capabilities.js";
import { materializeFunctionalRuntime } from "../../sites/generation/functional-runtime.js";
import { recoverFunctionalPlaceholders } from "../../sites/generation/functional-recovery.js";
import { resolveUsableGenerationSourceContract } from "../../sites/generation/functional-source-contract.js";
import { generationInteractionAdvisories, USABLE_GENERATION_GUIDANCE } from "../../sites/generation/generation-acceptance-policy.js";
import type { ResolvedFunctionalContract } from "../../sites/generation/functional-route-contract.js";
import {
  getDefaultProfile,
  getProfile,
  type GeneratedAppProfile,
} from "./site-technical-profile.js";
export interface CliAgentSessionReport {
  readonly success: boolean;
  readonly provider: string;
  readonly model: string;
  readonly runtime: "LOCAL_CLI";
  readonly turns: number;
  readonly toolCalls: number;
  readonly buildAttempts: number;
  readonly finalBuildSuccess: boolean;
  readonly previewUrl?: string | undefined;
  readonly filesChanged: readonly string[];
  readonly durationMs: number;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly generationCompletion?: GenerationCompletionTelemetry | undefined;
  readonly generationMode?: "FAST_GENERATION" | "ITERATIVE_FALLBACK" | "TARGETED_EDIT";
  readonly deterministicAutofixes?: readonly string[];
  readonly buildRepairInvoked?: boolean;
  readonly functionalContract?: ResolvedFunctionalContract;
  readonly generatedSiteName?: string | undefined;
  readonly generatedDocumentTitle?: string | undefined;
}
export type CliAgentProgressListener = (
  state: "GENERATING" | "BUILDING" | "PREVIEW_READY" | "COMPLETED",
  message: string,
) => void;

export type TargetedEditRepairPreflight = () => Promise<void>;
export type GenerationBehaviorValidation = (candidate: {
  readonly previewUrl: string;
  readonly model: string;
  readonly functionalContract?: ResolvedFunctionalContract;
  readonly completion?: GenerationCompletionTelemetry;
  readonly buildRepair?: BuildRepairEvidence;
}) => Promise<void>;

const generatedDocumentTitle = (bundle: SiteCoderFileBundle): string | undefined => {
  for (const file of bundle.files) {
    const assignment = /document\.title\s*=\s*["'`]([^"'`\r\n]{1,60})["'`]/u.exec(file.content);
    if (assignment?.[1]) return assignment[1];
    const element = /<title[^>]*>([^<\r\n]{1,60})<\/title>/iu.exec(file.content);
    if (element?.[1]) return element[1].trim();
  }
  return undefined;
};

function mergeRequirementDiagnostics(
  ...groups: readonly (readonly EditRequirementDiagnostic[])[]
): readonly EditRequirementDiagnostic[] {
  const merged = new Map<EditRequirementName, EditRequirementDiagnostic>();
  for (const group of groups)
    for (const diagnostic of group) merged.set(diagnostic.requirement, diagnostic);
  return Object.freeze([...merged.values()]);
}

function requirementsForRepair(
  requirements: EditRequirements,
  missing: readonly EditRequirementName[],
): EditRequirements {
  return {
    ...(missing.includes("rename") && requirements.rename ? { rename: requirements.rename } : {}),
    style: missing.includes("style"),
  };
}

function relevantRepairInstruction(
  instruction: string,
  requirements: EditRequirements,
  missing: readonly EditRequirementName[],
): string {
  const lines: string[] = [];
  if (missing.includes("rename") && requirements.rename)
    lines.push(`Rename ${JSON.stringify(requirements.rename.oldLiteral)} to ${JSON.stringify(requirements.rename.newLiteral)}.`);
  if (missing.includes("style")) {
    const fragments = instruction
      .split(/[.!?;\n]+|\s+\band\b\s+/i)
      .map((part) => part.trim())
      .filter((part) => /\b(colou?rs?|accent|palette|theme|visual\s+styl(?:e|ing)|styl(?:e|es|ing))\b/i.test(part));
    lines.push(fragments.length ? `${fragments.join(". ")}.` : "Apply the requested style change.");
  }
  return lines.join("\n");
}

function finalRequirementFailure(
  diagnostics: readonly EditRequirementDiagnostic[],
  attempts: number,
  lastFailureStage: "PLAN" | "COMPLETION" | "REPAIR_CONTEXT" | "REPAIR_RESPONSE",
  repairPaths: readonly string[] = [],
): ApplicationError {
  const first = diagnostics[0];
  const remainingFiles = [...new Set([
    ...diagnostics.flatMap((diagnostic) => {
      const value = diagnostic.metadata.remainingFiles;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    }),
    ...repairPaths,
  ])].sort();
  return new ApplicationError(
    "EDIT_REQUIREMENT_INCOMPLETE",
    first?.message ?? "The targeted edit did not satisfy all mandatory requirements",
    {
      metadata: {
        ...(first?.metadata ?? {}),
        attempts,
        missingRequirements: diagnostics.map(({ requirement }) => requirement),
        ...(remainingFiles.length ? { remainingFiles } : {}),
        lastFailureStage,
      },
    },
  );
}
function finalRepairAttemptError(
  cause: ApplicationError,
  diagnostics: readonly EditRequirementDiagnostic[],
  repairPaths: readonly string[],
): ApplicationError {
  if (cause.metadata?.attempts === 2) return cause;
  const remainingFiles = [...new Set([
    ...diagnostics.flatMap((diagnostic) => {
      const value = diagnostic.metadata.remainingFiles;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    }),
    ...repairPaths,
  ])].sort();
  return new ApplicationError(cause.code, cause.message, {
    retryable: false,
    cause,
    metadata: {
      ...(cause.metadata ?? {}),
      attempts: 2,
      missingRequirements: diagnostics.map(({ requirement }) => requirement),
      ...(remainingFiles.length ? { remainingFiles } : {}),
      lastFailureStage: "REPAIR_RESPONSE",
    },
  });
}

export class LocalCliAgentRuntime {
  constructor(
    private readonly gateway: AgentGateway,
    private readonly providers: AgentProviderRegistry,
    private readonly execution: LocalExecutionProvider,
    private readonly progress?: CliAgentProgressListener,
    private readonly generationDiagnostics?: { readonly evidence?: FailedCandidateEvidence; readonly telemetry?: GenerationDevelopmentTelemetry },
  ) {}
  async run(
    environmentId: string,
    task: CliTask,
    externalSignal?: AbortSignal,
    runContext?: InferenceRunContext,
    repairPreflight?: TargetedEditRepairPreflight,
    validateGenerationBehavior?: GenerationBehaviorValidation,
  ): Promise<CliAgentSessionReport> {
    const deadline = AbortSignal.timeout(task.limits?.timeoutMs ?? 600_000);
    const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;
    if (task.runtime !== "LOCAL_CLI")
      throw new ApplicationError("VALIDATION_FAILED", "Agent task runtime must be LOCAL_CLI");
    const serialized = JSON.stringify(task);
    if (/(OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|XAI|KIMI|GROQ|OPENROUTER)_API_KEY/.test(serialized))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Agent task must not contain provider credential fields",
      );
    const providerId = task.agentProvider ?? "mock";
    const registryId = providerId === "mock" ? "mock-agent" : providerId;
    const capabilities = this.providers.get(registryId).getCapabilities();
    const operation = task.operation === "EDIT_SITE" ? "EDIT_SITE" : "GENERATE_SITE";
    const editRequirements = parseEditRequirements(task.userRequest);
    const requirementSource = operation === "EDIT_SITE"
      ? await readEditRequirementFiles(this.execution, environmentId)
      : undefined;
    const broadFunctionalEdit = operation === "EDIT_SITE" && isBroadFunctionalEdit(task.userRequest);
    const generationStage: InferenceStage =
      task.stage ?? (operation === "EDIT_SITE" ? "TARGETED_EDIT" : "GENERATE_SITE");
    // Resolve the active execution contract and exact prompt before dispatch.
    // Retired specialized stages have no current prompt.
    const runtimePrompt =
      operation === "GENERATE_SITE"
        ? resolveSiteCoderPrompt()
        : resolveAgentPrompt("sites.targeted-edit", { expectedStage: "TARGETED_EDIT" });
    const technicalProfile = resolveRuntimeProfile(task.siteSpec?.technical.profileId);
    const resolvedCapabilities =
      task.siteSpec &&
      (!task.siteSpec.technical.profileId ||
        task.siteSpec.technical.profileId === technicalProfile.id)
        ? resolveCapabilities(task.siteSpec, { profile: technicalProfile })
        : undefined;
    const dependencyManifest = resolvedCapabilities
      ? buildResolvedDependencyManifest(technicalProfile, resolvedCapabilities)
      : undefined;
    const effectiveContext =
      runContext ??
      task.runContext ??
      createInferenceRunContext({
        runId: task.jobId,
        limits: {
          maxModelRequests: task.limits?.maxModelRequests,
          maxLogicalRequests: task.limits?.maxLogicalRequests,
          maxPhysicalRequests: task.limits?.maxPhysicalRequests,
          maxTotalTokens: task.limits?.maxTotalTokens,
          maxContextBytes: task.limits?.maxConversationBytes ?? task.limits?.maxContextBytes,
          timeoutMs: task.limits?.timeoutMs,
        },
        signal,
      });

    const rawGatewayProvider = new GatewayAgentProvider(
      this.gateway,
      {
        jobId: task.jobId,
        siteId: task.siteId,
        provider: providerId,
        operation,
        userRequest: task.userRequest,
      },
      capabilities,
    );

    const gatewayProvider = effectiveContext.createScopedProvider(
      rawGatewayProvider,
      generationStage,
    );
    const tools = new SitesToolExecutor(this.execution, {
      maxObservationBytes: task.limits?.maxLogBytes ?? 16_000,
      maxFilesWritten: task.limits?.maxFiles ?? 30,
      maxTotalWrittenBytes: task.limits?.maxTotalWrittenBytes ?? 1_000_000,
      maxBuildAttempts: 1 + (task.limits?.maxBuildRepairs ?? 1),
      compactObservations: true,
      managedFiles: technicalProfile.files.managed,
      stage: generationStage,
      onToolStart: (name) => {
        if (name === "run_build") this.progress?.("BUILDING", "Running real local build");
      },
    });
    const functional = operation === "GENERATE_SITE"
      ? task.siteSpec?.requirements.functional ?? analyzeRequestProfile(task.userRequest).functional
      : analyzeRequestProfile(task.userRequest).functional;
    if (operation === "GENERATE_SITE") {
      assertFunctionalBackendSupport(functional, task.siteSpec);
      await scaffoldDeterministicReactVite(this.execution, environmentId, {
        ...(task.siteSpec?.project.name ? { projectName: task.siteSpec.project.name } : {}),
        designSeed: task.userRequest,
      });
      if (dependencyManifest?.capabilities.some(({ id }) => id === "ui"))
        await SITES_UI_REGISTRY.materialize(this.execution, environmentId, technicalProfile);
      await materializeFunctionalRuntime(this.execution, environmentId, task.siteId);
    }
    const before = new Map<string, string>();
    const scaffoldHashes: Record<string, string> = {};
    for (const entry of (await this.execution.listFiles(environmentId)).filter(
      (item) => item.type === "FILE",
    )) {
      if ((entry.sizeBytes ?? 0) <= (task.limits?.maxFileBytes ?? 64_000)) {
        const content = await this.execution.readFile(environmentId, entry.path);
        before.set(entry.path, content);
        const normalizedPath = entry.path.replace(/\\/g, "/");
        const hash = createHash("sha256").update(content).digest("hex");
        scaffoldHashes[normalizedPath] = hash;
        scaffoldHashes[entry.path] = hash;
      }
    }
    const completionRequirements =
      operation === "GENERATE_SITE" && task.siteSpec && task.generationMode !== "ITERATIVE_FALLBACK"
        ? buildCompletionRequirements(task.siteSpec, scaffoldHashes)
        : undefined;

    const stagePolicy = getInferenceContextPolicy(generationStage, {
      completionRequirements,
      siteSpec: task.siteSpec,
      overrideMaxOutput: broadFunctionalEdit ? Math.max(task.limits?.maxOutputTokens ?? 0, 12_288) : task.limits?.maxOutputTokens,
      overrideReasoning: task.reasoningPolicy,
    });

    const projectedSiteSpec = task.siteSpec
      ? toGenerationSiteSpec(task.siteSpec, completionRequirements)
      : undefined;

    const discovered = await this.#discoverContext(
      environmentId,
      task,
      operation,
      technicalProfile,
      resolvedCapabilities,
      dependencyManifest,
      task.assetManifest,
    );
    const context = discovered.text;
    const functionalGuidance = operation === "GENERATE_SITE" ? functionalGenerationContract(functional) : "";

    const promptForEstimation = [
      runtimePrompt.prompt.systemPrompt,
      JSON.stringify(stagePolicy.tools),
      `Operation: ${operation === "EDIT_SITE" ? "EDIT" : "GENERATE"}`,
      `User request: ${task.userRequest}`,
      projectedSiteSpec ? `SiteSpec: ${JSON.stringify(projectedSiteSpec)}` : "",
      context,
      functionalGuidance,
    ].join("\n");

    const conservativeEstimatedInput = estimateTokensConservative(promptForEstimation);
    const requestedOutputAllowance = stagePolicy.outputPolicy.defaultMaxOutputTokens;
    const minSafeOutput = stagePolicy.outputPolicy.minOutputTokens;
    const reasoningAllowance =
      stagePolicy.reasoningPolicy === "LOW"
        ? 512
        : stagePolicy.reasoningPolicy === "MEDIUM" || stagePolicy.reasoningPolicy === "AUTO"
          ? 1_024
          : 0;
    const safetyMargin = stagePolicy.outputPolicy.safetyMarginTokens;

    const remainingBudget =
      effectiveContext.budget.limits.maxTotalTokens - effectiveContext.budget.usage.totalTokens;

    const preflight = evaluatePreflightBudget({
      stage: generationStage,
      conservativeEstimatedInputTokens: conservativeEstimatedInput,
      requestedOutputAllowance,
      minSafeOutputTokens: minSafeOutput,
      reasoningAllowanceTokens: reasoningAllowance,
      safetyMarginTokens: safetyMargin,
      remainingBudgetTokens: remainingBudget,
    });

    if (!preflight.ok) {
      effectiveContext.budget.markExhausted("TOTAL_TOKEN_LIMIT");
      throw new ApplicationError(
        "AGENT_RUN_BUDGET_EXCEEDED",
        `Inference preflight budget check failed for ${generationStage}: ${preflight.reason}`,
        {
          metadata: {
            stage: generationStage,
            remainingTokens: remainingBudget,
            requiredTokens: preflight.requiredTokens,
            minSafeOutput,
            reason: preflight.reason,
          },
        },
      );
    }

    const requestSizeTelemetry = measureRequestSize({
      stage: generationStage,
      systemInstructions: runtimePrompt.prompt.systemPrompt,
      toolSchemas: JSON.stringify(stagePolicy.tools),
      siteSpecContent: projectedSiteSpec ? JSON.stringify(projectedSiteSpec) : undefined,
      workspaceContext: context,
      messages: [{ role: "user", content: task.userRequest }],
      requestedMaxOutputTokens: requestedOutputAllowance,
      reasoningPolicy: stagePolicy.reasoningPolicy,
      remainingRunBudgetTokens: remainingBudget,
    });

    const startingMetrics = this.execution.getUsageMetrics(environmentId);
    const started = Date.now();
    // All live generation/edit operations use one bounded structured response.
    // The parser handles native schema, JSON mode, and strict JSON text fallback;
    // provider capability never reactivates the old tool loop.
    const boundedStructuredOperation = operation === "GENERATE_SITE" || operation === "EDIT_SITE";
    let bundle: SiteCoderFileBundle | undefined;
    let generationCompletion: GenerationCompletionTelemetry | undefined;
    let generationAttempts = 1;
    let editRepairRequirements: readonly EditRequirementName[] = [];
    let rejectedGenerationAttempts = 0;
    let directUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let directModel = capabilities.models[0] ?? "unknown";
    let requirementRepairRequestSize: ReturnType<typeof measureRequestSize> | undefined;
    let generatedCandidate: SiteCoderFileBundle | undefined;
    let functionalContract: ResolvedFunctionalContract | undefined;
    const functionalAutofixes: string[] = [];
    // Static navigation/control and compiler failures share the existing repair allowance.
    // Spending it before materialization must not create another build-repair slot.
    const maxBuildRepairs = task.limits?.maxBuildRepairs ?? 1;
    let repairModelCalls = 0;
    let repairInputTokens = 0;
    let repairCachedInputTokens = 0;
    let repairOutputTokens = 0;
    let buildRepairEvidence: BuildRepairEvidence | undefined;
    let buildRepairSnapshot: BuildRepairSourceSnapshot | undefined;
    const requestSourceRepair = async (output: string, snapshot: BuildRepairSourceSnapshot, kind: BuildRepairEvidence["kind"] = "build") => {
      buildRepairSnapshot = snapshot;
      buildRepairEvidence = { attempt: repairModelCalls + 1, kind, sourceRevision: snapshot.revision, contextDigest: snapshot.contextDigest,
        requestSnapshot: snapshot,
        initialDiagnostics: output.slice(0, 8_000), billingState: "NOT_FINALIZED", result: "REQUESTED", patches: [] };
      const repairPrompt = resolveAgentPrompt("sites.build-repair", { expectedStage: "BUILD_REPAIR" });
      const repairProvider = effectiveContext.createScopedProvider(rawGatewayProvider, "BUILD_REPAIR");
      const repairPolicy = getInferenceContextPolicy("BUILD_REPAIR", { overrideMaxOutput: task.limits?.maxOutputTokens });
      const responseContract = {
        type: "JSON_SCHEMA" as const, name: "BuildRepairPatchBundle",
        schema: BUILD_REPAIR_PATCH_BUNDLE_JSON_SCHEMA, strict: true,
      };
      const response = await repairProvider.createResponse({
        model: capabilities.models[0] ?? "unknown",
        systemInstructions: repairPrompt.prompt.systemPrompt,
        messages: [{ role: "user", content: [
          "Return exactly one JSON BuildRepairPatchBundle. Do not call tools.",
           kind === "functional"
             ? "Repair the reported functional completion/Browser QA failures. Implement the requested behavior on its assigned route and preserve working content/design. Fix real behavior, not only selected classes or empty markup. Honor explicit panel relationships and restore open/close state. Never remove requirements, controls, validation, or accessibility to obtain a pass."
             : kind === "navigation"
            ? "Only repair the reported missing navigation destinations. Keep the existing design and working functionality. Implement meaningful visible content for existing links, or a real semantic button with working state for actions. Do not insert fake/empty IDs, disable links, redirect to unrelated sections, or remove requested functionality."
            : kind === "interaction"
              ? "Complete every reported inert control with meaningful working React behavior or a real navigation destination. Preserve the existing design and working functionality. Use the managed functional APIs below where relevant. For support/story/size controls provide genuine relevant content; demo checkout must show honest no-payment feedback, never claim a transaction. Social navigation needs an actual supplied destination, not a fabricated URL. Do not remove or disable controls, add no-op/alert-only handlers, or redirect to unrelated content to satisfy validation."
            : "Only repair the reported build failure. For JSX syntax diagnostics, correct the exact mismatched delimiter/tag; do not simplify or rewrite a page. Preserve every existing form field, its required validation, state binding and handler, including optional fields. Do not modify managed files, package manifests, or dependencies.",
           functionalGenerationContract(functional),
          "Do not modify managed files, package manifests, or dependencies. Patch only the supplied application source.",
          "Address every reported diagnostic, and leave each patched file syntactically complete: balanced JSX tags, braces, and parentheses.",
          "Each 'find' must copy a unique, contiguous verbatim anchor from the supplied source snapshot, including surrounding context when text repeats. Headers are not source. Reference only these exact paths; never guess an extension. All patches refer to this same snapshot: combine overlapping changes; do not target text created by an earlier patch.",
          `Source revision: ${snapshot.revision}`,
          `${kind === "build" ? "Build output" : kind === "functional" && output.startsWith("Browser QA") ? "Browser QA diagnostics" : "Static validation diagnostics"}:\n${output}`,
          dependencyManifest ? `Current dependency manifest:\n${JSON.stringify({
            dependencies: dependencyManifest.dependencies, devDependencies: dependencyManifest.devDependencies,
          })}` : "",
          snapshot.context ? `Relevant source files:\n${snapshot.context}` : "",
        ].filter(Boolean).join("\n\n") }],
        maxOutputTokens: repairPolicy.outputPolicy.defaultMaxOutputTokens,
        reasoningPolicy: repairPolicy.reasoningPolicy,
        responseContract,
        ...(signal ? { signal } : {}),
      });
      repairModelCalls += 1;
      repairInputTokens += response.usage.inputTokens;
      repairCachedInputTokens += response.usage.cachedInputTokens ?? 0;
      repairOutputTokens += response.usage.outputTokens;
      buildRepairEvidence = { ...buildRepairEvidence, result: "RESPONSE_RECEIVED" };
      try {
        assertStructuredResponseComplete(response, "Build repair");
        const proposal = parseStructuredResponse({
          content: response.message.content, contract: responseContract,
          capability: capabilities.structuredOutputCapability ?? "FALLBACK_TEXT",
          validate: validateBuildRepairPatchBundle, errorContext: "Build repair",
        }).value;
        buildRepairEvidence = { ...buildRepairEvidence, proposal };
        return proposal;
      } catch (cause) { buildRepairEvidence = { ...buildRepairEvidence, result: "INVALID_RESPONSE" }; throw cause; }
    };
    const referenceText = task.templateDesignReference ? templateDesignPrompt(task.templateDesignReference.design) : undefined;
    let contextTelemetry = referenceContextTelemetry(task.templateDesignReference?.design);
    try {
    this.progress?.("GENERATING", operation === "EDIT_SITE" ? "Applying bounded edit patch" : "Generating bounded source file bundle");
    if (boundedStructuredOperation) {
      const responseContract = operation === "EDIT_SITE" && !broadFunctionalEdit ? {
        type: "JSON_SCHEMA" as const,
        name: "SiteEditPatchBundle",
        schema: SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA,
        strict: true,
      } : {
        type: "JSON_SCHEMA" as const,
        name: "SiteCoderFileBundle",
        schema: operation === "GENERATE_SITE"
          ? SITE_CODER_FILE_BUNDLE_JSON_SCHEMA
          : SITE_CODER_EDIT_FILE_BUNDLE_JSON_SCHEMA,
        strict: true,
      };
      // Everything ahead of the boundary repeats across requests for this site,
      // so it is sent first and marked as a reusable prefix.
      const stableLead = [
        operation === "EDIT_SITE" && broadFunctionalEdit
          ? "Return exactly one JSON object matching the SiteCoderFileBundle schema. This is a broad functional edit of the existing site: return complete contents only for editable source files you change. Preserve its design, text, and layout. Do not call tools."
          : operation === "EDIT_SITE"
            ? "Return exactly one JSON object matching the SiteEditPatchBundle schema. Make the smallest requested source edit and do not call tools."
            : "Return exactly one JSON object matching the SiteCoderFileBundle schema, including a compact siteName that identifies the generated website. Do not call tools.",
        operation === "EDIT_SITE" && broadFunctionalEdit
          ? "Make the existing visible navigation and controls genuinely interactive using React state and local browser storage where appropriate. Provide working view changes, search/filtering, menus, dialogs and form actions that fit the existing UI; do not claim a remote backend exists. Keep the original JSX shell, className values, sections, and visual treatment. For functionality-only edits, never rewrite an existing stylesheet; add and import a new CSS file only if new controls need styles. Do not modify Sites-managed files or dependency manifests."
          : operation === "EDIT_SITE"
          ? [
              "Patch requested editable source files and root index.html branding only; never modify package manifests, configuration, lockfiles, or other Sites-managed files.",
              "Every 'find' must match the file byte-for-byte, including whitespace and JSX entities such as &amp;.",
              'With mode "unique" the find text must occur exactly once in that file, so anchor it: include the surrounding attribute, tag or line rather than a bare word. `Menu` alone will match many times; `<a href="#menu">Menu</a>` identifies one place.',
              'For a global brand rename, use mode "all" per relevant file. For a local edit, include the component/section/tag or CSS selector and declaration in a uniquely matching find; widen duplicate text anchors. Never rely on the first match or use "all" to hide local ambiguity.',
              "Use one patch per distinct change; several patches may target the same file.",
            ].join(" ")
          : "Write only editable application source files. Never modify package manifests, configuration, lockfiles, or Sites-managed files.",
        operation === "GENERATE_SITE"
          ? [
              "The existing React + TypeScript + Vite scaffold supplies src/main.tsx, baseline src/styles.css, and project configuration.",
              "The bundle must contain a complete, non-empty src/App.tsx application entry component.",
              "You may add components, views, pages, and custom CSS files. Every local import you add must resolve to a file in this bundle or the documented scaffold.",
              "Return compilable TypeScript/TSX, use React state for requested demo interactions, and do not regenerate unchanged scaffold boilerplate.",
              "Every control you add, including story/support/size-guide/footer controls, must work. Only include social links with supplied destinations; do not invent them. A demo checkout must provide honest visible no-payment feedback, not an inert Checkout button or a fake transaction.",
              "In JSX text, write < and > as &lt; and &gt; and { } as &#123; &#125;; copy such as \"go live in <5 minutes\" is a TypeScript syntax error. Keep every JSX tag, brace, and parenthesis balanced.",
            ].join(" ")
          : "",
        functionalGuidance,
        operation === "GENERATE_SITE"
          ? [
              "Approved optional packages, installed only if you import them — use only what the request actually needs:",
              "- lucide-react: interface icons. Prefer it over emoji or hand-written SVG icons, and keep one icon style per site.",
              "- radix-ui: accessible interactive primitives (Accordion, Dialog, AlertDialog, DropdownMenu, Tabs, Tooltip, Popover, Select, Switch, Checkbox), imported as `import { Accordion } from \"radix-ui\"`. Use for real interaction such as an FAQ accordion or a confirmation dialog, never for static cards or layout. Style them with the design tokens.",
              "- recharts: charts. Use only when the site genuinely visualises data, such as a dashboard or report; never on ordinary marketing, restaurant or portfolio pages. Wrap charts in ResponsiveContainer and label axes.",
              "- sonner: transient action feedback such as \"Settings saved\". Render <Toaster /> once in src/App.tsx when you use it, and never use a toast for content the page must keep showing.",
              "No other packages are available.",
            ].join("\n")
          : "",
        `Workspace context:\n${context.slice(0, discovered.stableChars)}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const imageParts = task.referenceImages ?? [];
      if (imageParts.length && (!capabilities.vision || imageParts.some((part) => !capabilities.visionInputMimeTypes?.includes(part.mimeType))))
        throw new ApplicationError("UNSUPPORTED_CAPABILITY", "The selected coding model cannot read design reference images");
      const primaryMessage = {
        role: "user" as const,
        content: [
          stableLead,
          context.slice(discovered.stableChars),
          operation === "EDIT_SITE" && discovered.editRequirementContext
            ? mandatoryEditRequirements(editRequirements, discovered.editRequirementContext) : "",
          operation === "EDIT_SITE" && editRequirements.scope ? targetedEditScopeGuidance(editRequirements.scope) : "",
          operation === "GENERATE_SITE" && completionRequirements ? `Required pages/views: ${completionRequirements.requiredPages.join(", ")}\nRequired sections/features: ${completionRequirements.requiredSections.join(", ")}. Implement these semantically using appropriate React routes, state, tabs, views, or components. Legacy data-sites-page and data-sites-section attributes are optional and are not required.` : "",
          // A targeted edit works from current source, not from the original brief.
          projectedSiteSpec && operation === "GENERATE_SITE"
            ? `SiteSpec: ${JSON.stringify(projectedSiteSpec)}`
            : "",
          `User request: ${task.userRequest}`,
          ...(imageParts.length ? [
            "DESIGN REFERENCE: The attached image shows the website to build. Recreate the whole visible page as responsive React components and CSS, including its page shell, section order, background tone, typography, spacing, buttons, and detailed interface elements. If the screenshot contains an app preview inside a hero, rebuild that preview as UI within the hero; do not turn the entire page into the app or replace the hero with the screenshot. Treat generic SiteSpec style and scaffold art direction as fallback only where the reference is silent. Do not use the reference bitmap as an img, background, canvas, animation frame, or decorative overlay. Do not substitute a new visual concept. Avoid entrance and background animations unless the user asks for motion.",
            "FUNCTIONAL REFERENCE REQUIREMENT: Follow the visual reference AND implement every visible navigation destination and control as a usable React page/view or action. A screenshot of one page does not limit the site to one functional page. Make search filter relevant data, buttons open real dialogs or navigate, forms validate and submit to approved/local state, and tabs/menus change content. Persist demo changes in localStorage where appropriate. Do not output placeholder hrefs, inert buttons, alert-only actions, or claims of live backend features that are not available.",
          ] : []),
        ].filter(Boolean).join("\n\n"),
        ...(imageParts.length ? { imageParts } : {}),
      };
      if (operation === "GENERATE_SITE") {
        contextTelemetry = referenceContextTelemetry(task.templateDesignReference?.design, referenceText && primaryMessage.content.includes(referenceText) ? referenceText : undefined);
        recordGenerationTelemetry(this.generationDiagnostics?.telemetry, { jobId: task.jobId, role: "sites.site-coder", model: capabilities.models[0], ...contextTelemetry });
      }
      let response = await gatewayProvider.createResponse({
        model: capabilities.models[0] ?? "unknown",
        systemInstructions: operation === "GENERATE_SITE" ? runtimePrompt.prompt.systemPrompt + "\n\n" + USABLE_GENERATION_GUIDANCE : runtimePrompt.prompt.systemPrompt,
        promptCacheKey: `sites:${task.siteId}:${operation}`,
        cachePrefixChars: stableLead.length + 2,
        messages: [primaryMessage],
        maxOutputTokens: requestedOutputAllowance,
        reasoningPolicy: stagePolicy.reasoningPolicy,
        responseContract,
        ...(signal ? { signal } : {}),
      });
      let parsed = parseStructuredAgentResponse<SiteCoderFileBundle | SiteEditPatchBundle>({
        response,
        contract: responseContract,
        capability: capabilities.structuredOutputCapability ?? "FALLBACK_TEXT",
        validate: (value) => operation === "EDIT_SITE" && !broadFunctionalEdit
          ? validateSiteEditPatchBundle(value)
          : validateSiteCoderFileBundle(value, completionRequirements),
        errorContext: operation === "EDIT_SITE" ? "Site edit" : "Site coder",
      }).value;
      if (operation === "GENERATE_SITE") {
        const recovered = recoverFunctionalPlaceholders(parsed as SiteCoderFileBundle, task.userRequest);
        parsed = recovered.bundle; generatedCandidate = recovered.bundle;
        functionalAutofixes.push(...recovered.fixes);
      }
      const responses = [response];
      if (operation === "GENERATE_SITE" && imageParts.length) {
        try {
          generationInteractionAdvisories(parsed as SiteCoderFileBundle);
        } catch (cause) {
          if (!(cause instanceof ApplicationError) || cause.code !== "GENERATION_INCOMPLETE") throw cause;
          generationAttempts = 2;
          rejectedGenerationAttempts = 1;
          this.progress?.("GENERATING", "Repairing non-functional reference controls");
          response = await gatewayProvider.createResponse({
            model: capabilities.models[0] ?? "unknown",
            systemInstructions: runtimePrompt.prompt.systemPrompt,
            promptCacheKey: `sites:${task.siteId}:${operation}`,
            cachePrefixChars: stableLead.length + 2,
            messages: [
              primaryMessage,
              { role: "assistant", content: response.message.content },
              { role: "user", content: [
                "The previous SiteCoderFileBundle was rejected because reference-based sites must be functional.",
                cause.message,
                "Return the complete corrected SiteCoderFileBundle. Preserve the reference design and all working code, but replace every reported inert control with a meaningful React action, navigation destination, dialog, state change, or valid form submission. Do not use alert-only handlers or placeholder links.",
              ].join("\n\n") },
            ],
            maxOutputTokens: requestedOutputAllowance,
            reasoningPolicy: stagePolicy.reasoningPolicy,
            responseContract,
            ...(signal ? { signal } : {}),
          });
          responses.push(response);
          assertStructuredResponseComplete(response, "Reference interaction repair");
          parsed = parseStructuredResponse<SiteCoderFileBundle>({
            content: response.message.content,
            contract: responseContract,
            capability: capabilities.structuredOutputCapability ?? "FALLBACK_TEXT",
            validate: (value) => validateSiteCoderFileBundle(value, completionRequirements),
            errorContext: "Reference interaction repair",
          }).value;
          generatedCandidate = parsed;
          const recovered = recoverFunctionalPlaceholders(parsed, task.userRequest);
          parsed = recovered.bundle; generatedCandidate = recovered.bundle; functionalAutofixes.push(...recovered.fixes);
          generationInteractionAdvisories(parsed);
        }
      }
      const initialPlanDiagnostics = operation === "EDIT_SITE" && discovered.editRequirementContext
        ? editPlanCoverageDiagnostics(
            editRequirements,
            discovered.editRequirementContext,
            "patches" in parsed ? parsed.patches : parsed.files,
          )
        : [];
      if (operation === "GENERATE_SITE") {
        try {
          generationInteractionAdvisories(parsed as SiteCoderFileBundle);
          if (task.siteSpec?.requirements.functional) resolveUsableGenerationSourceContract(task.siteSpec, parsed as SiteCoderFileBundle);
        } catch (cause) {
          if (!(cause instanceof ApplicationError) || cause.code !== "GENERATION_INCOMPLETE" ||
            !["navigation.fragments", "interaction.controls", "functional.completion"].includes(String(cause.metadata?.validationCheck)) || repairModelCalls >= maxBuildRepairs) throw cause;
          const kind = cause.metadata?.validationCheck === "functional.completion" ? "functional" : cause.metadata?.validationCheck === "interaction.controls" ? "interaction" : "navigation";
          this.progress?.("GENERATING", "Repairing incomplete navigation/controls within the build-repair allowance");
          const candidate = parsed as SiteCoderFileBundle;
          // The public error abbreviates after five findings. The repair must see
          // all bounded findings, including footer controls beyond that summary.
          const findings = cause.metadata?.findings;
          const diagnostics = [cause.message, ...(Array.isArray(findings) ? findings.filter((item): item is string => typeof item === "string").slice(0, 25) : [])].join("\n");
          const repairContext = await this.#extractRepairContext(environmentId, diagnostics, candidate);
          const patches = await requestSourceRepair(diagnostics, repairContext, kind);
          // Repair the uncommitted bundle in memory. Invalid source never replaces
          // the working scaffold/current project and never bypasses normal checks.
          const files = new Map(candidate.files.map(file => [file.path, file.content]));
          await applyBuildRepairPatchBundle({
            readFile: (_environmentId, path) => {
              const content = files.get(path);
              if (content === undefined) throw new ApplicationError("VALIDATION_FAILED", `Source repair targeted a file outside the candidate: ${path}`);
              return Promise.resolve(content);
            },
            writeFile: (_environmentId, path, content) => { files.set(path, content); return Promise.resolve(); },
          }, environmentId, patches, repairContext, diagnostics => {
            if (buildRepairEvidence) buildRepairEvidence = { ...buildRepairEvidence, patches: diagnostics, result: "PATCH_PREFLIGHT" };
          });
          if (buildRepairEvidence) buildRepairEvidence = { ...buildRepairEvidence, result: "APPLIED" };
          generatedCandidate = { ...candidate, files: [...files].map(([path, content]) => ({ path, content })) };
          parsed = validateSiteCoderFileBundle(generatedCandidate, completionRequirements);
          const recovered = recoverFunctionalPlaceholders(parsed, task.userRequest);
          parsed = recovered.bundle; generatedCandidate = recovered.bundle;
          functionalAutofixes.push(...recovered.fixes);
          generationInteractionAdvisories(parsed);
        }
      }
      if (operation === "GENERATE_SITE") {
        generationInteractionAdvisories(parsed as SiteCoderFileBundle);
        validateFunctionalBackendBundle(parsed as SiteCoderFileBundle, functional);
        if (task.siteSpec?.requirements.functional) functionalContract = resolveUsableGenerationSourceContract(task.siteSpec, parsed as SiteCoderFileBundle);
      }
      if (operation === "GENERATE_SITE" && task.templateDesignReference)
        validateTemplateReferenceBundle(parsed as SiteCoderFileBundle, task.templateDesignReference, task.userRequest, { acceptance: "USABLE_WEBSITE" });
      if (operation === "EDIT_SITE" && !broadFunctionalEdit) {
        await applySiteEditPatchBundle(this.execution, environmentId, parsed as SiteEditPatchBundle, {
          instruction: task.userRequest, rename: editRequirements.rename,
          requirementSource,
          onScopeExclusion: excludedOperationCount => recordGenerationTelemetry(this.generationDiagnostics?.telemetry, {
            jobId: task.jobId, role: "sites.targeted-edit", validationCategory: "INDEPENDENT_UNAUTHORIZED_OPERATION_EXCLUDED", excludedOperationCount,
          }),
          relevantPaths: discovered.editSourcePaths ?? [],
        });
      } else {
        const submittedBundle = parsed as SiteCoderFileBundle;
        const generatedBundle = broadFunctionalEdit && !broadFunctionalEditChangesStyle(task.userRequest)
          ? { ...submittedBundle, files: submittedBundle.files.filter((file) => !file.path.endsWith(".css") || !before.has(file.path)) }
          : submittedBundle;
        if (!generatedBundle.files.length)
          throw new ApplicationError("VALIDATION_FAILED", "The functionality edit did not include an application source file");
        bundle = generatedBundle;
        await materializeSiteCoderFileBundle(this.execution, environmentId, generatedBundle);
      }
      if (operation === "EDIT_SITE" && requirementSource) {
        const candidate = await readEditRequirementFiles(this.execution, environmentId);
        const missingDiagnostics = mergeRequirementDiagnostics(
          initialPlanDiagnostics,
          editRequirementDiagnostics(editRequirements, requirementSource, candidate),
        );
        if (missingDiagnostics.length) {
          const missingRequirements = missingDiagnostics.map(({ requirement }) => requirement);
          editRepairRequirements = missingRequirements;
          const repairSelection = selectEditRepairContext(
            editRequirements,
            missingRequirements,
            candidate,
            discovered.editRequirementContext ?? { renamePaths: [], stylePaths: [] },
            task.limits?.maxFileBytes !== undefined
              ? { maxFileBytes: task.limits.maxFileBytes }
              : {},
          );
          if (!repairSelection.files.length)
            throw finalRequirementFailure(missingDiagnostics, 1, "REPAIR_CONTEXT");

          // The edit-level billing/quota guard is checked again immediately
          // before the sole automatic repair. The scoped provider then reserves
          // the second logical/physical request from the same inference budget.
          await repairPreflight?.();
          const repairRequirements = requirementsForRepair(editRequirements, missingRequirements);
          const repairInstruction = relevantRepairInstruction(
            task.userRequest,
            editRequirements,
            missingRequirements,
          );
          const repairMessage = [
            "TARGETED EDIT REQUIREMENT REPAIR: attempt 2 of 2. No further repair call is allowed.",
            "Return exactly one JSON object matching the SiteEditPatchBundle schema. Do not call tools.",
            `MISSING MANDATORY REQUIREMENTS:\n${missingRequirements.map((item) => item.toUpperCase()).join("\n")}`,
            repairInstruction ? `Relevant user instruction:\n${repairInstruction}` : "",
            mandatoryEditRequirements(repairRequirements, repairSelection.requirementContext),
            editRequirements.scope ? targetedEditScopeGuidance(editRequirements.scope) : "",
            "Operate against the current uncommitted candidate source below. Return only additional exact edit operations needed for the missing requirements. Do not repeat completed edits unless technically necessary. Every find must match byte-for-byte; do not use fuzzy matching or regenerate whole files.",
            `Current candidate source for repair:\n${repairSelection.text}`,
          ].filter(Boolean).join("\n\n");
          const repairOutputAllowance = Math.min(requestedOutputAllowance, 4_096);
          const repairEstimatedInput = estimateTokensConservative([
            runtimePrompt.prompt.systemPrompt,
            JSON.stringify(stagePolicy.tools),
            repairMessage,
          ].join("\n"));
          const repairRemainingBudget =
            effectiveContext.budget.limits.maxTotalTokens - effectiveContext.budget.usage.totalTokens;
          const repairBudget = evaluatePreflightBudget({
            stage: "TARGETED_EDIT",
            conservativeEstimatedInputTokens: repairEstimatedInput,
            requestedOutputAllowance: repairOutputAllowance,
            minSafeOutputTokens: minSafeOutput,
            reasoningAllowanceTokens: reasoningAllowance,
            safetyMarginTokens: safetyMargin,
            remainingBudgetTokens: repairRemainingBudget,
          });
          if (!repairBudget.ok) {
            effectiveContext.budget.markExhausted("TOTAL_TOKEN_LIMIT");
            throw new ApplicationError(
              "AGENT_RUN_BUDGET_EXCEEDED",
              `Inference preflight budget check failed for TARGETED_EDIT repair: ${repairBudget.reason}`,
              { metadata: {
                stage: "TARGETED_EDIT",
                attempt: 2,
                remainingTokens: repairRemainingBudget,
                requiredTokens: repairBudget.requiredTokens,
                minSafeOutput,
                reason: repairBudget.reason,
              } },
            );
          }
          requirementRepairRequestSize = measureRequestSize({
            stage: "TARGETED_EDIT",
            systemInstructions: runtimePrompt.prompt.systemPrompt,
            toolSchemas: JSON.stringify(stagePolicy.tools),
            workspaceContext: repairSelection.text,
            messages: [{ role: "user", content: repairMessage }],
            requestedMaxOutputTokens: repairOutputAllowance,
            reasoningPolicy: stagePolicy.reasoningPolicy,
            remainingRunBudgetTokens: repairRemainingBudget,
          });
          this.progress?.("GENERATING", "Repairing incomplete mandatory edit requirements (2/2)");
          try {
            generationAttempts = 2;
            const repairResponse = await gatewayProvider.createResponse({
              model: capabilities.models[0] ?? "unknown",
              systemInstructions: runtimePrompt.prompt.systemPrompt,
              promptCacheKey: `sites:${task.siteId}:${operation}:requirement-repair`,
              messages: [{ role: "user", content: repairMessage }],
              maxOutputTokens: repairOutputAllowance,
              reasoningPolicy: stagePolicy.reasoningPolicy,
              responseContract: {
                type: "JSON_SCHEMA" as const,
                name: "SiteEditPatchBundle",
                schema: SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA,
                strict: true,
              },
              ...(signal ? { signal } : {}),
            });
            responses.push(repairResponse);
            const repairBundle = parseStructuredAgentResponse({
              response: repairResponse,
              contract: {
                type: "JSON_SCHEMA" as const,
                name: "SiteEditPatchBundle",
                schema: SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA,
                strict: true,
              },
              capability: capabilities.structuredOutputCapability ?? "FALLBACK_TEXT",
              validate: validateSiteEditPatchBundle,
              errorContext: "Targeted edit requirement repair",
            }).value;
            const repairPlanDiagnostics = editPlanCoverageDiagnostics(
              repairRequirements,
              repairSelection.requirementContext,
              repairBundle.patches,
            );
            if (repairPlanDiagnostics.length)
              throw finalRequirementFailure(
                mergeRequirementDiagnostics(repairPlanDiagnostics, missingDiagnostics),
                2,
                "PLAN",
                repairSelection.files.map(({ path }) => path),
              );
            await applySiteEditPatchBundle(this.execution, environmentId, repairBundle, {
              instruction: task.userRequest, rename: editRequirements.rename,
              requirementSource,
              onScopeExclusion: excludedOperationCount => recordGenerationTelemetry(this.generationDiagnostics?.telemetry, {
                jobId: task.jobId, role: "sites.targeted-edit", validationCategory: "INDEPENDENT_UNAUTHORIZED_OPERATION_EXCLUDED", excludedOperationCount,
              }),
              relevantPaths: repairSelection.files.map(file => file.path),
            });
            const finalCandidate = await readEditRequirementFiles(this.execution, environmentId);
            const finalDiagnostics = editRequirementDiagnostics(
              editRequirements,
              requirementSource,
              finalCandidate,
            );
            if (finalDiagnostics.length)
              throw finalRequirementFailure(
                finalDiagnostics,
                2,
                "COMPLETION",
                repairSelection.files.map(({ path }) => path),
              );
          } catch (cause) {
            if (cause instanceof ApplicationError)
              throw finalRepairAttemptError(
                cause,
                missingDiagnostics,
                repairSelection.files.map(({ path }) => path),
              );
            throw cause;
          }
        }
      }
      directUsage = responses.reduce((usage, item) => ({
        inputTokens: usage.inputTokens + item.usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens + (item.usage.cachedInputTokens ?? 0),
        outputTokens: usage.outputTokens + item.usage.outputTokens,
      }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
      directModel = response.model;
    }
    if (requirementSource)
      validateEditRequirements(editRequirements, requirementSource, await readEditRequirementFiles(this.execution, environmentId));
    if (requirementSource && editRequirements.scope) {
      const candidate = await readEditRequirementFiles(this.execution, environmentId);
      validateProtectedEditValues(editRequirements.scope, requirementSource, candidate);
      validateEditScopeCompletion(editRequirements.scope, requirementSource, candidate);
    }
    let autofixResult = await applyDeterministicAutofix(this.execution, environmentId);
    if (completionRequirements && operation === "GENERATE_SITE") {
      const completion = await validateSiteCoderBundleCompletion(
        this.execution,
        environmentId,
        bundle!,
        completionRequirements,
      );
      if (!completion.valid)
        throw new ApplicationError(
          "GENERATION_INCOMPLETE",
          `Site coder bundle failed completion validation: ${completion.issues.map((issue) => issue.message).join("; ")}`,
        );
      generationCompletion = {
        attempts: generationAttempts,
        accepted: true,
        rejectedAttempts: rejectedGenerationAttempts,
      };
    }
    if (operation === "GENERATE_SITE" && completionRequirements && !generationCompletion)
      throw new ApplicationError("GENERATION_INCOMPLETE", "Structured site coder response did not satisfy completion contract");
    if (dependencyManifest)
      await new GeneratedImportValidator(dependencyManifest, {
        approvedPackages: APPROVED_UI_PACKAGE_VERSIONS,
      }).validate(this.execution, environmentId);
    await validateAssetReferences(this.execution, environmentId, task.assetManifest);
    // Approved UI packages are installed only when the generated source imports
    // them, so a site that uses none is untouched: no manifest write, no install.
    const optional = await materializeOptionalDependencies(this.execution, environmentId);
    if (optional.added.length) {
      console.info(
        `[sites] job=${task.jobId} installing approved UI packages: ${optional.added.join(", ")}`,
      );
      const install = await this.execution.executeCommand(environmentId, {
        executable: "npm",
        args: ["install", "--prefer-offline", "--no-audit", "--no-fund"],
        timeoutMs: 300_000,
      });
      if (install.exitCode !== 0 || install.timedOut)
        throw new ApplicationError(
          "PROJECT_BOOTSTRAP_FAILED",
          `Installing approved UI packages failed: ${optional.added.join(", ")}`,
          { metadata: { packages: optional.added, exitCode: install.exitCode } },
        );
    }
    let automaticBuildAttempts = 0;
    let initialBuildDiagnostics: string | undefined;
    let build = this.execution.getLastBuildResult(environmentId);
    if (this.execution.getLastBuildSuccess(environmentId) !== true) {
      this.progress?.("BUILDING", "Running required final production build");
      automaticBuildAttempts += 1;
      build = await this.execution.executeCommand(environmentId, {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: task.limits?.timeoutMs ?? 60_000,
      });
    }
    if (build && (build.exitCode !== 0 || build.timedOut)) {
      initialBuildDiagnostics = normalizeBuildLog(build.stderr, build.stdout);
      logBuildFailure(task.jobId, initialBuildDiagnostics);
      const deterministicBuildRepair = await applyDeterministicBuildRepair(this.execution, environmentId, { repairRedundantJsxClosings: operation === "GENERATE_SITE" });
      if (deterministicBuildRepair.changed) {
        autofixResult = {
          changed: true,
          fixes: Object.freeze([...autofixResult.fixes, ...deterministicBuildRepair.fixes]),
        };
        automaticBuildAttempts += 1;
        build = await this.execution.executeCommand(environmentId, {
          executable: "npm",
          args: ["run", "build"],
          timeoutMs: task.limits?.timeoutMs ?? 60_000,
        });
      }
    }
    for (
      let repairAttempt = repairModelCalls + 1;
      build && (build.exitCode !== 0 || build.timedOut) && repairAttempt <= maxBuildRepairs;
      repairAttempt += 1
    ) {
      const output = normalizeBuildLog(build.stderr, build.stdout);
      console.warn(
        `[sites] job=${task.jobId} build failed; starting repair=${repairAttempt}/${maxBuildRepairs}`,
      );
      this.progress?.(
        "BUILDING",
        `Repairing production build (${repairAttempt}/${maxBuildRepairs})`,
      );
      const repairContext = await this.#extractRepairContext(environmentId, output);
      const patchBundle = await requestSourceRepair(output, repairContext);
      await applyBuildRepairPatchBundle(this.execution, environmentId, patchBundle, repairContext, diagnostics => {
        if (buildRepairEvidence) buildRepairEvidence = { ...buildRepairEvidence, patches: diagnostics, result: "PATCH_PREFLIGHT" };
      }, { compilerSafety: operation === "GENERATE_SITE" });
      if (buildRepairEvidence) buildRepairEvidence = { ...buildRepairEvidence, result: "APPLIED" };
      automaticBuildAttempts += 1;
      build = await this.execution.executeCommand(environmentId, {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: task.limits?.timeoutMs ?? 60_000,
      });
    }
    if (!build || build.exitCode !== 0 || build.timedOut) {
      const output = build ? safeBuildOutput(build.stderr, build.stdout) : "No build result";
      logBuildFailure(task.jobId, output, "FINAL");
      throw new ApplicationError(
        "REPAIR_LIMIT_REACHED",
        "Generated project production build failed after repair attempts",
        {
          metadata: {
            failureStage: "BUILD",
            exitCode: build?.exitCode ?? null,
            timedOut: build?.timedOut ?? false,
            repairAttempts: repairModelCalls,
            ...(initialBuildDiagnostics ? { initialDiagnostics: initialBuildDiagnostics } : {}),
            diagnostics: output,
          },
        },
      );
    }
    const validateGeneratedSource = async () => {
      const current = [];
      for (const entry of await this.execution.listFiles(environmentId))
        if (entry.type === "FILE" && isEditableSiteEditPath(entry.path) && /^src\/.+\.(tsx?|jsx?)$/.test(entry.path))
          current.push({ path: entry.path, content: await this.execution.readFile(environmentId, entry.path) });
      generatedCandidate = { files: current };
      generationInteractionAdvisories(generatedCandidate);
      validateFunctionalBackendBundle(generatedCandidate, functional);
      if (task.siteSpec) {
        const resolved = resolveUsableGenerationSourceContract(task.siteSpec, generatedCandidate);
        functionalContract = { ...resolved, advisories: [...(resolved.advisories ?? []), ...generationInteractionAdvisories(generatedCandidate)] };
      }
      if (task.templateDesignReference) {
        const advisories = validateTemplateReferenceBundle({ files: current }, task.templateDesignReference, task.userRequest, { acceptance: "USABLE_WEBSITE" });
        if (functionalContract) functionalContract = { ...functionalContract, advisories: [...(functionalContract.advisories ?? []), ...advisories] };
      }
    };
    if (operation === "GENERATE_SITE") await validateGeneratedSource();
    if (!this.execution.getLatestPreview(environmentId)?.url) {
      this.progress?.("BUILDING", "Starting required local preview");
      await this.execution.startPreview(environmentId, { port: 4173 });
    }
    if (operation === "GENERATE_SITE" && validateGenerationBehavior) {
      for (;;) {
        try {
          await validateGenerationBehavior({ previewUrl: this.execution.getLatestPreview(environmentId)!.url!, model: directModel,
            ...(functionalContract ? { functionalContract } : {}), ...(generationCompletion ? { completion: generationCompletion } : {}),
            ...(buildRepairEvidence ? { buildRepair: buildRepairEvidence } : {}) });
          break;
        } catch (cause) {
          // Only source-grounded functional failures can spend the SAME repair
          // allowance. Browser infrastructure/timeouts never trigger model repair.
          const checks = cause instanceof ApplicationError ? cause.metadata?.blockingFindings : undefined;
          if (!(cause instanceof ApplicationError) || cause.metadata?.failureStage !== "BROWSER_QA" || repairModelCalls >= maxBuildRepairs ||
            !Array.isArray(checks) || !checks.length || checks.some((check: unknown) => !check || typeof check !== "object" ||
              typeof (check as Record<string, unknown>).checkId !== "string" || !String((check as Record<string, unknown>).checkId).startsWith("functional.") ||
              ((check as Record<string, unknown>).failureKind !== undefined && (check as Record<string, unknown>).failureKind !== "FUNCTIONAL_FAILURE") ||
              /timed? ?out|timeout|browser.*(?:closed|launch)/i.test(String((check as Record<string, unknown>).message)))) throw cause;
          const diagnostics = [cause.message, ...(functionalContract?.requirements ?? []).flatMap(requirement => [
            requirement.id + " [" + requirement.routes?.join(", ") + "]: " + requirement.expectedBehavior,
            ...(requirement.sourceEvidence ?? []).map(ref => ref.path + ":" + ref.line),
          ])].join("\n");
          this.progress?.("BUILDING", "Repairing proven functional failure within the existing repair allowance");
          const snapshot = await this.#extractRepairContext(environmentId, diagnostics);
          const patches = await requestSourceRepair(diagnostics, snapshot, "functional");
          await applyBuildRepairPatchBundle(this.execution, environmentId, patches, snapshot, diagnostics => {
            if (buildRepairEvidence) buildRepairEvidence = { ...buildRepairEvidence, patches: diagnostics, result: "PATCH_PREFLIGHT" };
          });
          if (buildRepairEvidence) buildRepairEvidence = { ...buildRepairEvidence, result: "APPLIED" };
          await validateGeneratedSource();
          automaticBuildAttempts += 1;
          build = await this.execution.executeCommand(environmentId, { executable: "npm", args: ["run", "build"], timeoutMs: task.limits?.timeoutMs ?? 60_000 });
          if (build.exitCode !== 0 || build.timedOut) throw new ApplicationError("REPAIR_LIMIT_REACHED", "Functional repair failed production build; repair allowance exhausted", {
            metadata: { failureStage: "BUILD", repairAttempts: repairModelCalls, diagnostics: safeBuildOutput(build.stderr, build.stdout) },
          });
          // A repaired candidate must pass the complete Browser QA run again.
        }
      }
    }
    const files: string[] = [];
    for (const entry of (await this.execution.listFiles(environmentId)).filter(
      (item) => item.type === "FILE",
    )) {
      if (!before.has(entry.path)) files.push(entry.path);
      else if (
        (entry.sizeBytes ?? 0) <= (task.limits?.maxFileBytes ?? 64_000) &&
        before.get(entry.path) !== (await this.execution.readFile(environmentId, entry.path))
      )
        files.push(entry.path);
    }
    if (requirementSource)
      validateEditRequirements(editRequirements, requirementSource, await readEditRequirementFiles(this.execution, environmentId));
    if (requirementSource && editRequirements.scope) {
      const candidate = await readEditRequirementFiles(this.execution, environmentId);
      validateProtectedEditValues(editRequirements.scope, requirementSource, candidate);
      validateEditScopeCompletion(editRequirements.scope, requirementSource, candidate);
    }
    const metrics = this.execution.getUsageMetrics(environmentId);
    const preview = this.execution.getLatestPreview(environmentId);
    const commandDelta = metrics.commandsExecuted - startingMetrics.commandsExecuted;
    if (preview?.url) this.progress?.("PREVIEW_READY", "Real local preview is ready");
    this.progress?.("COMPLETED", "LOCAL_CLI task completed");
    return {
      success: this.execution.getLastBuildSuccess(environmentId) === true && Boolean(preview?.url),
      provider: providerId,
      model: directModel,
      runtime: "LOCAL_CLI",
      turns: (boundedStructuredOperation ? generationAttempts : 0) + repairModelCalls,
      toolCalls: 0,
      buildAttempts: tools.buildAttempts + automaticBuildAttempts,
      finalBuildSuccess: this.execution.getLastBuildSuccess(environmentId) === true,
      ...(preview?.url ? { previewUrl: preview.url } : {}),
      filesChanged: files,
      durationMs: Date.now() - started,
      usage: {
        inputTokens: directUsage.inputTokens + repairInputTokens,
        cachedInputTokens: directUsage.cachedInputTokens + repairCachedInputTokens,
        outputTokens: directUsage.outputTokens + repairOutputTokens,
        modelCalls: (boundedStructuredOperation ? generationAttempts : 0) + repairModelCalls,
        limitReached: false,
        toolCalls: 0,
        executionProvider: this.execution.id,
        environmentCreationMs: metrics.environmentCreationMs,
        filesWritten: metrics.filesWritten - startingMetrics.filesWritten,
        bytesWritten: metrics.bytesWritten - startingMetrics.bytesWritten,
        commandsExecuted: commandDelta,
        commandDurationMs: metrics.commandDurationMs - startingMetrics.commandDurationMs,
        installDurationMs: metrics.installDurationMs - startingMetrics.installDurationMs,
        buildDurationMs: metrics.buildDurationMs - startingMetrics.buildDurationMs,
        previewStartupMs: metrics.previewStartupMs - startingMetrics.previewStartupMs,
        previewHttpReadyMs: metrics.previewHttpReadyMs - startingMetrics.previewHttpReadyMs,
        filesWrittenByAgent: tools.filesWritten,
        bytesWrittenByAgent: tools.bytesWritten,
        requestsUsed: effectiveContext.budget.usage.logicalRequests,
        requestBudget: effectiveContext.budget.limits.maxLogicalRequests,
        physicalRequestsUsed: effectiveContext.budget.usage.physicalRequests,
        physicalRequestBudget: effectiveContext.budget.limits.maxPhysicalRequests,
        tokensUsed: effectiveContext.budget.usage.totalTokens,
        tokenBudget: effectiveContext.budget.limits.maxTotalTokens,
        requestSize: requestSizeTelemetry,
        ...(requirementRepairRequestSize
          ? { requirementRepair: { attempts: 2, requestSize: requirementRepairRequestSize } }
          : {}),
      },
      ...(generationCompletion ? { generationCompletion } : {}),
      generationMode: operation === "EDIT_SITE" ? "TARGETED_EDIT" : "FAST_GENERATION",
      deterministicAutofixes: [...autofixResult.fixes.map((fix) => fix.id), ...new Set(functionalAutofixes)],
      buildRepairInvoked: repairModelCalls > 0,
      ...(functionalContract ? { functionalContract } : {}),
      ...(operation === "GENERATE_SITE" && bundle?.siteName
        ? { generatedSiteName: bundle.siteName }
        : {}),
      ...(operation === "GENERATE_SITE" && bundle
        ? generatedDocumentTitle(bundle)
          ? { generatedDocumentTitle: generatedDocumentTitle(bundle) }
          : {}
        : {}),
    };
    } catch (cause) {
      if (operation === "EDIT_SITE" && cause instanceof ApplicationError && cause.metadata?.failureStage === "PATCH_APPLICATION") {
        let candidateDiagnosticPath: string | undefined;
        try {
          const path = await this.generationDiagnostics?.evidence?.preserve({ execution: this.execution, environmentId,
            jobId: task.jobId, siteId: task.siteId, patchDiagnostics: cause.metadata.patchDiagnostics ?? [],
            ...(task.outerRequestId ? { outerRequestId: task.outerRequestId } : {}),
            editAttempt: generationAttempts, repairRequirements: editRepairRequirements,
            validationFailure: { failureStage: "PATCH_APPLICATION", code: cause.code, check: cause.metadata.validationCheck === "edit.scope" ? "edit.scope" : "edit.patch-resolution", message: cause.message, buildPassed: false },
          });
          if (path) candidateDiagnosticPath = path;
        } catch { console.warn("[sites] Private patch diagnostics unavailable; original rejection preserved"); }
        recordGenerationTelemetry(this.generationDiagnostics?.telemetry, { jobId: task.jobId, role: "sites.targeted-edit",
          model: capabilities.models[0], failureStage: "PATCH_APPLICATION", candidateDiagnosticPath });
      }
      // The pipeline already captured the complete QA report and candidate.
      // Do not relabel that same failure as an early static-validation error.
      if (operation === "GENERATE_SITE" && cause instanceof ApplicationError && cause.metadata?.failureStage !== "BROWSER_QA" &&
        (["GENERATION_INCOMPLETE", "VALIDATION_FAILED", "SOURCE_SECURITY_VALIDATION_FAILED", "REPAIR_LIMIT_REACHED"].includes(cause.code) || buildRepairEvidence)) {
        const invalidRepairResponse = buildRepairEvidence?.result === "INVALID_RESPONSE";
        const failureStage = cause.metadata?.failureStage === "BUILD" ? "BUILD" : cause.metadata?.failureStage === "PATCH_APPLICATION" || invalidRepairResponse ? "PATCH_APPLICATION" : "STATIC_VALIDATION";
        let candidateDiagnosticPath: string | undefined;
        if (generatedCandidate && this.generationDiagnostics?.evidence) {
          try {
            const repairCandidate = buildRepairSnapshot ? { files: await Promise.all(buildRepairSnapshot.files.map(async ({ path, content }) => ({ path,
              content: buildRepairEvidence?.result === "APPLIED" && buildRepairEvidence.kind === "build" ? await this.execution.readFile(environmentId, path) : content,
            }))) } : undefined;
            const path = await this.generationDiagnostics.evidence.preserve({ execution: this.execution, environmentId,
              jobId: task.jobId, siteId: task.siteId,
              candidate: repairCandidate ?? generatedCandidate,
              ...(task.outerRequestId ? { outerRequestId: task.outerRequestId } : {}),
              // A QA candidate may already have been retained under attempt 1.
              // Keep failed repair evidence separately; never overwrite it.
              generationAttempt: buildRepairSnapshot ? 2 : 1,
              ...(buildRepairEvidence ? { buildRepair: { ...buildRepairEvidence,
                ...(typeof cause.metadata?.currentSourceRevision === "string" ? { currentSourceRevision: cause.metadata.currentSourceRevision } : {}),
                result: typeof cause.metadata?.reason === "string" ? cause.metadata.reason : buildRepairEvidence.result } } : {}),
              functionalRequirements: functional, referenceContext: contextTelemetry,
              functionalContract: functionalContract ?? cause.metadata?.routeMapping,
              accounting: { model: capabilities.models[0] ?? "unknown", role: "sites.site-coder", logicalRequests: effectiveContext.getSummary().logicalRequests,
                physicalRequests: effectiveContext.getSummary().physicalRequests, billingStatus: "NOT_FINALIZED" },
              ...(generationCompletion ? { completion: generationCompletion } : {}),
              validationFailure: { failureStage, code: cause.code,
                check: typeof cause.metadata?.validationCheck === "string" ? cause.metadata.validationCheck : invalidRepairResponse ? "build-repair.response" : failureStage === "BUILD" ? "build.diagnostics" : "generation.static",
                message: cause.message + (failureStage === "BUILD" && typeof cause.metadata?.diagnostics === "string" ? `\n${cause.metadata.diagnostics}` : ""), buildPassed: this.execution.getLastBuildSuccess(environmentId) === true },
            });
            if (path) candidateDiagnosticPath = path;
          } catch { console.warn("[sites] Early candidate diagnostics unavailable; original validation failure preserved"); }
        } else if (this.generationDiagnostics?.evidence) {
          console.warn("[sites] No parsed candidate source available for early failure diagnostics");
        }
        recordGenerationTelemetry(this.generationDiagnostics?.telemetry, { jobId: task.jobId, role: "sites.site-coder",
          model: capabilities.models[0], ...contextTelemetry, failureStage, candidateDiagnosticPath });
      }
      throw cause;
    }
  }
  async #discoverContext(
    environmentId: string,
    task: CliTask,
    operation?: "GENERATE_SITE" | "EDIT_SITE",
    profile: GeneratedAppProfile = getDefaultProfile(),
    resolvedCapabilities?: ResolvedCapabilities,
    dependencyManifest?: ResolvedDependencyManifest,
    assetManifest?: AssetManifest,
  ): Promise<{ readonly text: string; readonly stableChars: number; readonly editRequirementContext?: EditRequirementContext; readonly editSourcePaths?: readonly string[] }> {
    if (operation === "GENERATE_SITE") {
      const contractLines = [
        buildCapabilityAwareGenerationContext({
          profile,
          capabilities: resolvedCapabilities,
          dependencyManifest,
          uiRegistryItems: SITES_UI_REGISTRY.listItems(),
          assetManifest,
          requestText: task.userRequest,
        }),
        "",
        "Runtime Contract:",
        `Runtime: ${formatTechnology(profile.framework)} + ${formatTechnology(profile.language)} + ${formatTechnology(profile.bundler)}`,
        `Bundler: ${formatTechnology(profile.bundler)} (${formatLogicalCommand(profile.commands.build)})`,
        "",
        "Existing editable scaffold files (additional safe src application files are allowed):",
        ...profile.files.editable.map((path) => `- ${path}`),
        "",
        "Managed by Sites (deterministic scaffold, do not edit or recreate):",
        ...profile.files.managed.map((path) => `- ${path}`),
        "",
        "Rules:",
        GENERATION_NAVIGATION_RULES,
        "- Do not add external packages unless explicitly permitted.",
        "- Sites already supplies a theme switch in managed src/main.tsx. Do not duplicate it or style reserved [data-sites-managed] controls. Scope your CSS to your application components; custom themes must produce real visible color changes.",
        "- Return a complete src/App.tsx. Override src/styles.css only when custom baseline styling is needed; otherwise keep the scaffold stylesheet.",
        "",
        "Art direction:",
        ...(task.templateDesignReference ? [templateDesignPrompt(task.templateDesignReference.design)] : task.referenceImages?.length ? [
          "A design reference image is attached. Match the ENTIRE page composition visible in it: page type, navbar, hero arrangement, typography, palette, spacing, and sections. If the image is a landing page with an app dashboard inside its hero, build the landing page AND that dashboard UI.",
          "Rebuild any dashboard or interface shown inside the reference with readable HTML, CSS, and React elements. Do not display or animate the screenshot itself.",
          "Implement the reference's visible navigation as working routes or React views, including the destinations beyond the screenshot. Wire its buttons, menus, tabs, search, and forms to meaningful local behavior. A visual clone with dead controls or alert-only handlers is incomplete. Use browser-local state/storage when no backend was approved; label integrations or server-only actions honestly.",
          "Match the reference's dominant light or dark appearance on initial render. Do not substitute a generic art direction or change the reference's light page into a dark page.",
          "Preserve the existing theme control, but ensure the initial composition and colors follow the reference.",
        ] : [
        "- Build one clear focal point per section and let the hero carry real scale: a short headline at .display size beats a long one at default size.",
        "- Prefer asymmetric composition (a wide column beside a narrower one) over centering everything, and vary section rhythm instead of repeating identical blocks.",
        "- Earn attention with type scale, whitespace and one accent colour; avoid gradient-on-gradient, neon, emoji as iconography, and three identical cards as the answer to every section.",
        "- Use concrete, specific copy with real nouns and numbers; placeholder voice ('Lorem', 'Your Company Here', 'Feature One') reads as unfinished.",
        "- Compose decorative shapes from CSS (a soft wash, a rule, an offset frame) rather than inline SVG illustration sets.",
        "- Every site ships a light and a dark theme driven by the tokens, so colour must come from var(--ink), var(--surface), var(--accent) and friends. A hardcoded hex or a named colour breaks one of the two themes.",
        "- For a colour splash, wrap the section in .splash-stage and place one or two .splash elements (with .splash--top-right, .splash--bottom-left, .splash--behind, .splash--soft or .splash--ring); they sit behind content and already fade correctly in dark mode.",
        ]),
      ];

      // The capability contract is near-identical across sites, so it leads and
      // can sit behind a cache breakpoint.
      const stableContract = contractLines.join("\n");
      const chunks: string[] = [];
      for (const filePath of profile.files.editable) {
        try {
          const content = await this.execution.readFile(environmentId, filePath);
          // The baseline stylesheet is design surface, not code to reproduce.
          // Its token/utility contract is a fraction of the bytes.
          chunks.push(
            filePath === "src/styles.css"
              ? summarizeDesignSystem(content, Boolean(task.referenceImages?.length || task.templateDesignReference))
              : `--- ${filePath}\n${content}`,
          );
        } catch {
          // file may not exist yet
        }
      }
      return {
        text: [stableContract, ...chunks].join("\n\n"),
        stableChars: stableContract.length + 2,
      };
    }

    const maxFiles = task.limits?.maxContextFiles ?? 8;
    const maxBytes = task.limits?.maxContextBytes ?? 64_000;
    const maxFile = task.limits?.maxFileBytes ?? 16_000;
    const rename = parseEditRequirements(task.userRequest).rename;
    // A targeted edit may only patch editable application source, so managed
    // scaffold files are cost without capability. Of what remains, only the files
    // the instruction actually implicates are worth sending; the rest are named in
    // a manifest so the model still knows the shape of the project.
    const contextEntries = (await this.execution.listFiles(environmentId))
      .filter((item) => item.type === "FILE")
      .filter((item) => {
        const path = item.path.replaceAll("\\", "/");
        return isEditableContextPath(path, profile) ||
          (rename && /^public\/.+\.svg$/i.test(path) && isEditableSiteEditPath(path));
      });
    const editableEntries = contextEntries.filter((item) => (item.sizeBytes ?? 0) <= maxFile);
    // A stylesheet too large to send whole still owns the tokens a colour or
    // theme edit must change; on style intent only its :root blocks are sent.
    const oversizedStylesheets = contextEntries.filter(
      (item) => (item.sizeBytes ?? 0) > maxFile && item.path.endsWith(".css"),
    );
    const editableFiles: EditContextFile[] = [];
    for (const entry of editableEntries)
      editableFiles.push({
        path: entry.path.replaceAll("\\", "/"),
        content: await this.execution.readFile(environmentId, entry.path),
      });
    // A rename must expose every exact match, even in a file above the usual per-file budget.
    if (rename) for (const entry of contextEntries.filter((item) => (item.sizeBytes ?? 0) > maxFile)) {
      const content = await this.execution.readFile(environmentId, entry.path);
      if (containsRenameLiteral(content, rename.oldLiteral))
        editableFiles.push({ path: entry.path.replaceAll("\\", "/"), content });
    }

    // Sorted so the prefix is byte-stable between edits, and so a file changed by
    // one edit only invalidates the cache from its own position onward.
    const broadFunctionalEdit = isBroadFunctionalEdit(task.userRequest);
    // Full-file edits cannot write managed root HTML. Do not advertise it as
    // editable under that contract; precise branding patches still receive it.
    const sorted = editableFiles.filter(file => !broadFunctionalEdit || file.path !== "index.html")
      .sort((left, right) => left.path.localeCompare(right.path));
    const baseline = sorted.find((file) => file.path === BASELINE_STYLESHEET);
    const core = sorted.filter((file) => file.path !== BASELINE_STYLESHEET);
    const coreBytes = core.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    const selection = selectEditContextFiles(task.userRequest, sorted, { maxFiles, includeAllEditable: broadFunctionalEdit });

    // Small projects: send all application source inside the cached prefix. It
    // costs a little more on the first edit and is reusable on every later one.
    // Large projects: fall back to instruction-relevant selection, which keeps
    // the prompt small at the cost of a prefix too short to cache.
    const cacheable = coreBytes <= INLINE_ALL_SOURCE_LIMIT;
    const stableFiles = cacheable ? core : [];
    const variableFiles = cacheable
      ? selection.styleIntent && baseline
        ? [baseline]
        : rename && baseline && containsRenameLiteral(baseline.content, rename.oldLiteral) ? [baseline] : []
      : selection.selected;

    const chunk = (file: EditContextFile) => `--- ${file.path}\n${file.content}`;
    let bytes = 0;
    const withinBudget = (files: readonly EditContextFile[]) =>
      files.filter((file) => {
        const size = Buffer.byteLength(file.content);
        if (bytes + size > maxBytes && !(rename && containsRenameLiteral(file.content, rename.oldLiteral))) return false;
        bytes += size;
        return true;
      });
    const stableSent = withinBudget(stableFiles);
    const variableSent = withinBudget(variableFiles);
    const tokenExcerpts: EditContextFile[] = [];
    if (selection.styleIntent)
      for (const entry of oversizedStylesheets) {
        if ([...stableSent, ...variableSent].some((file) => file.path === entry.path.replaceAll("\\", "/"))) continue;
        const excerpt = designTokenExcerpt(await this.execution.readFile(environmentId, entry.path));
        if (excerpt) tokenExcerpts.push({ path: entry.path.replaceAll("\\", "/"), content: excerpt });
      }
    const excerptSent = withinBudget(tokenExcerpts);

    const stable = [
      `Sites-managed and off-limits (not shown): ${profile.files.managed.filter((path) => broadFunctionalEdit || path !== "index.html").join(", ")}`,
      `Editable project files: ${sorted.map((file) => file.path).join(", ")}`,
      // Without the stylesheet itself, the model still needs to know the tokens exist.
      ...(baseline ? [summarizeDesignSystem(baseline.content)] : []),
      broadFunctionalEdit
        ? "Full source follows. Return complete contents only for editable files shown below that need functional changes; preserve their visual design."
        : "Patch only supplied source, including exact patchable excerpts; do not invent files.",
      ...stableSent.map(chunk),
    ].join("\n\n");
    const variable = [...variableSent.map(chunk), ...excerptSent.map(patchableStyleExcerpt)].join("\n\n");

    // The separator is always part of the prefix, present or not: a boundary that
    // moves by two characters when the tail is empty makes the prefix differ
    // between edits and defeats the cache entirely.
    const context = `${stable}\n\n${variable}`;
    const included = [...stableSent, ...variableSent].map((file) => file.path);
    this.#logEditContext(
      task,
      context,
      [...included, ...excerptSent.map((file) => `${file.path} (design tokens)`)],
      sorted.length - included.length,
      cacheable,
    );
    return {
      text: context,
      stableChars: stable.length + 2,
      editSourcePaths: [...included, ...excerptSent.map(file => file.path)],
      editRequirementContext: suppliedEditRequirementContext(
        parseEditRequirements(task.userRequest),
        [...stableSent, ...variableSent, ...excerptSent],
      ),
    };
  }
  /**
   * Development visibility into what a targeted edit actually costs. Composition
   * only: provider-reported usage stays the authority on billing. Paths and sizes
   * are safe to print; file contents and credentials are not.
   */
  #logEditContext(
    task: CliTask,
    context: string,
    included: readonly string[],
    excludedCount: number,
    cacheable: boolean,
  ): void {
    const tokens = (text: string) => Math.ceil(text.length / 4);
    const manifestEnd = context.indexOf("\n\n--- ");
    const manifest = manifestEnd > 0 ? context.slice(0, manifestEnd) : context;
    console.info(
      [
        "",
        "SITES EDIT CONTEXT",
        "",
        `Mode: ${cacheable ? "all source in cached prefix" : "instruction-relevant selection"}`,
        `User Instruction: ${tokens(task.userRequest)} tokens`,
        `Manifest: ${tokens(manifest)} tokens`,
        `Source Files: ${tokens(context) - tokens(manifest)} tokens`,
        "",
        "Files Included:",
        ...included.map((path) => `- ${path}`),
        "",
        `Files Excluded: ${excludedCount}`,
        "",
      ].join("\n"),
    );
  }
  async #extractRepairContext(environmentId: string, buildOutput: string, candidate?: SiteCoderFileBundle): Promise<BuildRepairSourceSnapshot> {
    const textSource = (path: string) => /^src\/.+\.(?:tsx?|jsx?|css|svg|json)$/i.test(path) && isEditableSiteEditPath(path);
    const files = candidate ? candidate.files.filter(file => textSource(file.path)) : await Promise.all(
      (await this.execution.listFiles(environmentId)).filter(file => file.type === "FILE" && textSource(file.path))
        .map(async file => ({ path: file.path, content: await this.execution.readFile(environmentId, file.path) })),
    );
    return createBuildRepairSourceSnapshot(files, buildOutput);
  }
}

/** Editable application source: under src/ and not claimed by the profile's managed set. */
export function isEditableContextPath(path: string, profile: GeneratedAppProfile): boolean {
  if (path === "index.html") return true;
  if (!path.startsWith("src/") || !isEditableSiteEditPath(path)) return false;
  return !profile.files.managed.some((pattern) =>
    pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
  );
}

function formatLogicalCommand(command: { executable: string; args: readonly string[] }): string {
  return [command.executable, ...command.args].join(" ");
}

function formatTechnology(value: string): string {
  const labels: Record<string, string> = {
    react: "React",
    typescript: "TypeScript",
    vite: "Vite",
  };
  return labels[value] ?? value;
}

function resolveRuntimeProfile(profileId?: string): GeneratedAppProfile {
  if (!profileId) return getDefaultProfile();
  try {
    return getProfile(profileId);
  } catch (error) {
    // Keep direct runtime fixtures and older callers compatible while the
    // persisted SiteSpec/profile migration is completed. Product templates
    // resolve profiles strictly through StarterTemplateRegistry.
    if (error instanceof ApplicationError && error.code === "UNSUPPORTED_SITE_REQUIREMENT")
      return getDefaultProfile();
    throw error;
  }
}

function safeBuildOutput(stderr: string, stdout: string): string {
  return normalizeBuildLog(stderr, stdout, { maxBytes: 8_000 });
}

function logBuildFailure(
  jobId: string,
  diagnostics: string,
  phase: "INITIAL" | "FINAL" = "INITIAL",
): void {
  console.error(
    [
      "----------------------------------------",
      `SITES BUILD FAILED${phase === "FINAL" ? " AFTER REPAIR" : ""}`,
      `Job: ${jobId}`,
      "",
      diagnostics.slice(-8_000),
      "----------------------------------------",
    ].join("\n"),
  );
}
