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
  BASELINE_STYLESHEET,
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
    if (operation === "GENERATE_SITE") {
      await scaffoldDeterministicReactVite(this.execution, environmentId, {
        ...(task.siteSpec?.project.name ? { projectName: task.siteSpec.project.name } : {}),
        designSeed: task.userRequest,
      });
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
      const responseContract = operation === "EDIT_SITE" && !broadFunctionalEdit ? {
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
      // Everything ahead of the boundary repeats across requests for this site,
      // so it is sent first and marked as a reusable prefix.
      const stableLead = [
        operation === "EDIT_SITE" && broadFunctionalEdit
          ? "Return exactly one JSON object matching the SiteCoderFileBundle schema. This is a broad functional edit of the existing site: return complete contents only for editable source files you change. Preserve its design, text, and layout. Do not call tools."
          : operation === "EDIT_SITE"
            ? "Return exactly one JSON object matching the SiteEditPatchBundle schema. Make the smallest requested source edit and do not call tools."
            : "Return exactly one JSON object matching the SiteCoderFileBundle schema. Do not call tools.",
        operation === "EDIT_SITE" && broadFunctionalEdit
          ? "Make the existing visible navigation and controls genuinely interactive using React state and local browser storage where appropriate. Provide working view changes, search/filtering, menus, dialogs and form actions that fit the existing UI; do not claim a remote backend exists. Keep every current section and visual treatment. Do not modify Sites-managed files or dependency manifests."
          : operation === "EDIT_SITE"
          ? [
              "Only patch the requested editable source file; never modify package manifests, configuration, lockfiles, or Sites-managed files.",
              "Every 'find' must match the file byte-for-byte, including whitespace and JSX entities such as &amp;.",
              'With mode "unique" the find text must occur exactly once in that file, so anchor it: include the surrounding attribute, tag or line rather than a bare word. `Menu` alone will match many times; `<a href="#menu">Menu</a>` identifies one place.',
              'Use mode "all" only when the change genuinely applies to every exact occurrence in that file, such as renaming a brand that appears several times.',
              "Use one patch per distinct change; several patches may target the same file.",
            ].join(" ")
          : "Write only editable application source files. Never modify package manifests, configuration, lockfiles, or Sites-managed files.",
        operation === "GENERATE_SITE"
          ? [
              "The existing React + TypeScript + Vite scaffold supplies src/main.tsx, baseline src/styles.css, and project configuration.",
              "The bundle must contain a complete, non-empty src/App.tsx application entry component.",
              "You may add components, views, pages, and custom CSS files. Every local import you add must resolve to a file in this bundle or the documented scaffold.",
              "Return compilable TypeScript/TSX, use React state for requested demo interactions, and do not regenerate unchanged scaffold boilerplate.",
              "In JSX text, write < and > as &lt; and &gt; and { } as &#123; &#125;; copy such as \"go live in <5 minutes\" is a TypeScript syntax error. Keep every JSX tag, brace, and parenthesis balanced.",
            ].join(" ")
          : "",
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
      const response = await gatewayProvider.createResponse({
        model: capabilities.models[0] ?? "unknown",
        systemInstructions: runtimePrompt.prompt.systemPrompt,
        promptCacheKey: `sites:${task.siteId}:${operation}`,
        cachePrefixChars: stableLead.length + 2,
        messages: [{
          role: "user",
          content: [
            stableLead,
            context.slice(discovered.stableChars),
            operation === "GENERATE_SITE" && completionRequirements ? `Required pages/views: ${completionRequirements.requiredPages.join(", ")}\nRequired sections/features: ${completionRequirements.requiredSections.join(", ")}. Implement these semantically using appropriate React routes, state, tabs, views, or components. Legacy data-sites-page and data-sites-section attributes are optional and are not required.` : "",
            // A targeted edit works from current source, not from the original brief.
            projectedSiteSpec && operation === "GENERATE_SITE"
              ? `SiteSpec: ${JSON.stringify(projectedSiteSpec)}`
              : "",
            `User request: ${task.userRequest}`,
            ...(imageParts.length ? [
              "DESIGN REFERENCE: The attached image shows the website to build. Recreate the whole visible page as responsive React components and CSS, including its page shell, section order, background tone, typography, spacing, buttons, and detailed interface elements. If the screenshot contains an app preview inside a hero, rebuild that preview as UI within the hero; do not turn the entire page into the app or replace the hero with the screenshot. Treat generic SiteSpec style and scaffold art direction as fallback only where the reference is silent. Do not use the reference bitmap as an img, background, canvas, animation frame, or decorative overlay. Do not substitute a new visual concept. Avoid entrance and background animations unless the user asks for motion.",
            ] : []),
          ].filter(Boolean).join("\n\n"),
          ...(imageParts.length ? { imageParts } : {}),
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
        validate: (value) => operation === "EDIT_SITE" && !broadFunctionalEdit
          ? validateSiteEditPatchBundle(value)
          : validateSiteCoderFileBundle(value, completionRequirements),
        errorContext: operation === "EDIT_SITE" ? "Site edit" : "Site coder",
      }).value;
      if (operation === "EDIT_SITE" && !broadFunctionalEdit) {
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
            "Address every reported diagnostic, and leave each patched file syntactically complete: balanced JSX tags, braces, and parentheses.",
            "Each 'find' must match the file byte-for-byte. Any leading 'NN: ' line numbers in the source excerpt below are display only and are not part of the file.",
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
  ): Promise<{ readonly text: string; readonly stableChars: number }> {
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
        "",
        "Art direction:",
        ...(task.referenceImages?.length ? [
          "A design reference image is attached. Match the ENTIRE page composition visible in it: page type, navbar, hero arrangement, typography, palette, spacing, and sections. If the image is a landing page with an app dashboard inside its hero, build the landing page AND that dashboard UI.",
          "Rebuild any dashboard or interface shown inside the reference with readable HTML, CSS, and React elements. Do not display or animate the screenshot itself.",
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
              ? summarizeDesignSystem(content, Boolean(task.referenceImages?.length))
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
    // A targeted edit may only patch editable application source, so managed
    // scaffold files are cost without capability. Of what remains, only the files
    // the instruction actually implicates are worth sending; the rest are named in
    // a manifest so the model still knows the shape of the project.
    const editableEntries = (await this.execution.listFiles(environmentId))
      .filter((item) => item.type === "FILE")
      .filter((item) => isEditableContextPath(item.path.replaceAll("\\", "/"), profile))
      .filter((item) => (item.sizeBytes ?? 0) <= maxFile);
    const editableFiles: EditContextFile[] = [];
    for (const entry of editableEntries)
      editableFiles.push({
        path: entry.path.replaceAll("\\", "/"),
        content: await this.execution.readFile(environmentId, entry.path),
      });

    // Sorted so the prefix is byte-stable between edits, and so a file changed by
    // one edit only invalidates the cache from its own position onward.
    const sorted = [...editableFiles].sort((left, right) => left.path.localeCompare(right.path));
    const baseline = sorted.find((file) => file.path === BASELINE_STYLESHEET);
    const core = sorted.filter((file) => file.path !== BASELINE_STYLESHEET);
    const coreBytes = core.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    const broadFunctionalEdit = isBroadFunctionalEdit(task.userRequest);
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
        : []
      : selection.selected;

    const chunk = (file: EditContextFile) => `--- ${file.path}\n${file.content}`;
    let bytes = 0;
    const withinBudget = (files: readonly EditContextFile[]) =>
      files.filter((file) => {
        const size = Buffer.byteLength(file.content);
        if (bytes + size > maxBytes) return false;
        bytes += size;
        return true;
      });
    const stableSent = withinBudget(stableFiles);
    const variableSent = withinBudget(variableFiles);

    const stable = [
      `Sites-managed and off-limits (not shown): ${profile.files.managed.join(", ")}`,
      `Editable project files: ${sorted.map((file) => file.path).join(", ")}`,
      // Without the stylesheet itself, the model still needs to know the tokens exist.
      ...(baseline ? [summarizeDesignSystem(baseline.content)] : []),
      broadFunctionalEdit
        ? "Full source follows. Return complete contents only for editable files shown below that need functional changes; preserve their visual design."
        : "Full source follows. Patch only files shown in full below.",
      ...stableSent.map(chunk),
    ].join("\n\n");
    const variable = variableSent.map(chunk).join("\n\n");

    // The separator is always part of the prefix, present or not: a boundary that
    // moves by two characters when the tail is empty makes the prefix differ
    // between edits and defeats the cache entirely.
    const context = `${stable}\n\n${variable}`;
    const included = [...stableSent, ...variableSent].map((file) => file.path);
    this.#logEditContext(task, context, included, sorted.length - included.length, cacheable);
    return { text: context, stableChars: stable.length + 2 };
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

/** Editable application source: under src/ and not claimed by the profile's managed set. */
export function isEditableContextPath(path: string, profile: GeneratedAppProfile): boolean {
  if (!path.startsWith("src/")) return false;
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
