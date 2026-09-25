import { randomUUID } from "node:crypto";
import type { GeneratedAppProfile } from "../../cli/runtime/site-technical-profile.js";
import type {
  CliAgentSessionReport,
  LocalCliAgentRuntime,
} from "../../cli/runtime/local-cli-agent-runtime.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import type { BuildResult, PreviewSession } from "../../execution/execution-types.js";
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
import type {
  SiteVersionCommitter,
  UnnumberedSiteVersion,
} from "../../persistence/version-committer.js";
import { ArtifactNamespace } from "../../persistence/artifact-namespace.js";
import type { SiteRuntimeProvider } from "../../site-runtime/site-runtime-provider.js";
import type { AgentPlanningPipeline } from "../../agents/intelligence/agent-intelligence.js";
import type { AgentTaskTelemetry } from "../../agents/intelligence/intelligence-types.js";
import {
  createInferenceRunContext,
  type InferenceRunSummary,
} from "../../agents/budget/inference-run-context.js";
import type { GenerationCompletionTelemetry } from "../../agents/validation/generation-completion.js";
import { createAssetManifest, isVisualReferenceAsset, type AssetManifest } from "../assets/asset-domain.js";
import { loadVisualReferences } from "../assets/visual-reference.js";
import type { AdapterBackedAssetResolver } from "../assets/source-adapters.js";
import type { MediaStore } from "../assets/media-store.js";
import { loadAssetManifest, persistAssetManifest } from "../assets/asset-manifest-persistence.js";
import { validateRequiredUserAssetReferences } from "../assets/asset-reference-validator.js";
import { resolveCapabilities, type ResolvedCapabilities } from "./capability-resolver.js";
import { analyzeRequestProfile, type RequestProfile } from "./request-profile.js";
import { logSiteTokenUsage } from "./site-token-usage-log.js";
import { createAssetIntent } from "../assets/asset-domain.js";
import type { BrowserQAReport } from "../../browser-qa/browser-qa-domain.js";
import { BrowserQARunner } from "../../browser-qa/browser-qa-runner.js";
import { browserQACoreCheckExecutors } from "../../browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../../browser-qa/browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "../../browser-qa/browser-qa-runtime-checks.js";
import { persistBrowserQAReport } from "../../browser-qa/browser-qa-persistence.js";
import type { VisualQAReport } from "../../visual-qa/visual-qa-types.js";
import type { VisualRepairAttempt, VisualReview } from "../../visual-review/visual-review-domain.js";
import { deriveSiteName, resolveGeneratedSiteName } from "./site-name.js";
export interface GenerateWebsiteRequest {
  readonly userId: UserId;
  readonly prompt: string;
  readonly projectName?: string;
  readonly planningMode: "deterministic" | "agent" | "agent-with-fallback";
  readonly onIntelligence?: (telemetry: readonly AgentTaskTelemetry[]) => void;
  readonly agentProvider: string;
  readonly technicalProfile?: string;
  readonly signal?: AbortSignal;
  readonly browserQAEnabled?: boolean;
  readonly assetManifest?: AssetManifest;
  readonly retainPreview?: boolean;
}
export interface EditWebsiteRequest {
  readonly userId: UserId;
  readonly siteId: SiteId;
  readonly versionId?: VersionId;
  readonly instruction: string;
  readonly onIntelligence?: (telemetry: readonly AgentTaskTelemetry[]) => void;
  readonly agentProvider: string;
  readonly signal?: AbortSignal;
  readonly browserQAEnabled?: boolean;
  readonly agentPlanningEnabled?: boolean;
  readonly retainPreview?: boolean;
  /** Newly accepted user assets for this edit. */
  readonly assetManifest?: AssetManifest;
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
  /** Historical compatibility data; never produced by the active pipeline. */
  readonly visualQA?: VisualQAReport;
  readonly browserQA?: BrowserQAReport;
  readonly visualReview?: VisualReview;
  readonly visualRepairAttempt?: VisualRepairAttempt;
  readonly intelligence?: readonly AgentTaskTelemetry[];
  readonly inference?: InferenceRunSummary;
  readonly completion?: GenerationCompletionTelemetry;
  readonly requestProfile?: RequestProfile;
}
export interface SiteEditResult {
  readonly siteId: SiteId;
  readonly jobId: JobId;
  readonly fromVersionId: VersionId;
  readonly newVersionId: VersionId;
  readonly build: BuildResult;
  readonly preview: PreviewSession;
  readonly changedFiles: SiteChangeSummary;
  readonly usage: CliAgentSessionReport["usage"];
  /** Historical compatibility data; never produced by the active pipeline. */
  readonly visualQA?: VisualQAReport;
  readonly browserQA?: BrowserQAReport;
  readonly visualReview?: VisualReview;
  readonly visualRepairAttempt?: VisualRepairAttempt;
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
  progress: SiteProgressPublisher;
  templates: StarterTemplateRegistry;
  template: StarterTemplate;
  browserQA?: BrowserQARunner;
  versionCommitter?: SiteVersionCommitter;
  runtimeProvider?: SiteRuntimeProvider;
  assetResolver?: AdapterBackedAssetResolver;
  assetMediaStore?: MediaStore;
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
    const requestProfile = analyzeRequestProfile(request.prompt);
    const hasVisualReference = request.assetManifest?.assets.some(isVisualReferenceAsset) ?? false;
    const siteId = randomUUID() as SiteId;
    const jobId = randomUUID() as JobId;
    const runContext = createInferenceRunContext({
      runId: jobId,
      limits: {
        // A reference generation reserves one corrective call for interaction
        // validation, in addition to optional planning and the primary bundle.
        maxLogicalRequests: (requestProfile.complexity === "COMPLEX" ? 3 : 2) + (hasVisualReference ? 1 : 0),
        maxPhysicalRequests: (requestProfile.complexity === "COMPLEX" ? 5 : 4) + (hasVisualReference ? 1 : 0),
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    let terminalError: unknown;
    const now = new Date();
    let job: SiteJob = {
      id: jobId,
      siteId,
      userId: request.userId,
      operation: "GENERATE",
      status: "QUEUED",
      stage: "QUEUED",
      provider: request.agentProvider,
      logicalCalls: 0,
      physicalRequests: 0,
      retries: 0,
      modelOutputReceived: false,
      websiteGenerated: false,
      createdAt: now,
      updatedAt: now,
    };
    let jobFinalized = false;
    try {
    await this.deps.jobs.save(job);
    this.#scope.validate(request.prompt);
    const technicalProfile = this.deps.templates.resolveProfile(this.deps.template);
    if (request.technicalProfile && request.technicalProfile !== technicalProfile.id)
      throw new ApplicationError(
        "UNSUPPORTED_SITE_REQUIREMENT",
        `Unsupported technical profile: ${request.technicalProfile}`,
      );
    const isAgentPlanning = requestProfile.needsAgentPlanning &&
      (request.planningMode === "agent" || request.planningMode === "agent-with-fallback") &&
      Boolean(this.deps.intelligencePlanning);
    const sitePlanResult = isAgentPlanning
      ? await this.deps.intelligencePlanning!.planSite(request.prompt, request.signal, runContext)
      : undefined;
    const project: SiteProject = {
      id: siteId,
      ownerId: request.userId,
      name: deriveSiteName(request.prompt, request.projectName),
      originalPrompt: request.prompt,
      slug: `site-${siteId.slice(0, 8)}`,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.projects.save(project);
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
      const requirementsPlanner = this.deps.requirements;
      const designPlanner = this.deps.design;
      if (!requirementsPlanner || !designPlanner)
        throw new ApplicationError("PLANNING_FAILED", "Agent planning is not configured");
      requirements = await requirementsPlanner.plan(request.prompt);
      this.#emit(job, "PLANNING", 10, "Requirements planned");
      design = await designPlanner.plan(requirements);
      this.#emit(job, "DESIGNING", 20, "Design planned");
      siteSpec = assembleSiteSpec(project.name, request.prompt, requirements, design);
    }

    let assetManifest = request.assetManifest;
    if (!assetManifest && this.deps.assetResolver) {
      const resolvedCapabilities = resolveCapabilities(siteSpec, {
        profile: technicalProfile,
        requestText: request.prompt,
      });
      const intents = deterministicAssetIntents(siteSpec, resolvedCapabilities, request.prompt);
      if (intents.length > 0) assetManifest = await this.deps.assetResolver.resolve(intents);
    }

    const siteRuntime =
      siteSpec.runtime?.enabled && this.deps.runtimeProvider
        ? await this.deps.runtimeProvider.provisionRuntime(siteId, siteSpec.runtime)
        : undefined;
    const environment = await this.deps.execution.createEnvironment({});
    // CODE_GENERATION is reported RUNNING before the provider call, so every
    // exit before its PASS report must replace it with a terminal status.
    let codeGenerationSession: CliAgentSessionReport | undefined;
    let codeGenerationReported = false;
    let retainEnvironment = false;
    this.#emit(job, "CREATING_ENVIRONMENT", 30, "Created disposable local workspace");
    try {
      await this.deps.templates.seed(this.deps.execution, environment.id, this.deps.template);
      if (assetManifest && this.deps.assetMediaStore)
        for (const asset of assetManifest.assets)
          if (!isVisualReferenceAsset(asset))
            await this.deps.assetMediaStore.materialize(this.deps.execution, environment.id, asset);
      this.#packages.validate(await this.deps.execution.readFile(environment.id, "package.json"));
      await this.#installDependencies(environment.id, jobId, "starter");
      this.#emit(job, "GENERATING", 45, "Agent generating website source");
      request.onIntelligence?.([
        this.#statusTelemetry("CODE_GENERATION", "RUNNING", request.agentProvider, true),
      ]);
      const session = await this.deps.runtime.run(
        environment.id,
        {
          jobId,
          siteId,
          operation: "GENERATE_SITE",
          runtime: "LOCAL_CLI",
          agentProvider: request.agentProvider,
          generationMode: "FAST_GENERATION" as const,
          userRequest: request.prompt,
          siteSpec,
          ...(assetManifest ? { assetManifest } : {}),
          referenceImages: await loadVisualReferences(assetManifest, this.deps.assetMediaStore),
          limits: {
            maxAgentTurns: 12,
            maxToolCalls: 40,
            maxBuildRepairs: 1,
            maxLogicalRequests: (requestProfile.complexity === "COMPLEX" ? 3 : 2) + (hasVisualReference ? 1 : 0),
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
      codeGenerationSession = session;
      await validateRequiredUserAssetReferences(this.deps.execution, environment.id, assetManifest);
      let intelligenceTelemetry = [
        ...(sitePlanResult ? sitePlanResult.telemetry : []),
        this.#sessionTelemetry("CODE_GENERATION", session, "PASS"),
        ...(session.buildRepairInvoked ? [this.#sessionTelemetry("BUILD_REPAIR", session, "PASS")] : []),
      ];
      request.onIntelligence?.(intelligenceTelemetry);
      codeGenerationReported = true;
      await this.#projectValidator.validate(this.deps.execution, environment.id);
      let previewResult = this.deps.execution.getLatestPreview(environment.id);
      if (!previewResult?.url)
        throw new ApplicationError("PREVIEW_FAILED", "Generation produced no ready preview");
      await this.#functional.validate(
        previewResult.url,
        request.agentProvider === "mock" ? "AI Sites Generated Hero" : undefined,
      );
      const versionId = randomUUID() as VersionId;
      let browserQARun = await this.#runBrowserQA(
        request.browserQAEnabled,
        siteId,
        versionId,
        previewResult.url,
        siteSpec,
        assetManifest,
      );
      // Browser QA is the sole default runtime QA system. Legacy screenshot
      // review/repair flags remain readable on old request objects but have no
      // executable production path.
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
      const assetManifestArtifactRef = assetManifest
        ? ArtifactNamespace.version(siteId, versionId, "GENERATED_ASSET", "manifest.json")
        : undefined;
      if (assetManifest && assetManifestArtifactRef)
        await persistAssetManifest(this.deps.artifacts, assetManifestArtifactRef, assetManifest);
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
      const resolvedName = resolveGeneratedSiteName({
        prompt: request.prompt,
        requestedProjectName: request.projectName,
        structuredSiteName: session.generatedSiteName,
        documentTitle: session.generatedDocumentTitle,
      });
      const resolvedProject: SiteProject = { ...project, name: resolvedName };
      siteSpec = { ...siteSpec, project: { ...siteSpec.project, name: resolvedName } };
      const versionDraft: UnnumberedSiteVersion = {
        id: versionId,
        siteId,
        sourceArtifactRef,
        sourceManifestRef,
        ...(assetManifestArtifactRef ? { assetManifestArtifactRef } : {}),
        buildArtifactRef,
        buildStatus: "SUCCEEDED",
        siteSpec,
        technicalProfileId: technicalProfile.id,
        templateId: this.deps.template.templateId,
        templateVersion: this.deps.template.templateVersion,
        changeSummary: changedFiles.summary,
        ...(browserQARun ? this.#versionBrowserQAMetadata(browserQARun.report, browserQARun.artifactRef) : {}),
        usageSummary: { ...session.usage, promptTelemetry: runContext.getSummary().promptExecutions },
        ...(siteRuntime ? { runtimeSchemaVersion: siteRuntime.schemaVersion } : {}),
        createdAt: new Date(),
      };
      const committedVersion = await this.#commitVersion(resolvedProject, versionDraft, 1);
      retainEnvironment = request.retainPreview === true;
      job = this.#finalJob(job, runContext.getSummary(), true);
      await this.deps.jobs.save(job);
      jobFinalized = true;
      this.#emit(job, "COMPLETED", 100, "Website Version 1 saved");
      return {
        siteId,
        jobId,
        versionId: committedVersion.id,
        siteSpec,
        technicalProfile,
        build,
        preview: this.#preview(environment.id, previewResult.url, previewResult.port),
        sourceArtifactRef: committedVersion.sourceArtifactRef,
        changedFiles,
        warnings: [],
        usage: session.usage,
        ...(browserQARun ? { browserQA: browserQARun.report } : {}),
        intelligence: intelligenceTelemetry,
        inference: runContext.getSummary(),
        requestProfile,
        ...(session.generationCompletion ? { completion: session.generationCompletion } : {}),
      };
    } catch (cause) {
      request.onIntelligence?.([
        ...(codeGenerationReported
          ? []
          : codeGenerationSession
            ? [this.#failedSessionTelemetry("CODE_GENERATION", codeGenerationSession, cause)]
            : [this.#failureTelemetry("CODE_GENERATION", request.agentProvider, cause)]),
      ]);
      throw cause;
    } finally {
      if (!retainEnvironment) await this.deps.execution.destroyEnvironment(environment.id);
    }
    } catch (cause) {
      terminalError = cause;
      if (!jobFinalized) {
        job = this.#finalJob(job, runContext.getSummary(), false, cause);
        await this.deps.jobs.save(job);
      }
      throw cause;
    } finally {
      logSiteTokenUsage("generate", request.agentProvider, runContext.getSummary(), terminalError);
    }
  }
  async edit(request: EditWebsiteRequest): Promise<SiteEditResult> {
    const editJobId = randomUUID() as JobId;
    const runContext = createInferenceRunContext({
      runId: editJobId,
      limits: {
        maxModelRequests: 2,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    let terminalError: unknown;
    const jobCreatedAt = new Date();
    let job: SiteJob = {
      id: editJobId,
      siteId: request.siteId,
      userId: request.userId,
      operation: "EDIT",
      status: "QUEUED",
      stage: "QUEUED",
      provider: request.agentProvider,
      logicalCalls: 0,
      physicalRequests: 0,
      retries: 0,
      modelOutputReceived: false,
      websiteGenerated: false,
      createdAt: jobCreatedAt,
      updatedAt: jobCreatedAt,
    };
    let jobFinalized = false;
    try {
    await this.deps.jobs.save(job);
    // Normal edits have one authoritative Targeted Edit request. Intent and
    // edit-planning agents are historical compatibility surfaces only.
    const project = await this.deps.projects.getById(request.siteId);
    if (!project || project.ownerId !== request.userId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site project was not found");
    const fromVersionId = request.versionId ?? project.latestVersionId;
    if (!fromVersionId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const parent = await this.deps.versions.getById(fromVersionId);
    if (!parent) throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const parentAssets = parent.assetManifestArtifactRef
      ? await loadAssetManifest(this.deps.artifacts, parent.assetManifestArtifactRef)
      : undefined;
    let assetManifest = mergeAssetManifests(parentAssets, request.assetManifest);
    if (!request.assetManifest && this.deps.assetResolver && parent.siteSpec) {
      const capabilities = resolveCapabilities(parent.siteSpec, { requestText: request.instruction });
      const intents = deterministicAssetIntents(parent.siteSpec, capabilities, request.instruction)
        .filter((intent) => !assetManifest?.assets.some((asset) => asset.logicalAssetId === intent.logicalAssetId));
      if (intents.length)
        assetManifest = mergeAssetManifests(assetManifest, await this.deps.assetResolver.resolve(intents));
    }
    const environment = await this.deps.execution.createEnvironment({});
    let retainEnvironment = false;
    try {
      const before = await this.#snapshots.restore(
        this.deps.execution,
        environment.id,
        parent.sourceArtifactRef,
      );
      if (assetManifest && this.deps.assetMediaStore)
        for (const asset of assetManifest.assets)
          if (!isVisualReferenceAsset(asset))
            await this.deps.assetMediaStore.materialize(this.deps.execution, environment.id, asset);
      this.#packages.validate(await this.deps.execution.readFile(environment.id, "package.json"));
      await this.#installDependencies(environment.id, String(request.siteId), "restored");
      request.onIntelligence?.([
        this.#statusTelemetry("TARGETED_EDIT", "RUNNING", request.agentProvider, true),
      ]);
      const session = await this.deps.runtime.run(
        environment.id,
        {
          jobId: editJobId,
          siteId: request.siteId,
          operation: "EDIT_SITE",
          runtime: "LOCAL_CLI",
          agentProvider: request.agentProvider,
          userRequest: request.instruction,
          ...(parent.siteSpec ? { siteSpec: parent.siteSpec } : {}),
          ...(assetManifest ? { assetManifest } : {}),
          referenceImages: await loadVisualReferences(request.assetManifest, this.deps.assetMediaStore),
          limits: { maxLogicalRequests: 2, maxBuildRepairs: 1 },
          runContext,
        },
        request.signal,
        runContext,
      );
      await validateRequiredUserAssetReferences(this.deps.execution, environment.id, request.assetManifest);
      let intelligenceTelemetry = [
        this.#sessionTelemetry("TARGETED_EDIT", session, "PASS"),
        ...(session.buildRepairInvoked ? [this.#sessionTelemetry("BUILD_REPAIR", session, "PASS")] : []),
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
      let browserQARun = await this.#runBrowserQA(
        request.browserQAEnabled,
        request.siteId,
        newVersionId,
        previewResult.url,
        parent.siteSpec,
        assetManifest,
      );
      // Browser QA is the sole default runtime QA system. Legacy visual
      // review/repair flags remain compatibility-readable but cannot execute.
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
      const assetManifestArtifactRef = assetManifest
        ? ArtifactNamespace.version(request.siteId, newVersionId, "GENERATED_ASSET", "manifest.json")
        : undefined;
      if (assetManifest && assetManifestArtifactRef)
        await persistAssetManifest(this.deps.artifacts, assetManifestArtifactRef, assetManifest);
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
        ...(assetManifestArtifactRef ? { assetManifestArtifactRef } : {}),
        buildArtifactRef,
        buildStatus: "SUCCEEDED",
        ...(parent.siteSpec ? { siteSpec: parent.siteSpec } : {}),
        ...(parent.technicalProfileId ? { technicalProfileId: parent.technicalProfileId } : {}),
        ...(parent.templateId ? { templateId: parent.templateId } : {}),
        ...(parent.templateVersion !== undefined
          ? { templateVersion: parent.templateVersion }
          : {}),
        changeSummary: changedFiles.summary,
        ...(browserQARun ? this.#versionBrowserQAMetadata(browserQARun.report, browserQARun.artifactRef) : {}),
        usageSummary: { ...session.usage, promptTelemetry: runContext.getSummary().promptExecutions },
        ...(parent.runtimeSchemaVersion !== undefined
          ? { runtimeSchemaVersion: parent.runtimeSchemaVersion }
          : {}),
        createdAt: new Date(),
      };
      const committedVersion = await this.#commitVersion(
        { ...project, lastEditPrompt: request.instruction },
        versionDraft,
        versionNumber,
      );
      job = this.#finalJob(job, runContext.getSummary(), true);
      await this.deps.jobs.save(job);
      jobFinalized = true;
      retainEnvironment = request.retainPreview === true;
      return {
        siteId: request.siteId,
        jobId: editJobId,
        fromVersionId,
        newVersionId: committedVersion.id,
        build,
        preview: this.#preview(environment.id, previewResult.url, previewResult.port),
        changedFiles,
        usage: session.usage,
        ...(browserQARun ? { browserQA: browserQARun.report } : {}),
        intelligence: intelligenceTelemetry,
        inference: runContext.getSummary(),
      };
    } catch (cause) {
      request.onIntelligence?.([
        this.#failureTelemetry("TARGETED_EDIT", request.agentProvider, cause),
      ]);
      throw cause;
    } finally {
      if (!retainEnvironment) await this.deps.execution.destroyEnvironment(environment.id);
    }
    } catch (cause) {
      terminalError = cause;
      if (!jobFinalized) {
        job = this.#finalJob(job, runContext.getSummary(), false, cause);
        await this.deps.jobs.save(job);
      }
      throw cause;
    } finally {
      logSiteTokenUsage("edit", request.agentProvider, runContext.getSummary(), terminalError);
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
  #failedSessionTelemetry(
    taskKind: AgentTaskTelemetry["taskKind"],
    session: CliAgentSessionReport,
    cause: unknown,
  ): AgentTaskTelemetry {
    return {
      ...this.#sessionTelemetry(taskKind, session, "FAILED"),
      errorCategory: (cause as { code?: string }).code ?? "AGENT_FAILED",
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
  async #runBrowserQA(
    enabled: boolean | undefined,
    siteId: SiteId,
    versionId: VersionId,
    previewUrl: string,
    siteSpec: SiteSpec | undefined,
    assetManifest?: AssetManifest,
  ): Promise<{ readonly report: BrowserQAReport; readonly artifactRef: string } | undefined> {
    if (!enabled) return undefined;
    if (!this.deps.browserQA)
      throw new ApplicationError("VALIDATION_FAILED", "Browser QA is not configured");
    const checks = [
      ...browserQACoreCheckExecutors,
      ...browserQAResponsiveAndInteractionChecks,
      ...browserQARuntimeChecks.filter(({ definition }) =>
        definition.checkId !== "broken-images" || (assetManifest?.assets.length ?? 0) > 0,
      ),
    ];
    const report = await this.deps.browserQA.run({
      runId: `${siteId}-${versionId}`,
      target: {
        baseUrl: previewUrl,
        projectId: siteId,
        siteVersionId: versionId,
      },
      routes: siteSpec?.requirements.pages.map(({ path }) => path) ?? ["/"],
      checks,
      artifactPrefix: `sites/${siteId}/versions/${versionId}/qa/screenshots/browser`,
    });
    const artifactRef = await persistBrowserQAReport(this.deps.artifacts, siteId, versionId, report);
    if (report.status === "FAIL") {
      // Name the blocking checks: "Browser QA failed" alone cannot be acted on.
      const blocking = report.checks.filter(
        (check) => check.status === "FAIL" && check.severity === "ERROR",
      );
      const detail = blocking
        .map((check) => `${check.checkId} [${check.route} ${check.viewport?.id ?? "PAGE"}]: ${check.message}`)
        .join("; ");
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Browser QA failed for generated site: ${detail}`,
        {
          metadata: {
            browserQAArtifactRef: artifactRef,
            failed: report.summary.failed,
            blockingChecks: blocking.map((check) => check.checkId),
            failureStage: "BROWSER_QA",
          },
        },
      );
    }
    return { report, artifactRef };
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
  #versionBrowserQAMetadata(report: BrowserQAReport, artifactRef: string) {
    return {
      browserQAStatus: report.status === "PASS"
        ? ("PASSED" as const)
        : ("PASSED_WITH_WARNINGS" as const),
      browserQAArtifactRef: artifactRef,
      browserQAScreenshotRefs: report.artifactRefs,
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
  #finalJob(
    job: SiteJob,
    summary: InferenceRunSummary,
    succeeded: boolean,
    cause?: unknown,
  ): SiteJob {
    const usage = summary.providerUsage;
    const error = cause instanceof ApplicationError ? cause : undefined;
    const model = summary.modelsUsed[summary.modelsUsed.length - 1];
    return {
      ...job,
      status: succeeded ? "SUCCEEDED" : error?.code === "JOB_CANCELLED" ? "CANCELLED" : "FAILED",
      stage: succeeded ? "COMPLETED" : "FAILED",
      ...(model ? { model } : {}),
      ...(usage
        ? {
            inputTokens: usage.inputTokens,
            ...(usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
            outputTokens: usage.outputTokens,
            ...(usage.reasoningTokens !== undefined
              ? { reasoningTokens: usage.reasoningTokens }
              : {}),
            totalTokens: usage.totalTokens,
          }
        : {}),
      logicalCalls: summary.logicalRequests,
      physicalRequests: summary.physicalRequests,
      retries: summary.retries,
      modelOutputReceived: usage !== undefined,
      websiteGenerated: succeeded,
      ...(!succeeded
        ? {
            errorCode: error?.code ?? "AGENT_FAILED",
            errorMessage:
              cause instanceof Error ? cause.message : "Sites operation failed without details",
            retryable: error?.retryable ?? false,
          }
        : {}),
      updatedAt: new Date(),
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

function mergeAssetManifests(previous?: AssetManifest, additions?: AssetManifest): AssetManifest | undefined {
  if (!previous && !additions) return undefined;
  const assets = [...(previous?.assets ?? []), ...(additions?.assets ?? [])];
  if (new Set(assets.map((asset) => asset.logicalAssetId)).size !== assets.length)
    throw new ApplicationError("ASSET_RESOLUTION_FAILED", "User asset identifiers conflict with existing assets");
  return createAssetManifest({ manifestVersion: 1, assets });
}

export function deterministicAssetIntents(
  siteSpec: SiteSpec,
  capabilities: ResolvedCapabilities,
  requestText = "",
) {
  if (!capabilities.capabilities.some(({ id }) => id === "images")) return [];
  const sourceText = [...siteSpec.requirements.features, requestText].join(" ").toLowerCase();
  const automotiveRequest = /\b(?:car|cars|auto|automotive|vehicle|vehicles|motor|motors|dealership|roadster|coupe|suv)\b/.test(sourceText);
  const describe = (value: string): string => automotiveRequest ? `${value} for an automotive website` : value;
  const page = siteSpec.requirements.pages[0];
  type ImageRole = "HERO" | "BACKGROUND" | "CONTENT" | "LOGO" | "GALLERY" | "PRODUCT" | "TEAM" | "TESTIMONIAL";
  const roles: Array<{ role: ImageRole; key: string; description: string }> = [];
  const addRole = (role: ImageRole, key: string, description: string): void => {
    if (!roles.some((candidate) => candidate.key === key)) roles.push({ role, key, description });
  };

  if (/\bbackground\s+(?:image|photo|visual)\b/.test(sourceText))
    addRole("BACKGROUND", "background", describe("A background image requested for the site"));
  if (/\b(?:hero|banner|cover)\s+(?:image|photo|visual)?\b|\b(?:hero|banner|cover)\b/.test(sourceText))
    addRole("HERO", "hero", describe("A welcoming hero image for the primary page"));
  if (/\b(?:gallery|galleries|photos|photography|portfolio)\b/.test(sourceText))
    addRole("GALLERY", "gallery", describe("A curated gallery image"));
  if (/\b(?:product|catalog|shop)\s*(?:image|photo|imagery|photos?)?\b/.test(sourceText))
    addRole("PRODUCT", "product", describe("Product imagery"));
  if (/\b(?:team|staff|dentist|doctor)\s*(?:image|photo|portrait|photos?)?\b/.test(sourceText))
    addRole("TEAM", "team", describe("A team member portrait"));
  if (/\b(?:testimonial|review)\s*(?:image|photo|visual|photos?)?\b/.test(sourceText))
    addRole("TESTIMONIAL", "testimonial", describe("A testimonial supporting image"));
  if (/\b(?:logo|logos|brand\s+mark)\b/.test(sourceText))
    addRole("LOGO", "logo", describe("A logo or brand mark for the site"));

  const genericImageEvidence = sourceText.replace(
    /\b(?:background|hero|banner|cover|gallery|galleries|product|catalog|shop|team|staff|dentist|doctor|testimonial|review|logo|logos|brand\s+mark)(?:\s+(?:image|photo|visual|photos?|imagery|portrait))?\b/g,
    " ",
  );
  if (
    /\b(?:image|images|photo|photos|photograph|photographs|picture|pictures|illustration|illustrations|imagery)\b/.test(
      genericImageEvidence,
    )
  )
    addRole("CONTENT", "content", describe("A content image requested for the site"));

  const requestedCount = /\b(?:four|4)\b[^.]{0,60}\b(?:image|images|photo|photos|portraits?)\b/.test(sourceText) ? 4 : 1;
  return roles.flatMap(({ role, key, description }) => Array.from(
    { length: ["TEAM", "GALLERY", "PRODUCT", "CONTENT"].includes(role) ? requestedCount : 1 },
    (_, index) => ({ role, key: requestedCount > 1 ? `${key}-${index + 1}` : key, description }),
  )).map(({ role, key, description }) => createAssetIntent({
    intentId: `${key}-image`,
    logicalAssetId: `${key}-image`,
    mediaType: "IMAGE",
    role,
    ...(page ? { pageId: page.path.replace(/^\//, "") || "home" } : {}),
    purpose: description,
    description,
    required: false,
    decorative: role === "GALLERY" || role === "PRODUCT" || role === "TEAM" || role === "TESTIMONIAL",
    altTextIntent: description,
  }));
}
