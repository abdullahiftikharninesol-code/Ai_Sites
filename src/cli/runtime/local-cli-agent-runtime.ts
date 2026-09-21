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
import { scaffoldDeterministicReactVite } from "../../sites/scaffold/react-vite-scaffold.js";
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
import { validateAssetReferences } from "../../sites/assets/asset-reference-validator.js";
import { applyDeterministicAutofix, applyDeterministicBuildRepair } from "../../sites/generation/deterministic-autofix.js";
import {
  SITE_CODER_FILE_BUNDLE_JSON_SCHEMA,
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
} from "./site-coder-file-bundle.js";
import {
  assertStructuredResponseComplete,
  parseStructuredResponse,
} from "../../agents/shared/structured-response-parser.js";
import { SITES_UI_REGISTRY } from "../../sites/generation/sites-ui-registry.js";
import { buildCapabilityAwareGenerationContext } from "./capability-aware-generation-context.js";
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
}
export type CliAgentProgressListener = (
  state: "GENERATING" | "BUILDING" | "PREVIEW_READY" | "COMPLETED",
  message: string,
) => void;
export class LocalCliAgentRuntime {
  constructor(
    private readonly gateway: AgentGateway,
    private readonly providers: AgentProviderRegistry,
    private readonly execution: LocalExecutionProvider,
    private readonly progress?: CliAgentProgressListener,
  ) {}
  async run(
    environmentId: string,
    task: CliTask,
    externalSignal?: AbortSignal,
    runContext?: InferenceRunContext,
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
    if (operation === "GENERATE_SITE") {
      await scaffoldDeterministicReactVite(
        this.execution,
        environmentId,
        task.siteSpec?.project.name ? { projectName: task.siteSpec.project.name } : {},
      );
      if (dependencyManifest?.capabilities.some(({ id }) => id === "ui"))
        await SITES_UI_REGISTRY.materialize(this.execution, environmentId, technicalProfile);
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
      overrideMaxOutput: task.limits?.maxOutputTokens,
      overrideReasoning: task.reasoningPolicy,
    });

    const projectedSiteSpec = task.siteSpec
      ? toGenerationSiteSpec(task.siteSpec, completionRequirements)
      : undefined;

