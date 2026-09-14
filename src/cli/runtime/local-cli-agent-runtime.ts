import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import { AgentCodingLoop, type AgentLoopResult } from "../../agents/agent-loop.js";
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
import { SITES_CODING_AGENT_PROMPT } from "../../agents/prompts/sites-coding-agent.prompt.js";
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
    const technicalProfile = resolveRuntimeProfile(task.siteSpec?.technical.profileId);

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

    const generationStage: InferenceStage =
      task.stage ?? (operation === "EDIT_SITE" ? "TARGETED_EDIT" : "GENERATE_SITE");
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
      operation === "GENERATE_SITE"
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

    const context = await this.#discoverContext(environmentId, task, operation, technicalProfile);

    const promptForEstimation = [
      SITES_CODING_AGENT_PROMPT,
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
      systemInstructions: SITES_CODING_AGENT_PROMPT,
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
    this.progress?.("GENERATING", "Running LOCAL_CLI coding-agent loop");
    const loop = await new AgentCodingLoop(gatewayProvider, tools, {
      maxTurns: task.limits?.maxAgentTurns ?? 12,
      maxToolCalls: task.limits?.maxToolCalls ?? 40,
      maxOutputTokens: requestedOutputAllowance,
      reasoningPolicy: stagePolicy.reasoningPolicy,
      tools: stagePolicy.tools,
      requireFilesWritten: operation === "GENERATE_SITE",
      finalizeOnMaxTurns: true,
      finalizeOnWrite: operation === "EDIT_SITE",
      stage: generationStage,
      ...(completionRequirements !== undefined ? { completionRequirements } : {}),
      ...(signal ? { signal } : {}),
    }).run(
      environmentId,
      [
        `Operation: ${operation === "EDIT_SITE" ? "EDIT" : "GENERATE"}`,
        `User request: ${task.userRequest}`,
        operation === "GENERATE_SITE"
          ? [
              "CRITICAL: The current workspace contains only a starter fixture header ('AI Sites Local Execution Test'). You must write the full website implementation by overwriting src/App.tsx and updating src/styles.css using write_file.",
              `Required structural markers: Every page must have data-sites-page="<page-id>" and every section must have data-sites-section="<section-id>".`,
              completionRequirements
                ? `Required pages: ${completionRequirements.requiredPages.join(", ")}\nRequired sections: ${completionRequirements.requiredSections.join(", ")}`
                : "",
              "MANDATORY SAME-RESPONSE PROTOCOL: issue write_file for src/App.tsx and src/styles.css, then issue finalize_generation as the final tool call in this response. Do not stop after writes, wait for observations, or answer with prose. Include the exact required page and section IDs in the manifest.",
            ]
              .filter(Boolean)
              .join("\n")
          : "",
        projectedSiteSpec ? `SiteSpec: ${JSON.stringify(projectedSiteSpec)}` : "",
        `Workspace context:\n${context}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (loop.limitReached)
      console.warn(
        `[sites] job=${task.jobId} agent reached maxTurns=${loop.turns}; finalizing workspace`,
      );
    if (operation === "GENERATE_SITE") {
      if (loop.completionAccepted !== true) {
        const issuesSummary = loop.completionIssues
          ?.map((i) => `[${i.code}] ${i.message}`)
          .join("; ");
        throw new ApplicationError(
          "GENERATION_INCOMPLETE",
          `GENERATION_INCOMPLETE: Generation failed to satisfy completion contract: ${issuesSummary || "finalize_generation was not called or accepted"}`,
          {
            metadata: {
              attempts: loop.generationCompletion?.attempts ?? 0,
              issues: loop.completionIssues ?? [],
              terminationReason: loop.normalizedFinishReason,
            },
          },
        );
      }
    }
    let automaticBuildAttempts = 0;
    const repairLoops: AgentLoopResult[] = [];
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
      const repairProvider = effectiveContext.createScopedProvider(
        rawGatewayProvider,
        "BUILD_REPAIR",
      );
      const repairPolicy = getInferenceContextPolicy("BUILD_REPAIR", {
        overrideMaxOutput: task.limits?.maxOutputTokens,
      });
      const repair = await new AgentCodingLoop(repairProvider, tools, {
        maxTurns: 1,
        maxToolCalls: 12,
        maxOutputTokens: repairPolicy.outputPolicy.defaultMaxOutputTokens,
        reasoningPolicy: repairPolicy.reasoningPolicy,
        tools: repairPolicy.tools,
        stage: "BUILD_REPAIR",
        finalizeOnMaxTurns: true,
        finalizeOnWrite: true,
        ...(signal ? { signal } : {}),
      }).run(
        environmentId,
        [
          "Operation: REPAIR",
          "Fix the current project so npm run build succeeds.",
          "Inspect the referenced files, make only necessary corrections, and do not redesign the site.",
          `Build output:\n${output}`,
          repairContext ? `Relevant source files:\n${repairContext}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      repairLoops.push(repair);
      automaticBuildAttempts += 1;
      build = await this.execution.executeCommand(environmentId, {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: task.limits?.timeoutMs ?? 60_000,
      });
    }
    if (!build || build.exitCode !== 0 || build.timedOut) {
      const output = build ? safeBuildOutput(build.stderr, build.stdout) : "No build result";
      console.error(
        `[sites] final build failed job=${task.jobId} exit=${build?.exitCode ?? "null"} timedOut=${build?.timedOut ?? false}\n${output.slice(-8_000)}`,
      );
      throw new ApplicationError(
        "REPAIR_LIMIT_REACHED",
        "Generated project production build failed after repair attempts",
        {
          metadata: {
            exitCode: build?.exitCode ?? null,
            timedOut: build?.timedOut ?? false,
            repairAttempts: repairLoops.length,
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
      model: loop.model,
      runtime: "LOCAL_CLI",
      turns: loop.turns + repairLoops.reduce((total, item) => total + item.turns, 0),
      toolCalls: loop.toolCalls + repairLoops.reduce((total, item) => total + item.toolCalls, 0),
      buildAttempts: tools.buildAttempts + automaticBuildAttempts,
      finalBuildSuccess: this.execution.getLastBuildSuccess(environmentId) === true,
      ...(preview?.url ? { previewUrl: preview.url } : {}),
      filesChanged: files,
      durationMs: Date.now() - started,
      usage: {
        inputTokens:
          loop.inputTokens + repairLoops.reduce((total, item) => total + item.inputTokens, 0),
        cachedInputTokens:
          loop.cachedInputTokens +
          repairLoops.reduce((total, item) => total + item.cachedInputTokens, 0),
        outputTokens:
          loop.outputTokens + repairLoops.reduce((total, item) => total + item.outputTokens, 0),
        modelCalls: loop.turns + repairLoops.reduce((total, item) => total + item.turns, 0),
        limitReached: loop.limitReached ?? false,
        toolCalls: loop.toolCalls + repairLoops.reduce((total, item) => total + item.toolCalls, 0),
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
      ...(loop.generationCompletion !== undefined
        ? { generationCompletion: loop.generationCompletion }
        : {}),
    };
  }
  async #discoverContext(
    environmentId: string,
    task: CliTask,
    operation?: "GENERATE_SITE" | "EDIT_SITE",
    profile: GeneratedAppProfile = getDefaultProfile(),
  ): Promise<string> {
    if (operation === "GENERATE_SITE") {
      const contractLines = [
        "Runtime Contract:",
        `Runtime: ${formatTechnology(profile.framework)} + ${formatTechnology(profile.language)} + ${formatTechnology(profile.bundler)}`,
        `Bundler: ${formatTechnology(profile.bundler)} (${formatLogicalCommand(profile.commands.build)})`,
        "",
        "Editable:",
        ...profile.files.editable.map((path) => `- ${path}`),
        "",
        "Managed by Sites (deterministic scaffold, do not edit or recreate):",
        ...profile.files.managed.map((path) => `- ${path}`),
        "",
        "Rules:",
        "- Do not add external packages unless explicitly permitted.",
        "- Overwrite src/App.tsx and src/styles.css with complete implementation.",
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
    const fileMatches = buildOutput.match(/(?:src\/[a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|css|json))/g);
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
        const size = Buffer.byteLength(content);
        if (totalBytes + size > maxBytes) break;
        totalBytes += size;
        chunks.push(`--- ${filePath}\n${content}`);
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
