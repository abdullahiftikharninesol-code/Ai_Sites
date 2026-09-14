import { randomUUID } from "node:crypto";
import type { GeneratedAppProfile } from "../../cli/runtime/site-technical-profile.js";
import type {
  CliAgentSessionReport,
  LocalCliAgentRuntime,
} from "../../cli/runtime/local-cli-agent-runtime.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import type {
  BuildResult,
  PreviewResult,
  PreviewSession,
} from "../../execution/execution-types.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import type {
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../../persistence/repositories.js";
import {
  assembleSiteSpec,
  type DesignPlanner,
  type RequirementsPlanner,
} from "../../planning/planning.js";
import type { SiteDesignSpec, SiteRequirementSpec } from "../../planning/planning.js";
import {
  sitePlanToSiteSpec,
  sitePlanToRequirementSpec,
  sitePlanToDesignSpec,
} from "../domain/site-plan.js";
import type { JobId, SiteId, UserId, VersionId } from "../../shared/types.js";
import type { SiteJob, SiteProject, SiteVersion } from "../domain/entities.js";
import type { SiteSpec } from "../domain/site-spec.js";
import type { WorkflowState } from "../domain/workflow.js";
import type { SiteProgressPublisher } from "../application/progress.js";
import {
  GeneratedProjectValidator,
  SiteFunctionalValidator,
  SitePackageValidator,
  SitesV1ScopeValidator,
  type SiteGenerationWarning,
} from "./site-policies.js";
import {
  SiteSourceSnapshotService,
  summarizeChanges,
  type SiteChangeSummary,
} from "./source-snapshot.js";
import type { StarterTemplate, StarterTemplateRegistry } from "./starter-template-registry.js";
import type { VisualQAReport } from "../../visual-qa/visual-qa-types.js";
import type { VisualQARunner } from "../../visual-qa/visual-qa-runner.js";
import type {
  SiteVersionCommitter,
  UnnumberedSiteVersion,
} from "../../persistence/version-committer.js";
import { ArtifactNamespace } from "../../persistence/artifact-namespace.js";
import type { SiteRuntimeProvider } from "../../site-runtime/site-runtime-provider.js";
import type {
  AgentPlanningPipeline,
  AgentEditPlanner,
  AgentIntentClassifier,
  VisualAgentReviewer,
} from "../../agents/intelligence/agent-intelligence.js";
import type { AgentTaskTelemetry } from "../../agents/intelligence/intelligence-types.js";
import {
  createInferenceRunContext,
  type InferenceRunContext,
  type InferenceRunSummary,
} from "../../agents/budget/inference-run-context.js";
import type { GenerationCompletionTelemetry } from "../../agents/validation/generation-completion.js";
export interface GenerateWebsiteRequest {
  readonly userId: UserId;
  readonly prompt: string;
  readonly projectName?: string;
  readonly planningMode: "deterministic" | "agent" | "agent-with-fallback";
  readonly onIntelligence?: (telemetry: readonly AgentTaskTelemetry[]) => void;
  readonly agentProvider: string;
  readonly technicalProfile?: string;
  readonly signal?: AbortSignal;
  readonly visualQAEnabled?: boolean;
}
export interface EditWebsiteRequest {
  readonly userId: UserId;
  readonly siteId: SiteId;
  readonly versionId?: VersionId;
  readonly instruction: string;
  readonly onIntelligence?: (telemetry: readonly AgentTaskTelemetry[]) => void;
  readonly agentProvider: string;
  readonly signal?: AbortSignal;
  readonly visualQAEnabled?: boolean;
  readonly agentPlanningEnabled?: boolean;
}
export interface SiteGenerationResult {
  readonly siteId: SiteId;
  readonly jobId: JobId;
  readonly versionId: VersionId;
  readonly siteSpec: SiteSpec;
  readonly technicalProfile: GeneratedAppProfile;
  readonly build: BuildResult;
  readonly preview: PreviewSession;
  readonly sourceArtifactRef: string;
  readonly changedFiles: SiteChangeSummary;
  readonly warnings: readonly SiteGenerationWarning[];
  readonly usage: CliAgentSessionReport["usage"];
  readonly visualQA?: VisualQAReport;
  readonly intelligence?: readonly AgentTaskTelemetry[];
  readonly inference?: InferenceRunSummary;
  readonly completion?: GenerationCompletionTelemetry;
}
export interface SiteEditResult {
  readonly siteId: SiteId;
  readonly fromVersionId: VersionId;
  readonly newVersionId: VersionId;
  readonly build: BuildResult;
  readonly preview: PreviewSession;
  readonly changedFiles: SiteChangeSummary;
  readonly usage: CliAgentSessionReport["usage"];
  readonly visualQA?: VisualQAReport;
  readonly intelligence?: readonly AgentTaskTelemetry[];
  readonly inference?: InferenceRunSummary;
}
export interface LocalSiteGenerationPipelineDependencies {
  execution: LocalExecutionProvider;
  runtime: LocalCliAgentRuntime;
  artifacts: ArtifactStore;
  projects: SiteProjectRepository;
  versions: SiteVersionRepository;
  jobs: SiteJobRepository;
  requirements: RequirementsPlanner;
  design: DesignPlanner;
  agentRequirements?: RequirementsPlanner;
  agentDesign?: DesignPlanner;
  intelligencePlanning?: AgentPlanningPipeline;
  editPlanning?: AgentEditPlanner;
  intentClassifier?: AgentIntentClassifier;
  visualReview?: VisualAgentReviewer;
  progress: SiteProgressPublisher;
  templates: StarterTemplateRegistry;
  template: StarterTemplate;
  visualQA?: VisualQARunner;
  versionCommitter?: SiteVersionCommitter;
  runtimeProvider?: SiteRuntimeProvider;
}
export class LocalSiteGenerationPipeline {
  readonly #snapshots: SiteSourceSnapshotService;
  readonly #scope = new SitesV1ScopeValidator();
  readonly #packages = new SitePackageValidator();
  readonly #projectValidator = new GeneratedProjectValidator();
  readonly #functional = new SiteFunctionalValidator();
  constructor(private readonly deps: LocalSiteGenerationPipelineDependencies) {
    this.#snapshots = new SiteSourceSnapshotService(deps.artifacts);
  }
  async generate(request: GenerateWebsiteRequest): Promise<SiteGenerationResult> {
    this.#scope.validate(request.prompt);
    const technicalProfile = this.deps.templates.resolveProfile(this.deps.template);
    const siteId = randomUUID() as SiteId;
    const jobId = randomUUID() as JobId;
    const runContext = createInferenceRunContext({
      runId: jobId,
      limits: {
        maxModelRequests: 3,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const isAgentPlanning =
      (request.planningMode === "agent" || request.planningMode === "agent-with-fallback") &&
      Boolean(this.deps.intelligencePlanning);
    const sitePlanResult = isAgentPlanning
      ? await this.deps.intelligencePlanning!.planSite(request.prompt, request.signal, runContext)
      : undefined;
    const intent = sitePlanResult
      ? undefined
      : this.deps.intentClassifier
        ? await this.deps.intentClassifier.classify(
            request.prompt,
            "CREATE_SITE",
            request.signal,
            runContext,
          )
        : undefined;
    if (request.technicalProfile && request.technicalProfile !== technicalProfile.id)
      throw new ApplicationError(
        "UNSUPPORTED_SITE_REQUIREMENT",
        `Unsupported technical profile: ${request.technicalProfile}`,
      );
    const now = new Date();
    const project: SiteProject = {
      id: siteId,
      ownerId: request.userId,
      name: request.projectName?.trim() || "Generated Site",
      slug: `site-${siteId.slice(0, 8)}`,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.projects.save(project);
    let job: SiteJob = {
      id: jobId,
      siteId,
      userId: request.userId,
      type: "GENERATE_SITE",
      status: "QUEUED",
      progress: 0,
      createdAt: now,
    };
    await this.deps.jobs.save(job);
    this.#emit(job, "QUEUED", 0, "Website generation queued");

    let requirements: SiteRequirementSpec;
    let design: SiteDesignSpec;
    let siteSpec: SiteSpec;

    if (sitePlanResult) {
      request.onIntelligence?.(sitePlanResult.telemetry);
      requirements = sitePlanToRequirementSpec(sitePlanResult.value);
      this.#emit(job, "PLANNING", 10, "Requirements planned");
      design = sitePlanToDesignSpec(sitePlanResult.value);
      this.#emit(job, "DESIGNING", 20, "Design planned");
      siteSpec = sitePlanToSiteSpec(project.name, request.prompt, sitePlanResult.value);
    } else {
      if (intent) request.onIntelligence?.(intent.telemetry);
      const requirementsPlanner =
        request.planningMode === "agent" ? this.deps.agentRequirements : this.deps.requirements;
      const designPlanner =
        request.planningMode === "agent" ? this.deps.agentDesign : this.deps.design;
      if (!requirementsPlanner || !designPlanner)
        throw new ApplicationError("PLANNING_FAILED", "Agent planning is not configured");
      requirements = await requirementsPlanner.plan(request.prompt);
      this.#emit(job, "PLANNING", 10, "Requirements planned");
      design = await designPlanner.plan(requirements);
      this.#emit(job, "DESIGNING", 20, "Design planned");
      siteSpec = assembleSiteSpec(project.name, request.prompt, requirements, design);
    }

    const siteRuntime =
      siteSpec.runtime?.enabled && this.deps.runtimeProvider
        ? await this.deps.runtimeProvider.provisionRuntime(siteId, siteSpec.runtime)
        : undefined;
    const environment = await this.deps.execution.createEnvironment({});
    let codeGenerationCompleted = false;
    this.#emit(job, "CREATING_ENVIRONMENT", 30, "Created disposable local workspace");
    try {
      await this.deps.templates.seed(this.deps.execution, environment.id, this.deps.template);
      this.#packages.validate(await this.deps.execution.readFile(environment.id, "package.json"));
      await this.#installDependencies(environment.id, jobId, "starter");
      this.#emit(job, "GENERATING", 45, "Agent generating website source");
      request.onIntelligence?.([
        this.#statusTelemetry("CODE_GENERATION", "RUNNING", request.agentProvider, true),
        this.#statusTelemetry("TOOL_LOOP", "PENDING", request.agentProvider),
        this.#statusTelemetry("BUILD_REPAIR", "NOT_NEEDED", request.agentProvider),
        this.#statusTelemetry("TARGETED_EDIT", "NOT_NEEDED", request.agentProvider),
        this.#statusTelemetry(
          "VISUAL_REVIEW",
          request.agentProvider === "mock" ? "PENDING" : "UNSUPPORTED",
          request.agentProvider,
        ),
        this.#statusTelemetry(
          "VISUAL_REPAIR",
          request.agentProvider === "mock" ? "PENDING" : "UNSUPPORTED",
          request.agentProvider,
        ),
      ]);
      const session = await this.deps.runtime.run(
        environment.id,
        {
          jobId,
          siteId,
          operation: "GENERATE_SITE",
          runtime: "LOCAL_CLI",
          agentProvider: request.agentProvider,
          userRequest: request.prompt,
          siteSpec,
          limits: {
            maxAgentTurns: 12,
            maxToolCalls: 40,
            maxBuildRepairs: 1,
            maxModelRequests: 3,
            maxContextFiles: 24,
            maxContextBytes: 64_000,
            maxLogBytes: 12_000,
            maxOutputTokens: 16_384,
          },
          runContext,
        },
        request.signal,
        runContext,
      );
      codeGenerationCompleted = true;
      let intelligenceTelemetry = [
        ...(sitePlanResult ? sitePlanResult.telemetry : (intent?.telemetry ?? [])),
        this.#sessionTelemetry("CODE_GENERATION", session, "PASS"),
        this.#sessionTelemetry("TOOL_LOOP", session, "PASS"),
        this.#sessionTelemetry(
          "BUILD_REPAIR",
          session,
          session.buildAttempts > 1 ? "PASS" : "NOT_NEEDED",
        ),
        this.#statusTelemetry("VISUAL_REVIEW", "NOT_NEEDED", request.agentProvider),
        this.#statusTelemetry("VISUAL_REPAIR", "NOT_NEEDED", request.agentProvider),
      ];
      request.onIntelligence?.(intelligenceTelemetry);
      await this.#projectValidator.validate(this.deps.execution, environment.id);
      let previewResult = this.deps.execution.getLatestPreview(environment.id);
      if (!previewResult?.url)
        throw new ApplicationError("PREVIEW_FAILED", "Generation produced no ready preview");
      await this.#functional.validate(
        previewResult.url,
        request.agentProvider === "mock" ? "AI Sites Generated Hero" : undefined,
      );
      const versionId = randomUUID() as VersionId;
      if (request.visualQAEnabled)
        this.#emit(job, "QA_RUNNING", 75, "Rendering desktop, tablet, and mobile visual QA");
      const visualQA = await this.#runVisualQA(
        request.visualQAEnabled,
        siteId,
        versionId,
        previewResult.url,
        siteSpec,
        environment.id,
        request.agentProvider,
        request.signal,
        (next) => {
          previewResult = next;
        },
        runContext,
      );
      if (visualQA && this.deps.visualReview) {
        const screenshots = visualQA.attempts.at(-1)?.screenshots ?? [];
        const review = await this.deps.visualReview.review(
          {
            screenshots,
            viewports: screenshots.map(({ viewport: name, width, height }) => ({
              name,
              width,
              height,
            })),
            deterministicReport: visualQA.finalResult,
            design: siteSpec.design,
            requirements: siteSpec.requirements,
          },
          request.signal,
          runContext,
        );
        intelligenceTelemetry = [
          ...intelligenceTelemetry.filter(
            ({ taskKind }) => taskKind !== "VISUAL_REVIEW" && taskKind !== "VISUAL_REPAIR",
          ),
          ...review.telemetry,
          this.#statusTelemetry(
            "VISUAL_REPAIR",
            review.telemetry[0]?.status === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : visualQA.visualRepairAttempts > 0
                ? "PASS"
                : "NOT_NEEDED",
            request.agentProvider,
            visualQA.visualRepairAttempts > 0,
          ),
        ];
        request.onIntelligence?.(intelligenceTelemetry);
      }
      if (visualQA)
        this.#emit(
          job,
          "QA_RUNNING",
          85,
          `Visual QA passed with score ${visualQA.finalResult.score}`,
        );
      const sourceArtifactRef = ArtifactNamespace.version(
        siteId,
        versionId,
        "SOURCE_ARCHIVE",
        "source.json",
      );
      const sourceManifestRef = ArtifactNamespace.version(
        siteId,
        versionId,
        "SOURCE_MANIFEST",
        "manifest.json",
      );
      const snapshot = await this.#snapshots.capture(
        this.deps.execution,
        environment.id,
        sourceArtifactRef,
        this.#metadata(),
      );
      const changedFiles = summarizeChanges(undefined, snapshot);
      const build = this.#build(environment.id);
      const buildArtifactRef = ArtifactNamespace.version(
        siteId,
        versionId,
        "PRODUCTION_BUILD",
        "build.json",
      );
      await this.deps.artifacts.put(buildArtifactRef, Buffer.from(JSON.stringify(build)), {
        kind: "PRODUCTION_BUILD",
        contentType: "application/json",
      });
      const versionDraft: UnnumberedSiteVersion = {
        id: versionId,
        siteId,
        sourceArtifactRef,
        sourceManifestRef,
        buildArtifactRef,
        buildStatus: "SUCCEEDED",
        siteSpec,
        technicalProfileId: technicalProfile.id,
        templateId: this.deps.template.templateId,
        templateVersion: this.deps.template.templateVersion,
        changeSummary: changedFiles.summary,
        ...(visualQA ? this.#versionVisualMetadata(visualQA) : {}),
        usageSummary: session.usage,
        ...(siteRuntime ? { runtimeSchemaVersion: siteRuntime.schemaVersion } : {}),
        createdAt: new Date(),
      };
      await this.#commitVersion(project, versionDraft, 1);
      job = { ...job, status: "SUCCEEDED", progress: 100, startedAt: now, completedAt: new Date() };
      await this.deps.jobs.save(job);
      this.#emit(job, "COMPLETED", 100, "Website Version 1 saved");
      return {
        siteId,
        jobId,
        versionId,
        siteSpec,
        technicalProfile,
        build,
        preview: this.#preview(environment.id, previewResult.url, previewResult.port),
        sourceArtifactRef,
        changedFiles,
        warnings: [],
        usage: session.usage,
        ...(visualQA ? { visualQA } : {}),
        intelligence: intelligenceTelemetry,
        inference: runContext.getSummary(),
        ...(session.generationCompletion ? { completion: session.generationCompletion } : {}),
      };
    } catch (cause) {
      request.onIntelligence?.([
        ...(codeGenerationCompleted
          ? []
          : [this.#failureTelemetry("CODE_GENERATION", request.agentProvider, cause)]),
        ...(codeGenerationCompleted
          ? []
          : [this.#statusTelemetry("TOOL_LOOP", "NOT_REACHED", request.agentProvider)]),
        ...(codeGenerationCompleted
          ? []
          : [this.#statusTelemetry("BUILD_REPAIR", "NOT_REACHED", request.agentProvider)]),
        this.#statusTelemetry("TARGETED_EDIT", "NOT_NEEDED", request.agentProvider),
        this.#statusTelemetry(
          "VISUAL_REVIEW",
          request.agentProvider === "mock" ? "NOT_REACHED" : "UNSUPPORTED",
          request.agentProvider,
        ),
        this.#statusTelemetry(
          "VISUAL_REPAIR",
          request.agentProvider === "mock" ? "NOT_REACHED" : "UNSUPPORTED",
          request.agentProvider,
        ),
      ]);
      job = {
        ...job,
        status:
          cause instanceof ApplicationError && cause.code === "JOB_CANCELLED"
            ? "CANCELLED"
            : "FAILED",
        completedAt: new Date(),
      };
      await this.deps.jobs.save(job);
      throw cause;
    } finally {
      await this.deps.execution.destroyEnvironment(environment.id);
    }
  }
  async edit(request: EditWebsiteRequest): Promise<SiteEditResult> {
    const editJobId = randomUUID();
    const runContext = createInferenceRunContext({
      runId: editJobId,
      limits: {
        maxModelRequests: 3,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const intent = this.deps.intentClassifier
      ? await this.deps.intentClassifier.classify(
          request.instruction,
          "EDIT_SITE",
          request.signal,
          runContext,
        )
      : undefined;
    request.onIntelligence?.(intent?.telemetry ?? []);
    const project = await this.deps.projects.getById(request.siteId);
    if (!project || project.ownerId !== request.userId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site project was not found");
    const fromVersionId = request.versionId ?? project.latestVersionId;
    if (!fromVersionId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const parent = await this.deps.versions.getById(fromVersionId);
    if (!parent) throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const environment = await this.deps.execution.createEnvironment({});
    try {
      const before = await this.#snapshots.restore(
        this.deps.execution,
        environment.id,
        parent.sourceArtifactRef,
      );
      this.#packages.validate(await this.deps.execution.readFile(environment.id, "package.json"));
      await this.#installDependencies(environment.id, String(request.siteId), "restored");
      const editPlan =
        request.agentPlanningEnabled && this.deps.editPlanning
          ? await this.deps.editPlanning.plan(request.instruction, request.signal, runContext)
          : undefined;
      request.onIntelligence?.(editPlan?.telemetry ?? []);
      request.onIntelligence?.([
        this.#statusTelemetry("TARGETED_EDIT", "RUNNING", request.agentProvider, true),
        this.#statusTelemetry("TOOL_LOOP", "PENDING", request.agentProvider),
        this.#statusTelemetry("BUILD_REPAIR", "NOT_NEEDED", request.agentProvider),
      ]);
      const session = await this.deps.runtime.run(
        environment.id,
        {
          jobId: editJobId,
          siteId: request.siteId,
          operation: "EDIT_SITE",
          runtime: "LOCAL_CLI",
          agentProvider: request.agentProvider,
          userRequest: editPlan
            ? `${request.instruction}\nValidated edit plan: ${JSON.stringify(editPlan.value)}`
            : request.instruction,
          ...(parent.siteSpec ? { siteSpec: parent.siteSpec } : {}),
          limits: { maxAgentTurns: 10, maxToolCalls: 30, maxBuildRepairs: 2 },
          runContext,
        },
        request.signal,
        runContext,
      );
      let intelligenceTelemetry = [
        ...(intent?.telemetry ?? []),
        ...(editPlan?.telemetry ?? []),
        this.#sessionTelemetry("TARGETED_EDIT", session, "PASS"),
        this.#sessionTelemetry("TOOL_LOOP", session, "PASS"),
        this.#sessionTelemetry(
          "BUILD_REPAIR",
          session,
          session.buildAttempts > 1 ? "PASS" : "NOT_NEEDED",
        ),
        this.#statusTelemetry("VISUAL_REVIEW", "NOT_NEEDED", request.agentProvider),
        this.#statusTelemetry("VISUAL_REPAIR", "NOT_NEEDED", request.agentProvider),
      ];
      request.onIntelligence?.(intelligenceTelemetry);
      await this.#projectValidator.validate(this.deps.execution, environment.id);
      let previewResult = this.deps.execution.getLatestPreview(environment.id);
      if (!previewResult?.url)
        throw new ApplicationError("PREVIEW_FAILED", "Edit produced no ready preview");
      await this.#functional.validate(
        previewResult.url,
        request.agentProvider === "mock" ? "AI Sites Updated Hero" : undefined,
      );
      const versionNumber = parent.versionNumber + 1;
      const newVersionId = randomUUID() as VersionId;
      const visualQA = await this.#runVisualQA(
        request.visualQAEnabled,
        request.siteId,
        newVersionId,
        previewResult.url,
        parent.siteSpec,
        environment.id,
        request.agentProvider,
        request.signal,
        (next) => {
          previewResult = next;
        },
        runContext,
      );
      if (visualQA && this.deps.visualReview && parent.siteSpec) {
        const screenshots = visualQA.attempts.at(-1)?.screenshots ?? [];
        const review = await this.deps.visualReview.review(
          {
            screenshots,
            viewports: screenshots.map(({ viewport: name, width, height }) => ({
              name,
              width,
              height,
            })),
            deterministicReport: visualQA.finalResult,
            design: parent.siteSpec.design,
            requirements: parent.siteSpec.requirements,
          },
          request.signal,
          runContext,
        );
        intelligenceTelemetry = [
          ...intelligenceTelemetry.filter(
            ({ taskKind }) => taskKind !== "VISUAL_REVIEW" && taskKind !== "VISUAL_REPAIR",
          ),
          ...review.telemetry,
          this.#statusTelemetry(
            "VISUAL_REPAIR",
            review.telemetry[0]?.status === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : visualQA.visualRepairAttempts > 0
                ? "PASS"
                : "NOT_NEEDED",
            request.agentProvider,
            visualQA.visualRepairAttempts > 0,
          ),
        ];
        request.onIntelligence?.(intelligenceTelemetry);
      }
      const sourceArtifactRef = ArtifactNamespace.version(
        request.siteId,
        newVersionId,
        "SOURCE_ARCHIVE",
        "source.json",
      );
      const sourceManifestRef = ArtifactNamespace.version(
        request.siteId,
        newVersionId,
        "SOURCE_MANIFEST",
        "manifest.json",
      );
      const after = await this.#snapshots.capture(
        this.deps.execution,
        environment.id,
        sourceArtifactRef,
        this.#metadata(),
      );
      const changedFiles = summarizeChanges(before, after);
      const build = this.#build(environment.id);
      const buildArtifactRef = ArtifactNamespace.version(
        request.siteId,
        newVersionId,
        "PRODUCTION_BUILD",
        "build.json",
      );
      await this.deps.artifacts.put(buildArtifactRef, Buffer.from(JSON.stringify(build)), {
        kind: "PRODUCTION_BUILD",
        contentType: "application/json",
      });
      const versionDraft: UnnumberedSiteVersion = {
        id: newVersionId,
        siteId: request.siteId,
        parentVersionId: parent.id,
        sourceArtifactRef,
        sourceManifestRef,
        buildArtifactRef,
        buildStatus: "SUCCEEDED",
        ...(parent.siteSpec ? { siteSpec: parent.siteSpec } : {}),
        ...(parent.technicalProfileId ? { technicalProfileId: parent.technicalProfileId } : {}),
        ...(parent.templateId ? { templateId: parent.templateId } : {}),
        ...(parent.templateVersion !== undefined
          ? { templateVersion: parent.templateVersion }
          : {}),
        changeSummary: changedFiles.summary,
        ...(visualQA ? this.#versionVisualMetadata(visualQA) : {}),
        usageSummary: session.usage,
        ...(parent.runtimeSchemaVersion !== undefined
          ? { runtimeSchemaVersion: parent.runtimeSchemaVersion }
          : {}),
        createdAt: new Date(),
      };
      await this.#commitVersion(project, versionDraft, versionNumber);
      return {
        siteId: request.siteId,
        fromVersionId,
        newVersionId,
        build,
        preview: this.#preview(environment.id, previewResult.url, previewResult.port),
        changedFiles,
        usage: session.usage,
        ...(visualQA ? { visualQA } : {}),
        intelligence: intelligenceTelemetry,
        inference: runContext.getSummary(),
      };
    } catch (cause) {
      request.onIntelligence?.([
        this.#failureTelemetry("TARGETED_EDIT", request.agentProvider, cause),
        this.#statusTelemetry("TOOL_LOOP", "NOT_REACHED", request.agentProvider),
        this.#statusTelemetry("BUILD_REPAIR", "NOT_REACHED", request.agentProvider),
        this.#statusTelemetry(
          "VISUAL_REVIEW",
          request.agentProvider === "mock" ? "NOT_REACHED" : "UNSUPPORTED",
          request.agentProvider,
        ),
        this.#statusTelemetry(
          "VISUAL_REPAIR",
          request.agentProvider === "mock" ? "NOT_REACHED" : "UNSUPPORTED",
          request.agentProvider,
        ),
      ]);
      throw cause;
    } finally {
      await this.deps.execution.destroyEnvironment(environment.id);
    }
  }
  async restoreVersion(
    versionId: VersionId,
  ): Promise<{ environmentId: string; build: BuildResult }> {
    const version = await this.deps.versions.getById(versionId);
    if (!version) throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const environment = await this.deps.execution.createEnvironment({});
    try {
      await this.#snapshots.restore(this.deps.execution, environment.id, version.sourceArtifactRef);
      this.#packages.validate(await this.deps.execution.readFile(environment.id, "package.json"));
      const install = await this.deps.execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["ci"],
        timeoutMs: 180_000,
      });
      if (install.exitCode !== 0)
        throw new ApplicationError("PROJECT_BOOTSTRAP_FAILED", "Restore npm ci failed");
      const result = await this.deps.execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["run", "build"],
      });
      if (result.exitCode !== 0)
        throw new ApplicationError("BUILD_FAILED", "Restored version did not build");
      return { environmentId: environment.id, build: this.#build(environment.id) };
    } catch (cause) {
      await this.deps.execution.destroyEnvironment(environment.id);
      throw cause;
    }
  }
  async disposeRestoredEnvironment(environmentId: string): Promise<void> {
    await this.deps.execution.destroyEnvironment(environmentId);
  }
  #sessionTelemetry(
    taskKind: AgentTaskTelemetry["taskKind"],
    session: CliAgentSessionReport,
    status: AgentTaskTelemetry["status"],
  ): AgentTaskTelemetry {
    const usage = session.usage;
    return {
      taskKind,
      provider: session.provider,
      model: session.model,
      attempted: status !== "NOT_NEEDED",
      supported: true,
      success: status === "PASS" || status === "NOT_NEEDED",
      fallbackUsed: false,
      latencyMs: session.durationMs,
      turns: session.turns,
      toolCalls: session.toolCalls,
      ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
      status,
    };
  }
  #statusTelemetry(
    taskKind: AgentTaskTelemetry["taskKind"],
    status: AgentTaskTelemetry["status"],
    provider: string,
    attempted = false,
  ): AgentTaskTelemetry {
    return {
      taskKind,
      provider,
      model: "not-invoked",
      attempted,
      supported: status !== "UNSUPPORTED",
      success: status === "NOT_NEEDED" || status === "PASS",
      fallbackUsed: false,
      latencyMs: 0,
      turns: 0,
      toolCalls: 0,
      ...(status === "UNSUPPORTED" ? { errorCategory: "UNSUPPORTED_CAPABILITY" } : {}),
      status,
    };
  }
  #failureTelemetry(
    taskKind: AgentTaskTelemetry["taskKind"],
    provider: string,
    cause: unknown,
  ): AgentTaskTelemetry {
    const candidate = cause as { code?: string; metadata?: Readonly<Record<string, unknown>> };
    const status = candidate.metadata?.status;
    return {
      ...this.#statusTelemetry(taskKind, "FAILED", provider, true),
      errorCategory:
        status === 429 ||
        candidate.code === "RATE_LIMIT" ||
        candidate.code === "RATE_LIMIT_EXCEEDED"
          ? "RATE_LIMIT"
          : (candidate.code ?? "AGENT_FAILED"),
    };
  }
  async #runVisualQA(
    enabled: boolean | undefined,
    siteId: SiteId,
    versionKey: string,
    previewUrl: string,
    siteSpec: SiteSpec | undefined,
    environmentId: string,
    agentProvider: string,
    signal: AbortSignal | undefined,
    updatePreview: (preview: PreviewResult & { url: string }) => void,
    runContext?: InferenceRunContext,
  ): Promise<VisualQAReport | undefined> {
    if (!enabled) return undefined;
    if (!this.deps.visualQA)
      throw new ApplicationError("VALIDATION_FAILED", "Visual QA is not configured");
    const report = await this.deps.visualQA.run({
      siteId,
      versionKey,
      previewUrl,
      ...(siteSpec ? { siteSpec } : {}),
      repair: async (context) => {
        await this.deps.runtime.run(
          environmentId,
          {
            jobId: randomUUID(),
            siteId,
            operation: "EDIT_SITE",
            stage: "VISUAL_REPAIR",
            runtime: "LOCAL_CLI",
            agentProvider,
            userRequest: context,
            ...(siteSpec ? { siteSpec } : {}),
            limits: { maxAgentTurns: 8, maxToolCalls: 20, maxBuildRepairs: 1 },
            ...(runContext ? { runContext } : {}),
          },
          signal,
          runContext,
        );
        await this.#projectValidator.validate(this.deps.execution, environmentId);
        const next = this.deps.execution.getLatestPreview(environmentId);
        if (!next?.url)
          throw new ApplicationError("PREVIEW_FAILED", "Visual repair produced no preview");
        await this.#functional.validate(next.url);
        updatePreview(next as PreviewResult & { url: string });
        return next.url;
      },
    });
    if (!report.finalResult.passed && this.deps.visualQA.strict)
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Visual QA did not pass after ${report.visualRepairAttempts} repair attempt(s)`,
        {
          metadata: {
            score: report.finalResult.score,
            recommendation: report.finalResult.recommendation,
          },
        },
      );
    if (!report.finalResult.passed)
      console.warn(
        `[sites] site=${siteId} visual QA requires manual review score=${report.finalResult.score} repairs=${report.visualRepairAttempts}`,
      );
    return report;
  }
  #metadata() {
    const technicalProfile = this.deps.templates.resolveProfile(this.deps.template);
    return {
      technicalProfileId: technicalProfile.id,
      technicalProfileVersion: technicalProfile.version,
      templateId: this.deps.template.templateId,
      templateVersion: this.deps.template.templateVersion,
    };
  }
  #versionVisualMetadata(report: VisualQAReport) {
    const final = report.attempts.at(-1);
    return {
      visualQAStatus: report.finalResult.passed
        ? ("PASSED" as const)
        : report.finalResult.recommendation === "MANUAL_REVIEW"
          ? ("MANUAL_REVIEW" as const)
          : ("FAILED" as const),
      visualQAScore: report.finalResult.score,
      visualQAArtifactRef: report.artifactRef,
      finalScreenshotRefs: final?.screenshots.map((screenshot) => screenshot.artifactRef) ?? [],
    };
  }
  async #commitVersion(
    project: SiteProject,
    draft: UnnumberedSiteVersion,
    fallbackNumber: number,
  ): Promise<SiteVersion> {
    if (this.deps.versionCommitter) return this.deps.versionCommitter.commit(project, draft);
    const version: SiteVersion = { ...draft, versionNumber: fallbackNumber };
    await this.deps.versions.save(version);
    await this.deps.projects.save({
      ...project,
      latestVersionId: version.id,
      updatedAt: new Date(),
    });
    return version;
  }
  async #installDependencies(
    environmentId: string,
    jobId: string,
    source: "starter" | "restored",
  ): Promise<void> {
    console.info(`[sites] job=${jobId} installing ${source} dependencies (cache preferred)`);
    const install = await this.deps.execution.executeCommand(environmentId, {
      executable: "npm",
      args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
      timeoutMs: 300_000,
    });
    if (install.exitCode === 0 && !install.timedOut) {
      console.info(
        `[sites] job=${jobId} ${source} dependencies installed durationMs=${install.durationMs}`,
      );
      return;
    }
    const output = `${install.stderr}\n${install.stdout}`.trim().slice(-8_000);
    console.error(
      `[sites] job=${jobId} ${source} dependency installation failed exit=${install.exitCode ?? "null"} timedOut=${install.timedOut}\n${output}`,
    );
    throw new ApplicationError(
      "PROJECT_BOOTSTRAP_FAILED",
      install.timedOut
        ? `${source === "starter" ? "Starter" : "Restored"} dependency installation timed out`
        : `${source === "starter" ? "Starter" : "Restored"} dependency installation failed`,
      {
        metadata: {
          exitCode: install.exitCode,
          timedOut: install.timedOut,
          durationMs: install.durationMs,
        },
      },
    );
  }
  #build(environmentId: string): BuildResult {
    const result = this.deps.execution.getLastBuildResult(environmentId);
    if (!result) throw new ApplicationError("BUILD_FAILED", "No build result was recorded");
    return {
      success: result.exitCode === 0 && !result.timedOut,
      command: { executable: "npm", args: ["run", "build"] },
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.exitCode === 0 ? {} : { failureKind: "TYPESCRIPT_FAILURE" as const }),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    };
  }
  #preview(environmentId: string, url: string, port: number): PreviewSession {
    return {
      environmentId,
      url,
      port,
      status: "READY",
      previewMode: "PROVIDER_URL",
      createdAt: new Date(),
    };
  }
  #emit(job: SiteJob, state: WorkflowState, progress: number, message: string): void {
    this.deps.progress.publish({
      jobId: job.id,
      siteId: job.siteId,
      state,
      progress,
      message,
      timestamp: new Date(),
    });
  }
}