    const context = await this.#discoverContext(
      environmentId,
      task,
      operation,
      technicalProfile,
      resolvedCapabilities,
      dependencyManifest,
      task.assetManifest,
    );

    const promptForEstimation = [
      runtimePrompt.prompt.systemPrompt,
      JSON.stringify(stagePolicy.tools),
      `Operation: ${operation === "EDIT_SITE" ? "EDIT" : "GENERATE"}`,
      `User request: ${task.userRequest}`,
      projectedSiteSpec ? `SiteSpec: ${JSON.stringify(projectedSiteSpec)}` : "",
      context,
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
    let directUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let directModel = capabilities.models[0] ?? "unknown";
    this.progress?.("GENERATING", operation === "EDIT_SITE" ? "Applying bounded edit patch" : "Generating bounded source file bundle");
    if (boundedStructuredOperation) {
      const responseContract = operation === "EDIT_SITE" ? {
        type: "JSON_SCHEMA" as const,
        name: "SiteEditPatchBundle",
        schema: SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA,
        strict: true,
      } : {
        type: "JSON_SCHEMA" as const,
        name: "SiteCoderFileBundle",
        schema: SITE_CODER_FILE_BUNDLE_JSON_SCHEMA,
        strict: true,
      };
      const response = await gatewayProvider.createResponse({
        model: capabilities.models[0] ?? "unknown",
        systemInstructions: runtimePrompt.prompt.systemPrompt,
        messages: [{
          role: "user",
          content: [
            operation === "EDIT_SITE"
              ? "Return exactly one JSON object matching the SiteEditPatchBundle schema. Make the smallest requested source edit and do not call tools."
              : "Return exactly one JSON object matching the SiteCoderFileBundle schema. Do not call tools.",
            operation === "EDIT_SITE"
              ? "Only patch the requested editable source file; never modify package manifests, configuration, lockfiles, or Sites-managed files."
              : "Write only editable application source files. Never modify package manifests, configuration, lockfiles, or Sites-managed files.",
            operation === "GENERATE_SITE"
              ? [
                  "The existing React + TypeScript + Vite scaffold supplies src/main.tsx, baseline src/styles.css, and project configuration.",
                  "The bundle must contain a complete, non-empty src/App.tsx application entry component.",
                  "You may add components, views, pages, and custom CSS files. Every local import you add must resolve to a file in this bundle or the documented scaffold.",
                  "Return compilable TypeScript/TSX, use React state for requested demo interactions, and do not regenerate unchanged scaffold boilerplate.",
                ].join(" ")
              : "",
            operation === "GENERATE_SITE" && completionRequirements ? `Required pages/views: ${completionRequirements.requiredPages.join(", ")}\nRequired sections/features: ${completionRequirements.requiredSections.join(", ")}. Implement these semantically using appropriate React routes, state, tabs, views, or components. Legacy data-sites-page and data-sites-section attributes are optional and are not required.` : "",
            projectedSiteSpec ? `SiteSpec: ${JSON.stringify(projectedSiteSpec)}` : "",
            `Workspace context:\n${context}`,
            `User request: ${task.userRequest}`,
          ].filter(Boolean).join("\n\n"),
        }],
        maxOutputTokens: requestedOutputAllowance,
        reasoningPolicy: stagePolicy.reasoningPolicy,
        responseContract,
        ...(signal ? { signal } : {}),
      });
      assertStructuredResponseComplete(
        response,
        operation === "EDIT_SITE" ? "Targeted edit" : "Site coder",
      );
      const parsed = parseStructuredResponse<SiteCoderFileBundle | import("./site-coder-file-bundle.js").SiteEditPatchBundle>({
        content: response.message.content,
        contract: responseContract,
        capability: capabilities.structuredOutputCapability ?? "FALLBACK_TEXT",
        validate: (value) => operation === "EDIT_SITE"
          ? validateSiteEditPatchBundle(value)
          : validateSiteCoderFileBundle(value, completionRequirements),
        errorContext: operation === "EDIT_SITE" ? "Targeted edit" : "Site coder",
      }).value;
      if (operation === "EDIT_SITE") {
        await applySiteEditPatchBundle(this.execution, environmentId, parsed as import("./site-coder-file-bundle.js").SiteEditPatchBundle);
      } else {
        const generatedBundle = parsed as SiteCoderFileBundle;
        bundle = generatedBundle;
        await materializeSiteCoderFileBundle(this.execution, environmentId, generatedBundle);
      }
      directUsage = {
        inputTokens: response.usage.inputTokens,
        cachedInputTokens: response.usage.cachedInputTokens ?? 0,
        outputTokens: response.usage.outputTokens,
      };
      directModel = response.model;
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
      generationCompletion = { attempts: 1, accepted: true, rejectedAttempts: 0 };
    }
    if (operation === "GENERATE_SITE" && completionRequirements && !generationCompletion)
      throw new ApplicationError("GENERATION_INCOMPLETE", "Structured site coder response did not satisfy completion contract");
    if (dependencyManifest)
      await new GeneratedImportValidator(dependencyManifest).validate(
        this.execution,
        environmentId,
      );
    await validateAssetReferences(this.execution, environmentId, task.assetManifest);
    let automaticBuildAttempts = 0;
    let repairModelCalls = 0;
    let repairInputTokens = 0;
    let repairCachedInputTokens = 0;
    let repairOutputTokens = 0;
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
      const deterministicBuildRepair = await applyDeterministicBuildRepair(this.execution, environmentId);
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
    const maxBuildRepairs = task.limits?.maxBuildRepairs ?? 1;
    for (
      let repairAttempt = 1;
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
      const repairPrompt = resolveAgentPrompt("sites.build-repair", {
        expectedStage: "BUILD_REPAIR",
      });
      const repairProvider = effectiveContext.createScopedProvider(
        rawGatewayProvider,
        "BUILD_REPAIR",
      );
      const repairPolicy = getInferenceContextPolicy("BUILD_REPAIR", {
        overrideMaxOutput: task.limits?.maxOutputTokens,
      });
      {
        const responseContract = {
          type: "JSON_SCHEMA" as const,
          name: "BuildRepairPatchBundle",
          schema: BUILD_REPAIR_PATCH_BUNDLE_JSON_SCHEMA,
          strict: true,
        };
        const response = await repairProvider.createResponse({
          model: capabilities.models[0] ?? "unknown",
          systemInstructions: repairPrompt.prompt.systemPrompt,
          messages: [{ role: "user", content: [
            "Return exactly one JSON BuildRepairPatchBundle. Do not call tools.",
            "Only repair the reported build failure. Do not modify managed files, package manifests, or dependencies.",
            `Build output:\n${output}`,
            dependencyManifest
              ? `Current dependency manifest:\n${JSON.stringify({
                  dependencies: dependencyManifest.dependencies,
                  devDependencies: dependencyManifest.devDependencies,
                })}`
              : "",
            repairContext ? `Relevant source files:\n${repairContext}` : "",
          ].filter(Boolean).join("\n\n") }],
          maxOutputTokens: repairPolicy.outputPolicy.defaultMaxOutputTokens,
          reasoningPolicy: repairPolicy.reasoningPolicy,
          responseContract,
          ...(signal ? { signal } : {}),
        });
        assertStructuredResponseComplete(response, "Build repair");
        const patchBundle = parseStructuredResponse({
          content: response.message.content,
          contract: responseContract,
          capability: capabilities.structuredOutputCapability ?? "FALLBACK_TEXT",
          validate: validateBuildRepairPatchBundle,
          errorContext: "Build repair",
        }).value;
        await applyBuildRepairPatchBundle(this.execution, environmentId, patchBundle);
        repairModelCalls = 1;
        repairInputTokens = response.usage.inputTokens;
        repairCachedInputTokens = response.usage.cachedInputTokens ?? 0;
        repairOutputTokens = response.usage.outputTokens;
      }
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
    if (!this.execution.getLatestPreview(environmentId)?.url) {
      this.progress?.("BUILDING", "Starting required local preview");
      await this.execution.startPreview(environmentId, { port: 4173 });
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
      turns: (boundedStructuredOperation ? 1 : 0) + repairModelCalls,
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
        modelCalls: (boundedStructuredOperation ? 1 : 0) + repairModelCalls,
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
      },
      ...(generationCompletion ? { generationCompletion } : {}),
      generationMode: operation === "EDIT_SITE" ? "TARGETED_EDIT" : "FAST_GENERATION",
      deterministicAutofixes: autofixResult.fixes.map((fix) => fix.id),
      buildRepairInvoked: repairModelCalls > 0,
    };
  }
  async #discoverContext(
    environmentId: string,
    task: CliTask,
    operation?: "GENERATE_SITE" | "EDIT_SITE",
    profile: GeneratedAppProfile = getDefaultProfile(),
    resolvedCapabilities?: ResolvedCapabilities,
    dependencyManifest?: ResolvedDependencyManifest,
    assetManifest?: import("../../sites/assets/asset-domain.js").AssetManifest,
  ): Promise<string> {
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
        "- Do not add external packages unless explicitly permitted.",
        "- Return a complete src/App.tsx. Override src/styles.css only when custom baseline styling is needed; otherwise keep the scaffold stylesheet.",
      ];

      const chunks: string[] = [contractLines.join("\n")];
      for (const filePath of profile.files.editable) {
        try {
          const content = await this.execution.readFile(environmentId, filePath);
          chunks.push(`--- ${filePath}\n${content}`);
        } catch {
          // file may not exist yet
        }
      }
      return chunks.join("\n\n");
    }

    const maxFiles = task.limits?.maxContextFiles ?? 20;
    const maxBytes = task.limits?.maxContextBytes ?? 64_000;
    const maxFile = task.limits?.maxFileBytes ?? 16_000;
    let bytes = 0;
    const chunks: string[] = [];
    for (const entry of (await this.execution.listFiles(environmentId))
      .filter((item) => item.type === "FILE")
      .slice(0, maxFiles)) {
      if ((entry.sizeBytes ?? 0) > maxFile) continue;
      const content = await this.execution.readFile(environmentId, entry.path);
      const size = Buffer.byteLength(content);
      if (bytes + size > maxBytes) break;
      bytes += size;
      chunks.push(`--- ${entry.path}\n${content}`);
    }
    return chunks.join("\n");
  }
  async #extractRepairContext(environmentId: string, buildOutput: string): Promise<string> {
    const normalizedOutput = buildOutput.replaceAll("\\", "/");
    const fileMatches = normalizedOutput.match(/(?:src\/[a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|css|json))/g);
    const targetFiles = Array.from(new Set(fileMatches ?? []));
    if (targetFiles.length === 0) {
      try {
        const list = await this.execution.listFiles(environmentId);
        if (list.some((item) => item.path === "src/App.tsx")) {
          targetFiles.push("src/App.tsx");
        }
      } catch {
        // ignore
      }
    }
    const chunks: string[] = [];
    let totalBytes = 0;
    const maxBytes = 16_000;
    for (const filePath of targetFiles.slice(0, 5)) {
      try {
        const content = await this.execution.readFile(environmentId, filePath);
        const remaining = maxBytes - totalBytes;
        if (remaining <= 0) break;
        const excerpt = buildRepairSourceExcerpt(filePath, content, normalizedOutput, remaining);
        const size = Buffer.byteLength(excerpt);
        totalBytes += size;
        chunks.push(`--- ${filePath}\n${excerpt}`);
      } catch {
        // file may not exist
      }
    }
    return chunks.join("\n");
  }
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

function buildRepairSourceExcerpt(
  filePath: string,
  content: string,
  buildOutput: string,
  maxBytes: number,
): string {
  if (Buffer.byteLength(content) <= maxBytes) return content;

  const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineMatches = Array.from(
    buildOutput.matchAll(new RegExp(`${escapedPath}[:(](\\d+)`, "g")),
    (match) => Number(match[1]),
  ).filter((line) => Number.isInteger(line) && line > 0);
  const lines = content.split(/\r?\n/);
  const targetLines = lineMatches.length > 0 ? lineMatches : [1];
  const included = new Set<number>();
  for (const target of targetLines.slice(0, 4)) {
    for (let line = Math.max(1, target - 12); line <= Math.min(lines.length, target + 12); line += 1)
      included.add(line);
  }
  const excerpt = Array.from(included)
    .sort((left, right) => left - right)
    .map((line) => `${line}: ${lines[line - 1]}`)
    .join("\n");
  return Buffer.from(excerpt).subarray(0, Math.max(0, maxBytes)).toString("utf8");
}
