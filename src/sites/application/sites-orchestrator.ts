import { randomUUID } from "node:crypto";
import type { AgentProvider } from "../../agents/agent-provider.js";
import { AgentCodingLoop, type AgentLoopResult } from "../../agents/agent-loop.js";
import { SitesToolExecutor } from "../../agents/tool-executor.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { BuildResult, PreviewSession } from "../../execution/execution-types.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import type {
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../../persistence/repositories.js";
import type { DesignPlanner, RequirementsPlanner } from "../../planning/planning.js";
import { assembleSiteSpec } from "../../planning/planning.js";
import type { JobId, SiteId, UserId, VersionId } from "../../shared/types.js";
import type { SiteJob, SiteProject, SiteVersion } from "../domain/entities.js";
import type { SiteSpec } from "../domain/site-spec.js";
import type { SiteUsageRecord } from "../domain/usage.js";
import { assertTransition, type WorkflowState } from "../domain/workflow.js";
import type { EditSiteRequest, GenerateSiteRequest } from "./requests.js";
import type { SiteProgressPublisher } from "./progress.js";
import { SitesAgentContextBuilder } from "../../agents/context/sites-agent-context.js";
import type {
  EditWebsiteRequest,
  GenerateWebsiteRequest,
  LocalSiteGenerationPipeline,
  SiteEditResult,
  SiteGenerationResult,
} from "../generation/local-site-generation-pipeline.js";

export interface SitesWorkflowOptions {
  readonly maxAgentTurns?: number;
  readonly maxBuildRepairAttempts?: number;
  readonly maxToolCalls?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly localGenerationPipeline?: LocalSiteGenerationPipeline;
}
export interface SitesWorkflowResult {
  readonly project: SiteProject;
  readonly job: SiteJob;
  readonly version: SiteVersion;
  readonly spec?: SiteSpec;
  readonly preview: PreviewSession;
  readonly build: BuildResult;
  readonly usage: SiteUsageRecord;
}
interface RunInput {
  readonly userId: UserId;
  readonly prompt: string;
  readonly project: SiteProject;
  readonly jobType: "GENERATE_SITE" | "EDIT_SITE";
  readonly parentVersion?: SiteVersion;
  readonly spec?: SiteSpec;
  readonly signal?: AbortSignal;
}
interface UsageAccumulator {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  builds: number;
  executionSeconds: number;
  toolCalls: number;
  latencyMs: number;
  reasoningTokens: number;
  retryCount: number;
  providerId?: string;
  model?: string;
}

export class SitesOrchestrator {
  readonly #maxBuildRepairAttempts: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #agent: AgentProvider;
  readonly #tools: SitesToolExecutor;
  readonly #maxAgentTurns: number;
  readonly #maxToolCalls: number;
  readonly #localGenerationPipeline?: LocalSiteGenerationPipeline;
  readonly #context = new SitesAgentContextBuilder();
  constructor(
    agent: AgentProvider,
    private readonly execution: ExecutionProvider,
    private readonly artifacts: ArtifactStore,
    private readonly projects: SiteProjectRepository,
    private readonly versions: SiteVersionRepository,
    private readonly jobs: SiteJobRepository,
    private readonly requirements: RequirementsPlanner,
    private readonly design: DesignPlanner,
    private readonly progress: SiteProgressPublisher,
    options: SitesWorkflowOptions = {},
  ) {
    this.#maxBuildRepairAttempts = options.maxBuildRepairAttempts ?? 2;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#agent = agent;
    this.#tools = new SitesToolExecutor(execution);
    this.#maxAgentTurns = options.maxAgentTurns ?? 10;
    this.#maxToolCalls = options.maxToolCalls ?? 40;
    if (options.localGenerationPipeline)
      this.#localGenerationPipeline = options.localGenerationPipeline;
  }

  async generateWebsite(request: GenerateWebsiteRequest): Promise<SiteGenerationResult> {
    if (!this.#localGenerationPipeline)
      throw new ApplicationError(
        "PROVIDER_NOT_AVAILABLE",
        "Local site generation pipeline is not configured",
      );
    return this.#localGenerationPipeline.generate(request);
  }
  async editWebsite(request: EditWebsiteRequest): Promise<SiteEditResult> {
    if (!this.#localGenerationPipeline)
      throw new ApplicationError(
        "PROVIDER_NOT_AVAILABLE",
        "Local site generation pipeline is not configured",
      );
    return this.#localGenerationPipeline.edit(request);
  }

  async createSite(request: GenerateSiteRequest): Promise<SitesWorkflowResult> {
    if (!request.prompt.trim())
      throw new ApplicationError("VALIDATION_FAILED", "Prompt is required");
    const now = this.#now();
    const siteId = this.#createId() as SiteId;
    const name = request.projectName?.trim() || "Generated Site";
    const project: SiteProject = {
      id: siteId,
      ownerId: request.userId,
      name,
      slug: `${slugify(name)}-${siteId.slice(0, 6).toLowerCase()}`,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    };
    await this.projects.save(project);
    return this.#run({
      userId: request.userId,
      prompt: request.prompt,
      project,
      jobType: "GENERATE_SITE",
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  async editSite(request: EditSiteRequest): Promise<SitesWorkflowResult> {
    if (!request.prompt.trim())
      throw new ApplicationError("VALIDATION_FAILED", "Edit prompt is required");
    const project = await this.projects.getById(request.siteId);
    if (!project || project.ownerId !== request.userId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site project was not found");
    const versionId = request.baseVersionId ?? project.latestVersionId;
    const parentVersion = versionId ? await this.versions.getById(versionId) : undefined;
    if (!parentVersion || parentVersion.siteId !== project.id)
      throw new ApplicationError("VERSION_NOT_FOUND", "Base version was not found");
    return this.#run({
      userId: request.userId,
      prompt: request.prompt,
      project,
      jobType: "EDIT_SITE",
      parentVersion,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  async #run(input: RunInput): Promise<SitesWorkflowResult> {
    const jobId = this.#createId() as JobId;
    const createdAt = this.#now();
    let state: WorkflowState = "QUEUED";
    let job: SiteJob = {
      id: jobId,
      siteId: input.project.id,
      userId: input.userId,
      type: input.jobType,
      status: "QUEUED",
      progress: 0,
      createdAt,
    };
    await this.jobs.save(job);
    this.#emit(job, state, 0, "Job queued");
    let environmentId: string | undefined;
    const usage: UsageAccumulator = {
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      builds: 0,
      executionSeconds: 0,
      toolCalls: 0,
      latencyMs: 0,
      reasoningTokens: 0,
      retryCount: 0,
    };
    const agentLoop = new AgentCodingLoop(this.#agent, this.#tools, {
      maxTurns: this.#maxAgentTurns,
      maxToolCalls: this.#maxToolCalls,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const active = (): void => {
      if (input.signal?.aborted)
        throw new ApplicationError("JOB_CANCELLED", "Sites job was cancelled");
    };
    const move = async (next: WorkflowState, progress: number, message: string): Promise<void> => {
      assertTransition(state, next);
      state = next;
      job = {
        ...job,
        status: next === "COMPLETED" ? "SUCCEEDED" : next === "FAILED" ? "FAILED" : "RUNNING",
        progress,
        ...(job.startedAt ? {} : { startedAt: this.#now() }),
        ...(["COMPLETED", "FAILED", "CANCELLED"].includes(next)
          ? { completedAt: this.#now() }
          : {}),
      };
      await this.jobs.save(job);
      this.#emit(job, next, progress, message);
    };
    try {
      active();
      await move("PLANNING", 10, "Planning requirements");
      const requirementSpec = await this.requirements.plan(input.prompt);
      await move("DESIGNING", 20, "Planning design");
      const designSpec = await this.design.plan(requirementSpec);
      const spec =
        input.spec ??
        assembleSiteSpec(input.project.name, input.prompt, requirementSpec, designSpec);
      await move("CREATING_ENVIRONMENT", 30, "Creating execution environment");
      const environment = await this.execution.createEnvironment({
        cpu: 1,
        memoryMb: 512,
        timeoutSeconds: 300,
        networkPolicy: "DENY_ALL",
      });
      environmentId = environment.id;
      if (input.parentVersion)
        await this.#restoreSource(environment.id, input.parentVersion.sourceArtifactRef);
      await move(
        "GENERATING",
        45,
        input.jobType === "EDIT_SITE" ? "Applying targeted edit" : "Generating project files",
      );
      this.#addAgentUsage(
        usage,
        await agentLoop.run(
          environment.id,
          this.#context.build({
            operation: input.jobType === "EDIT_SITE" ? "EDIT" : "GENERATE",
            userRequest: input.prompt,
            siteSpec: spec,
            workflowState: "GENERATING",
          }),
        ),
      );
      await move("BUILDING", 60, "Building project");
      const build = await this.#buildWithRepair(environment.id, usage, async (message) => {
        await move("GENERATING", 65, "Repairing failed build");
        this.#addAgentUsage(
          usage,
          await agentLoop.run(
            environment.id,
            this.#context.build({
              operation: "REPAIR",
              userRequest: input.prompt,
              siteSpec: spec,
              buildError: message,
              workflowState: "GENERATING",
            }),
          ),
        );
        await move("BUILDING", 70, "Rebuilding project");
      });
      const previewResult = await this.execution.startPreview(environment.id, { port: 4173 });
      if (!previewResult.url)
        throw new ApplicationError("PREVIEW_FAILED", "Preview provider returned no URL");
      await move("PREVIEW_READY", 80, "Preview ready");
      const preview: PreviewSession = {
        environmentId: environment.id,
        url: previewResult.url,
        port: previewResult.port,
        status: "READY",
        previewMode: previewResult.mode,
        createdAt: this.#now(),
        ...(previewResult.expiresAt ? { expiresAt: previewResult.expiresAt } : {}),
      };
      await move("SAVING", 90, "Saving immutable version");
      const version = await this.#saveVersion(
        input.project.id,
        environment.id,
        input.parentVersion,
        build,
      );
      const project: SiteProject = {
        ...input.project,
        latestVersionId: version.id,
        updatedAt: this.#now(),
      };
      await this.projects.save(project);
      await move("COMPLETED", 100, "Workflow completed");
      return {
        project,
        job,
        version,
        spec,
        preview,
        build,
        usage: this.#usageRecord(input.project.id, job.id, usage),
      };
    } catch (cause) {
      if (!new Set<WorkflowState>(["FAILED", "COMPLETED", "CANCELLED"]).has(state)) {
        try {
          await move(
            cause instanceof ApplicationError && cause.code === "JOB_CANCELLED"
              ? "CANCELLED"
              : "FAILED",
            job.progress,
            cause instanceof Error ? cause.message : "Workflow failed",
          );
        } catch {
          job = {
            ...job,
            status: "FAILED",
            error: { code: "WORKFLOW_FAILED", message: "Workflow failed" },
            completedAt: this.#now(),
          };
          await this.jobs.save(job);
        }
      }
      throw cause;
    } finally {
      if (environmentId) await this.execution.destroyEnvironment(environmentId);
    }
  }

  async #buildWithRepair(
    environmentId: string,
    usage: UsageAccumulator,
    repair: (message: string) => Promise<void>,
  ): Promise<BuildResult> {
    for (let attempt = 0; attempt <= this.#maxBuildRepairAttempts; attempt += 1) {
      const command = { executable: "npm", args: ["run", "build"] } as const;
      const result = await this.execution.executeCommand(environmentId, command);
      usage.builds += 1;
      usage.executionSeconds += result.durationMs / 1000;
      const build: BuildResult = {
        success: result.exitCode === 0 && !result.timedOut,
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(!result.exitCode && !result.timedOut
          ? {}
          : {
              failureKind: result.timedOut ? ("TIMEOUT" as const) : ("TYPESCRIPT_FAILURE" as const),
            }),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
      };
      if (build.success) return build;
      if (attempt === this.#maxBuildRepairAttempts)
        throw new ApplicationError("BUILD_FAILED", `Build failed after ${attempt + 1} attempts`, {
          metadata: { attempts: attempt + 1 },
        });
      await repair(result.stderr);
    }
    throw new ApplicationError("BUILD_FAILED", "Build failed");
  }

  async #saveVersion(
    siteId: SiteId,
    environmentId: string,
    parent: SiteVersion | undefined,
    build: BuildResult,
  ): Promise<SiteVersion> {
    const files = await this.execution.listFiles(environmentId);
    const snapshot: Record<string, string> = {};
    for (const file of files)
      snapshot[file.path] = await this.execution.readFile(environmentId, file.path);
    const versionNumber = parent
      ? parent.versionNumber + 1
      : (await this.versions.listBySite(siteId)).items.length + 1;
    const versionId = this.#createId() as VersionId;
    const sourceArtifactRef = `sites/${siteId}/versions/${versionNumber}/source.json`;
    const buildArtifactRef = `sites/${siteId}/versions/${versionNumber}/build.json`;
    await this.artifacts.put(sourceArtifactRef, Buffer.from(JSON.stringify(snapshot)), {
      kind: "SOURCE_ARCHIVE",
      contentType: "application/json",
    });
    await this.artifacts.put(buildArtifactRef, Buffer.from(JSON.stringify(build)), {
      kind: "PRODUCTION_BUILD",
      contentType: "application/json",
    });
    const version: SiteVersion = {
      id: versionId,
      siteId,
      versionNumber,
      ...(parent ? { parentVersionId: parent.id } : {}),
      sourceArtifactRef,
      buildArtifactRef,
      buildStatus: "SUCCEEDED",
      createdAt: this.#now(),
    };
    await this.versions.save(version);
    return version;
  }
  async #restoreSource(environmentId: string, reference: string): Promise<void> {
    const artifact = await this.artifacts.get(reference);
    if (!artifact) throw new ApplicationError("VERSION_NOT_FOUND", "Source artifact was not found");
    const files = JSON.parse(Buffer.from(artifact).toString("utf8")) as Record<string, string>;
    for (const [path, content] of Object.entries(files))
      await this.execution.writeFile(environmentId, path, content);
  }
  #addAgentUsage(target: UsageAccumulator, result: AgentLoopResult): void {
    target.calls += result.turns;
    target.inputTokens += result.inputTokens;
    target.cachedInputTokens += result.cachedInputTokens;
    target.outputTokens += result.outputTokens;
    target.toolCalls += result.toolCalls;
    target.latencyMs += result.latencyMs;
    target.reasoningTokens += result.reasoningTokens ?? 0;
    target.retryCount += result.retryCount ?? 0;
    target.providerId = result.providerId;
    target.model = result.model;
  }
  #usageRecord(siteId: SiteId, jobId: JobId, usage: UsageAccumulator): SiteUsageRecord {
    return {
      siteId,
      jobId,
      agent: {
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.providerId ? { providerId: usage.providerId } : {}),
        ...(usage.model ? { model: usage.model } : {}),
        latencyMs: usage.latencyMs,
        toolCalls: usage.toolCalls,
        ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.retryCount > 0 ? { retryCount: usage.retryCount } : {}),
      },
      execution: {
        providerId: this.execution.id,
        seconds: usage.executionSeconds,
        cpuSeconds: usage.executionSeconds,
        memoryMbSeconds: usage.executionSeconds * 512,
      },
      builds: usage.builds,
      previewSeconds: 0,
      visualQaCalls: 0,
      imageGenerations: 0,
      recordedAt: this.#now(),
    };
  }
  #emit(job: SiteJob, state: WorkflowState, progress: number, message: string): void {
    this.progress.publish({
      jobId: job.id,
      siteId: job.siteId,
      state,
      progress,
      message,
      timestamp: this.#now(),
    });
  }
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "site";
