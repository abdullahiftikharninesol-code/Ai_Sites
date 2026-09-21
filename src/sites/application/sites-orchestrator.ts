import type { AgentProvider } from "../../agents/agent-provider.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { BuildResult, PreviewSession } from "../../execution/execution-types.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import type {
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../../persistence/repositories.js";
import type { RequirementsPlanner, DesignPlanner } from "../../planning/planning.js";
import type { SiteJob, SiteProject, SiteVersion } from "../domain/entities.js";
import type { SiteSpec } from "../domain/site-spec.js";
import type { SiteUsageRecord } from "../domain/usage.js";
import type { EditSiteRequest, GenerateSiteRequest } from "./requests.js";
import type { SiteProgressPublisher } from "./progress.js";
import type {
  EditWebsiteRequest,
  GenerateWebsiteRequest,
  LocalSiteGenerationPipeline,
  SiteEditResult,
  SiteGenerationResult,
} from "../generation/local-site-generation-pipeline.js";

export interface SitesWorkflowOptions {
  /** @deprecated Generation limits are owned by LocalSiteGenerationPipeline. */
  readonly maxAgentTurns?: number;
  /** @deprecated Generation limits are owned by LocalSiteGenerationPipeline. */
  readonly maxBuildRepairAttempts?: number;
  /** @deprecated Generation limits are owned by LocalSiteGenerationPipeline. */
  readonly maxToolCalls?: number;
  /** @deprecated The authoritative pipeline owns lifecycle timestamps. */
  readonly now?: () => Date;
  /** @deprecated The authoritative pipeline owns identifiers. */
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

export class SitesOrchestrator {
  readonly #agent: AgentProvider;
  readonly #localGenerationPipeline?: LocalSiteGenerationPipeline;
  constructor(
    agent: AgentProvider,
    _execution: ExecutionProvider,
    _artifacts: ArtifactStore,
    private readonly projects: SiteProjectRepository,
    private readonly versions: SiteVersionRepository,
    private readonly jobs: SiteJobRepository,
    _requirements: RequirementsPlanner,
    _design: DesignPlanner,
    _progress: SiteProgressPublisher,
    options: SitesWorkflowOptions = {},
  ) {
    this.#agent = agent;
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
    const pipeline = this.#requireLocalGenerationPipeline();
    return this.#workflowResult(
      await pipeline.generate({
        userId: request.userId,
        prompt: request.prompt,
        ...(request.projectName ? { projectName: request.projectName } : {}),
        planningMode: "deterministic",
        agentProvider: this.#agent.id,
        browserQAEnabled: true,
        retainPreview: true,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  }

  async editSite(request: EditSiteRequest): Promise<SitesWorkflowResult> {
    if (!request.prompt.trim())
      throw new ApplicationError("VALIDATION_FAILED", "Edit prompt is required");
    const pipeline = this.#requireLocalGenerationPipeline();
    return this.#workflowResult(
      await pipeline.edit({
        userId: request.userId,
        siteId: request.siteId,
        ...(request.baseVersionId ? { versionId: request.baseVersionId } : {}),
        instruction: request.prompt,
        agentProvider: this.#agent.id,
        browserQAEnabled: true,
        retainPreview: true,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
  }

  #requireLocalGenerationPipeline(): LocalSiteGenerationPipeline {
    if (!this.#localGenerationPipeline)
      throw new ApplicationError(
        "PROVIDER_NOT_AVAILABLE",
        "Local site generation pipeline is not configured",
      );
    return this.#localGenerationPipeline;
  }

  async #workflowResult(result: SiteGenerationResult | SiteEditResult): Promise<SitesWorkflowResult> {
    const project = await this.projects.getById(result.siteId);
    const versionId = "versionId" in result ? result.versionId : result.newVersionId;
    const version = await this.versions.getById(versionId);
    const job = await this.jobs.getById(result.jobId);
    if (!project || !version || !job)
      throw new ApplicationError("PERSISTENCE_READ_FAILED", "Generated workflow artifacts were not persisted");
    return {
      project,
      job,
      version,
      ...(version.siteSpec ? { spec: version.siteSpec } : {}),
      preview: result.preview,
      build: result.build,
      usage: {
        siteId: result.siteId,
        jobId: result.jobId,
        agent: {
          calls: Number(result.usage.modelCalls ?? 0),
          inputTokens: Number(result.usage.inputTokens ?? 0),
          cachedInputTokens: Number(result.usage.cachedInputTokens ?? 0),
          outputTokens: Number(result.usage.outputTokens ?? 0),
          toolCalls: Number(result.usage.toolCalls ?? 0),
        },
        builds: Number(result.usage.buildAttempts ?? 0),
        previewSeconds: 0,
        visualQaCalls: 0,
        imageGenerations: 0,
        recordedAt: new Date(),
      },
    };
  }

}
