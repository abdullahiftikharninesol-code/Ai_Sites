import { randomUUID } from "node:crypto";
import type { GeneratedAppProfile } from "../../cli/runtime/site-technical-profile.js";
import type {
  CliAgentSessionReport,
  LocalCliAgentRuntime,
} from "../../cli/runtime/local-cli-agent-runtime.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import { assessEditOutcome } from "../../cli/runtime/edit-outcome.js";
import { summarizeInstallFailure } from "../../cli/runtime/build-log-normalizer.js";
import { isEditableRequirementPath, parseEditRequirements, readEditRequirementFiles } from "../../cli/runtime/edit-requirements.js";
import { functionalSourceManifest } from "./functional-source-contract.js";
import { analyzeEditImpact, applyOptionalRequirementPolicy, checksForPlan, evaluateQAVerification, requestedEditRequirements, requirementChecks, selectEditQAPlan, selectGenerationQAPlan, type BrowserQAPlan, type QAVerification } from "./adaptive-qa-policy.js";
import { assertFunctionalRequestConsistency, assertFunctionalBackendSupport, functionalRequirements } from "./functional-capabilities.js";
import { validateEditScopeCompletion } from "../../cli/runtime/edit-scope.js";
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
  SiteVersionCommitOptions,
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
import { generationAssetAdvisories } from "./generation-acceptance-policy.js";
import { logSiteTokenUsage, siteFailureStage } from "./site-token-usage-log.js";
import type { FailedCandidateEvidence, FailedCandidateEvidenceRequest } from "./failed-candidate-evidence.js";
import { recordGenerationTelemetry, referenceContextTelemetry, type GenerationDevelopmentTelemetry } from "./generation-development-telemetry.js";
import { createAssetIntent } from "../assets/asset-domain.js";
import type { BrowserQAReport } from "../../browser-qa/browser-qa-domain.js";
import { withFunctionalContract, functionalRouteGuidance } from "./functional-route-contract.js";
import type { ResolvedFunctionalContract } from "./functional-route-contract.js";
import { applyFunctionalSourceContract } from "./functional-source-contract.js";
import type { BrowserQARunner, BrowserQACheckExecutor } from "../../browser-qa/browser-qa-runner.js";
import { browserQACoreCheckExecutors } from "../../browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../../browser-qa/browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "../../browser-qa/browser-qa-runtime-checks.js";
import { applyUsableGenerationReportPolicy, usableGenerationChecks } from "../../browser-qa/usable-generation-checks.js";
import { persistBrowserQAReport } from "../../browser-qa/browser-qa-persistence.js";
import type { VisualQAReport } from "../../visual-qa/visual-qa-types.js";
import type { VisualRepairAttempt, VisualReview } from "../../visual-review/visual-review-domain.js";
import { deriveSiteName, resolveGeneratedSiteName } from "./site-name.js";
import { templateDesignPrompt, type TemplateDesignReferenceResolver, type TemplateReferenceSelection } from "../../templates/application/template-design-context.js";
import { templateReferenceSiteSpec, templateReferenceBrowserCheck, requestedTemplateReferenceIdentity } from "../../templates/application/template-reference-generation-contract.js";
import type {
  BillingAuthorization,
  SiteCreditBillingService,
} from "../../billing/credit-billing.js";
export interface GenerateWebsiteRequest {
  readonly outerRequestId?: string;
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
  readonly templateReference?: TemplateReferenceSelection;
  /** Server-owned candidate identity for safe retry of the same reference generation. */
  readonly referenceGenerationSiteId?: SiteId;
}
export interface EditWebsiteRequest {
  readonly outerRequestId?: string;
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
  /** Adaptive QA outcome and what it actually covered. */
  readonly qaVerification?: QAVerification;
}
export interface SiteEditResult {
  readonly editOutcome?: "APPLIED" | "NO_CHANGES_REQUIRED";
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
  /** Adaptive QA outcome and what it actually covered. */
  readonly qaVerification?: QAVerification;
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
  billing?: SiteCreditBillingService;
  templateDesignReferences?: TemplateDesignReferenceResolver;
  failedCandidateEvidence?: FailedCandidateEvidence;
  developmentTelemetry?: GenerationDevelopmentTelemetry;
  resolveAgentModel(provider: string): string | undefined;
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
    assertFunctionalRequestConsistency(requestProfile.functional);
    // Known unavailable transactions cannot be enabled by planning. Reject
    // before planner calls, runtime provisioning, or draft project creation.
    if (requestProfile.functional.unsupportedTransactions) assertFunctionalBackendSupport(requestProfile.functional);
    const hasVisualReference = request.assetManifest?.assets.some(isVisualReferenceAsset) ?? false;
    const siteId = request.templateReference && request.referenceGenerationSiteId ? request.referenceGenerationSiteId : randomUUID() as SiteId;
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
      billingStatus: "NOT_CHARGED",
      creditsCharged: 0,
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
    if (request.templateReference && !this.deps.templateDesignReferences)
      throw new ApplicationError("PROVIDER_CONFIGURATION_ERROR", "Template design references are not configured");
    const templateReference = request.templateReference
      ? await this.deps.templateDesignReferences!.resolve(request.templateReference) : undefined;
    recordGenerationTelemetry(this.deps.developmentTelemetry, { jobId, role: "generation", model: this.deps.resolveAgentModel(request.agentProvider),
      ...referenceContextTelemetry(request.templateReference, templateReference ? templateDesignPrompt(templateReference.design) : undefined) });
    if (templateReference && request.referenceGenerationSiteId) {
      const previous = await this.deps.projects.getById(siteId);
      if (previous && (previous.ownerId !== request.userId || previous.latestVersionId))
        throw new ApplicationError("VALIDATION_FAILED", "This reference generation candidate cannot be replaced");
    }
    const billingAuthorization = await this.#authorizeBilling(
      request.userId,
      request.agentProvider,
    );
    const technicalProfile = this.deps.templates.resolveProfile(this.deps.template);
    if (request.technicalProfile && request.technicalProfile !== technicalProfile.id)
      throw new ApplicationError(
        "UNSUPPORTED_SITE_REQUIREMENT",
        `Unsupported technical profile: ${request.technicalProfile}`,
      );
    const isAgentPlanning = requestProfile.needsAgentPlanning &&
      (request.planningMode === "agent" || request.planningMode === "agent-with-fallback") &&
      Boolean(this.deps.intelligencePlanning);
    if (isAgentPlanning) recordGenerationTelemetry(this.deps.developmentTelemetry, { jobId, role: "sites.site-planner", model: this.deps.resolveAgentModel(request.agentProvider),
      ...referenceContextTelemetry(request.templateReference, templateReference ? templateDesignPrompt(templateReference.design) : undefined) });
    const sitePlanResult = isAgentPlanning
      ? await this.deps.intelligencePlanning!.planSite([request.prompt, functionalRouteGuidance(requestProfile.functional)].filter(Boolean).join("\n\n"), request.signal, runContext, templateReference ? templateDesignPrompt(templateReference.design) : undefined)
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
    // Reference generation has no completed template baseline. Keep failed
    // candidates out of the project gallery until all generation gates pass.
    if (!templateReference) await this.deps.projects.save(project);
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

    if (templateReference) siteSpec = templateReferenceSiteSpec(siteSpec, request.prompt);
    siteSpec = withFunctionalContract(siteSpec, requestProfile.functional);
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
      const versionId = randomUUID() as VersionId;
      let behaviorValidatedInRuntime = false;
      let behaviorAttempt = 0;
      let validatedBrowserQARun: { readonly report: BrowserQAReport; readonly artifactRef: string } | undefined;
      let generationQAPlan: BrowserQAPlan | undefined;
      let previousQAFailure: { readonly route?: string | undefined; readonly viewport?: string | undefined }[] | undefined;
      const session = await this.deps.runtime.run(
        environment.id,
        {
          jobId,
          siteId,
          operation: "GENERATE_SITE",
          runtime: "LOCAL_CLI",
          agentProvider: request.agentProvider,
          generationMode: "FAST_GENERATION" as const,
          ...(request.outerRequestId ? { outerRequestId: request.outerRequestId } : {}),
          userRequest: request.prompt,
          siteSpec,
          ...(templateReference ? { templateDesignReference: templateReference } : {}),
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
        undefined,
        async candidate => {
          behaviorAttempt += 1;
          const assetAdvisories = await generationAssetAdvisories(this.deps.execution, environment.id, assetManifest);
          await this.#projectValidator.validate(this.deps.execution, environment.id);
          await this.#functional.validate(candidate.previewUrl, request.agentProvider === "mock" ? "AI Sites Generated Hero" : undefined);
          const candidateContract = candidate.functionalContract ? { ...candidate.functionalContract, advisories: [...(candidate.functionalContract.advisories ?? []), ...assetAdvisories] } : undefined;
          const candidateSpec = candidateContract ? applyFunctionalSourceContract(siteSpec, candidateContract) : siteSpec;
          // After a functional repair, rerun every mandatory check but revisit mobile
          // only where the previous attempt failed (plus the entry route).
          const qaPlan = selectGenerationQAPlan(candidateSpec.requirements.pages.map(page => page.path), candidateContract,
            behaviorAttempt > 1 && previousQAFailure ? { failed: previousQAFailure } : undefined);
          generationQAPlan = qaPlan;
          try {
          validatedBrowserQARun = await this.#runBrowserQA(
            true,
            siteId, versionId, candidate.previewUrl, candidateSpec, assetManifest,
            [...(templateReference ? [templateReferenceBrowserCheck(templateReference, request.prompt)] : []),
              ...requirementChecks(qaPlan, candidateSpec.requirements.functional ?? requestProfile.functional, Boolean(candidateSpec.runtime?.enabled), candidateContract)],
            { execution: this.deps.execution, environmentId: environment.id, jobId, siteId, generationAttempt: behaviorAttempt > 1 ? 2 : 1,
              ...(request.outerRequestId ? { outerRequestId: request.outerRequestId } : {}),
              ...(candidate.completion ? { completion: candidate.completion } : {}), functionalRequirements: candidateSpec.requirements.functional ?? requestProfile.functional,
              ...(candidate.buildRepair ? { buildRepair: candidate.buildRepair } : {}),
              ...(candidateContract ? { functionalContract: candidateContract } : {}),
              accounting: { model: candidate.model, role: "sites.site-coder", logicalRequests: runContext.getSummary().logicalRequests,
                physicalRequests: runContext.getSummary().physicalRequests, billingStatus: "NOT_FINALIZED" },
              referenceContext: referenceContextTelemetry(request.templateReference, templateReference ? templateDesignPrompt(templateReference.design) : undefined) },
            "USABLE_GENERATION",
            qaPlan,
          );
          } catch (cause) {
            const findings = cause instanceof ApplicationError ? cause.metadata?.blockingFindings : undefined;
            if (Array.isArray(findings)) previousQAFailure = findings.map(item => ({ route: (item as { route?: string }).route, viewport: (item as { viewport?: string }).viewport }));
            throw cause;
          }
          behaviorValidatedInRuntime = true;
        },
      );
      codeGenerationSession = session;
      await generationAssetAdvisories(this.deps.execution, environment.id, assetManifest);
      const intelligenceTelemetry = [
        ...(sitePlanResult ? sitePlanResult.telemetry : []),
        this.#sessionTelemetry("CODE_GENERATION", session, "PASS"),
        ...(session.buildRepairInvoked ? [this.#sessionTelemetry("BUILD_REPAIR", session, "PASS")] : []),
      ];
      request.onIntelligence?.(intelligenceTelemetry);
      codeGenerationReported = true;
      await this.#projectValidator.validate(this.deps.execution, environment.id);
      const previewResult = this.deps.execution.getLatestPreview(environment.id);
      if (!previewResult?.url)
        throw new ApplicationError("PREVIEW_FAILED", "Generation produced no ready preview");
      // The runtime behavior callback already fetched this same preview.
      if (!behaviorValidatedInRuntime) await this.#functional.validate(
        previewResult.url,
        request.agentProvider === "mock" ? "AI Sites Generated Hero" : undefined,
      );
      if (session.functionalContract) siteSpec = applyFunctionalSourceContract(siteSpec, session.functionalContract);
      if (!behaviorValidatedInRuntime) generationQAPlan = selectGenerationQAPlan(siteSpec.requirements.pages.map(page => page.path), session.functionalContract);
      const browserQARun = behaviorValidatedInRuntime ? validatedBrowserQARun : await this.#runBrowserQA(
        true,
        siteId,
        versionId,
        previewResult.url,
        siteSpec,
        assetManifest,
        [...(templateReference ? [templateReferenceBrowserCheck(templateReference, request.prompt)] : []),
          ...requirementChecks(generationQAPlan!, siteSpec.requirements.functional ?? requestProfile.functional, Boolean(siteSpec.runtime?.enabled), session.functionalContract)],
        { execution: this.deps.execution, environmentId: environment.id, jobId, siteId, completion: session.generationCompletion,
          ...(request.outerRequestId ? { outerRequestId: request.outerRequestId } : {}),
          functionalRequirements: siteSpec.requirements.functional ?? requestProfile.functional,
          ...(session.functionalContract ? { functionalContract: session.functionalContract } : {}),
          accounting: { model: session.model, role: "sites.site-coder", logicalRequests: runContext.getSummary().logicalRequests,
            physicalRequests: runContext.getSummary().physicalRequests, billingStatus: "NOT_FINALIZED" },
          referenceContext: referenceContextTelemetry(request.templateReference, templateReference ? templateDesignPrompt(templateReference.design) : undefined) },
        "USABLE_GENERATION",
        generationQAPlan,
      );
      const qaVerification = generationQAPlan ? evaluateQAVerification(generationQAPlan, browserQARun?.report) : undefined;
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
        { ...this.#metadata(), ...(templateReference ? { templateId: templateReference.design.templateKey, templateVersion: templateReference.design.version } : {}) },
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
        requestedProjectName: request.projectName ?? (templateReference ? requestedTemplateReferenceIdentity(request.prompt) : undefined),
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
        templateId: templateReference?.design.templateKey ?? this.deps.template.templateId,
        templateVersion: templateReference?.design.version ?? this.deps.template.templateVersion,
        changeSummary: changedFiles.summary,
        ...(browserQARun ? this.#versionBrowserQAMetadata(browserQARun.report, browserQARun.artifactRef) : {}),
        usageSummary: { ...session.usage, promptTelemetry: runContext.getSummary().promptExecutions },
        ...(siteRuntime ? { runtimeSchemaVersion: siteRuntime.schemaVersion } : {}),
        createdAt: new Date(),
      };
      if (templateReference) await this.deps.projects.save(resolvedProject);
      const committedVersion = await this.#commitVersion(resolvedProject, versionDraft, 1);
      retainEnvironment = request.retainPreview === true;
      job = this.#finalJob(job, runContext.getSummary(), true);
      await this.deps.jobs.save(job);
      jobFinalized = true;
      if (billingAuthorization && this.deps.billing)
        job = await this.deps.billing.finalizeSuccessfulJob(
          job,
          runContext.getSummary(),
          billingAuthorization,
        );
      this.#emit(job, "COMPLETED", 100, "Website Version 1 saved");
      recordGenerationTelemetry(this.deps.developmentTelemetry, { jobId, role: "generation", outcome: "SUCCEEDED",
        model: session.model, logicalRequests: runContext.getSummary().logicalRequests, physicalRequests: runContext.getSummary().physicalRequests,
        routeCount: session.functionalContract?.actualRoutes.length, requirementCount: session.functionalContract?.requirements.length,
        billingStatus: job.billingStatus, creditsCharged: job.creditsCharged ?? 0 });
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
        ...(qaVerification ? { qaVerification } : {}),
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
      recordGenerationTelemetry(this.deps.developmentTelemetry, { jobId, role: "generation", outcome: "FAILED",
        failureStage: cause instanceof ApplicationError && typeof cause.metadata?.failureStage === "string" ? cause.metadata.failureStage : siteFailureStage(cause),
        validationCategory: cause instanceof ApplicationError && typeof cause.metadata?.validationCheck === "string" ? cause.metadata.validationCheck : undefined,
        logicalRequests: runContext.getSummary().logicalRequests, physicalRequests: runContext.getSummary().physicalRequests,
        billingStatus: job.billingStatus, creditsCharged: job.creditsCharged ?? 0 });
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
      billingStatus: "NOT_CHARGED",
      creditsCharged: 0,
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
    // Normal edits have one authoritative Targeted Edit request. A single
    // second invocation of that same role is permitted only for deterministic
    // mandatory-requirement repair; intent/planning agents stay retired.
    const project = await this.deps.projects.getById(request.siteId);
    if (!project || project.ownerId !== request.userId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site project was not found");
    const fromVersionId = request.versionId ?? project.latestVersionId;
    if (!fromVersionId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const parent = await this.deps.versions.getById(fromVersionId);
    if (!parent) throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    const billingAuthorization = await this.#authorizeBilling(
      request.userId,
      request.agentProvider,
    );
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
          ...(request.outerRequestId ? { outerRequestId: request.outerRequestId } : {}),
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
        async () => {
          await this.#authorizeBilling(request.userId, request.agentProvider);
        },
      );
      await validateRequiredUserAssetReferences(this.deps.execution, environment.id, request.assetManifest);
      const editedSource = await readEditRequirementFiles(this.deps.execution, environment.id);
      const parentSource = new Map(Object.entries(before.files).filter(([path]) => isEditableRequirementPath(path)));
      const editAssessment = assessEditOutcome(request.instruction, parentSource, editedSource);
      const editOutcome = editAssessment.outcome;
      const discoveredRoutes = functionalSourceManifest({ files: [...editedSource].map(([path, content]) => ({ path, content })) }).routes
        .map(route => route.path).filter(path => !/[:*]/.test(path));
      const editedSpec = parent.siteSpec ? { ...parent.siteSpec, requirements: { ...parent.siteSpec.requirements,
        pages: [...parent.siteSpec.requirements.pages, ...discoveredRoutes.filter(path => !parent.siteSpec!.requirements.pages.some(page => page.path === path))
          .map(path => ({ path, name: path === "/" ? "Home" : path.slice(1) }))] } } : undefined;
      const intelligenceTelemetry = [
        this.#sessionTelemetry("TARGETED_EDIT", session, "PASS"),
        ...(session.buildRepairInvoked ? [this.#sessionTelemetry("BUILD_REPAIR", session, "PASS")] : []),
      ];
      request.onIntelligence?.(intelligenceTelemetry);
      await this.#projectValidator.validate(this.deps.execution, environment.id);
      const previewResult = this.deps.execution.getLatestPreview(environment.id);
      if (!previewResult?.url)
        throw new ApplicationError("PREVIEW_FAILED", "Edit produced no ready preview");
      await this.#functional.validate(
        previewResult.url,
        request.agentProvider === "mock" ? "AI Sites Updated Hero" : undefined,
      );
      if (editOutcome === "NO_CHANGES_REQUIRED") {
        // A verified review/already-satisfied request must not create another
        // current-source revision or finalize a successful-edit charge. The
        // source equals the already-validated parent version, so Browser QA is
        // skipped and no QA artifacts are written for a version that never exists.
        job = { ...this.#finalJob(job, runContext.getSummary(), true), stage: "NO_CHANGES_REQUIRED", websiteGenerated: false,
          billingStatus: "NOT_CHARGED", creditsCharged: 0 };
        await this.deps.jobs.save(job); jobFinalized = true;
        retainEnvironment = request.retainPreview === true;
        return { siteId: request.siteId, jobId: editJobId, fromVersionId, newVersionId: fromVersionId,
          editOutcome, build: this.#build(environment.id), preview: this.#preview(environment.id, previewResult.url, previewResult.port),
          changedFiles: { filesCreated: [], filesModified: [], filesDeleted: [], summary: [] }, usage: session.usage,
          intelligence: intelligenceTelemetry, inference: runContext.getSummary() };
      }
      const versionNumber = parent.versionNumber + 1;
      const newVersionId = randomUUID() as VersionId;
      // Adaptive QA: explicitly requested behavior must exist in source before any
      // browser time is spent; browser scope follows the proven change scope.
      const qaRoutes = [...new Set(editedSpec?.requirements.pages.map(page => page.path) ?? discoveredRoutes)];
      const editScope = parseEditRequirements(request.instruction).scope;
      const qaPlan = selectEditQAPlan({
        impact: analyzeEditImpact(parentSource, editedSource, editAssessment.changedPaths, qaRoutes),
        ...(editScope ? { scope: editScope } : {}),
        requirements: requestedEditRequirements(request.instruction, editedSource),
        routes: qaRoutes,
      });
      // Source-only acceptance re-proves the requested copy on the final source.
      if (qaPlan.mode === "SOURCE_BUILD_ONLY" && editScope) validateEditScopeCompletion(editScope, parentSource, editedSource);
      const browserQARun = qaPlan.mode === "SOURCE_BUILD_ONLY" ? undefined : await this.#runBrowserQA(
        request.browserQAEnabled,
        request.siteId,
        newVersionId,
        previewResult.url,
        editedSpec,
        assetManifest,
        requirementChecks(qaPlan, editedSpec?.requirements.functional ?? functionalRequirements(request.instruction), Boolean(editedSpec?.runtime?.enabled)),
        undefined,
        "STRICT",
        qaPlan,
      );
      const qaVerification = evaluateQAVerification(qaPlan, browserQARun?.report, { browserQAEnabled: request.browserQAEnabled === true });
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
        {
          ...this.#metadata(),
          ...(parent.templateId ? { templateId: parent.templateId } : {}),
          ...(parent.templateVersion !== undefined ? { templateVersion: parent.templateVersion } : {}),
        },
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
        ...(editedSpec ? { siteSpec: editedSpec } : {}),
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
      if (billingAuthorization && this.deps.billing)
        job = await this.deps.billing.finalizeSuccessfulJob(
          job,
          runContext.getSummary(),
          billingAuthorization,
        );
      retainEnvironment = request.retainPreview === true;
      return {
        siteId: request.siteId,
        jobId: editJobId,
        fromVersionId,
        editOutcome,
        newVersionId: committedVersion.id,
        build,
        preview: this.#preview(environment.id, previewResult.url, previewResult.port),
        changedFiles,
        usage: session.usage,
        ...(browserQARun ? { browserQA: browserQARun.report } : {}),
        qaVerification,
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
      if (terminalError instanceof ApplicationError &&
        (terminalError.code.startsWith("STRUCTURED_RESPONSE_") || terminalError.code === "MODEL_OUTPUT_TRUNCATED")) {
        const metadata = terminalError.metadata;
        const text = (key: string) => typeof metadata?.[key] === "string" ? metadata[key] : undefined;
        recordGenerationTelemetry(this.deps.developmentTelemetry, {
          jobId: editJobId, role: "sites.targeted-edit", provider: request.agentProvider,
          model: this.deps.resolveAgentModel(request.agentProvider), failureStage: siteFailureStage(terminalError),
          responseSchema: text("responseSchema"), responseSchemaVersion: text("responseSchemaVersion"),
          validationCategory: text("validationCategory") ?? terminalError.code, validationPath: text("validationPath"),
          finishReason: text("finishReason"), truncated: metadata?.truncated === true,
          inputTokens: runContext.getSummary().providerUsage?.inputTokens,
          outputTokens: runContext.getSummary().providerUsage?.outputTokens,
          billingStatus: job.billingStatus, creditsCharged: job.creditsCharged ?? 0,
        });
      }
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
  /**
   * One-step rollback: the previous verified version becomes current again as a
   * NEW version number (history stays monotonic, the replaced version stays
   * recoverable). No AI call, build or charge: the previous snapshot is verified
   * byte-for-byte and its existing artifacts are reused, never copied. The
   * expected current version guards against silently overwriting a concurrent
   * edit or rollback; the persistence commit re-checks it atomically.
   */
  async rollbackToPreviousVersion(request: { readonly siteId: SiteId; readonly ownerId: string; readonly expectedVersionId: VersionId }): Promise<{ readonly version: SiteVersion; readonly restoredFromVersionId: VersionId }> {
    const log = (result: string, extra = "") => console.info(`[sites] rollback site=${request.siteId} expected=${request.expectedVersionId} result=${result}${extra}`);
    const project = await this.deps.projects.getById(request.siteId);
    if (!project || project.ownerId !== request.ownerId) throw new ApplicationError("SITE_NOT_FOUND", "Site project was not found");
    const conflict = () => new ApplicationError("VERSION_CONFLICT", "The website changed since this rollback was requested. Reload and try again.", {
      metadata: { reason: "CURRENT_VERSION_CHANGED" } });
    if (project.latestVersionId !== request.expectedVersionId) { log("CONFLICT"); throw conflict(); }
    const current = await this.deps.versions.getById(request.expectedVersionId);
    const previous = current?.parentVersionId ? await this.deps.versions.getById(current.parentVersionId) : undefined;
    if (!current || !previous || previous.siteId !== project.id) {
      log("UNAVAILABLE");
      throw new ApplicationError("ROLLBACK_UNAVAILABLE", "No previous saved version is available to restore.");
    }
    try {
      await this.#snapshots.verify(previous.sourceArtifactRef);
      if (previous.assetManifestArtifactRef && !(await this.deps.artifacts.exists(previous.assetManifestArtifactRef)))
        throw new ApplicationError("ARTIFACT_NOT_FOUND", "Previous asset manifest is missing");
    } catch (cause) {
      const code = cause instanceof ApplicationError ? cause.code : "UNKNOWN";
      log("SOURCE_UNAVAILABLE", ` cause=${code}`);
      throw new ApplicationError("ROLLBACK_SOURCE_UNAVAILABLE", "The previous version's saved source is missing or failed integrity verification. The current version is unchanged.", {
        metadata: { reason: code === "ARTIFACT_NOT_FOUND" ? "MISSING_SNAPSHOT" : "INTEGRITY_FAILED" } });
    }
    // Reuse the previous version's verified artifacts and metadata (no copies).
    const carried = (["sourceManifestRef", "assetManifestArtifactRef", "buildArtifactRef", "siteSpec", "technicalProfileId", "templateId", "templateVersion",
      "browserQAStatus", "browserQAArtifactRef", "browserQAScreenshotRefs", "runtimeSchemaVersion"] as const)
      .filter(key => previous[key] !== undefined).map(key => [key, previous[key]] as const);
    const draft: UnnumberedSiteVersion = {
      ...(Object.fromEntries(carried) as Partial<UnnumberedSiteVersion>),
      sourceArtifactRef: previous.sourceArtifactRef,
      id: randomUUID() as VersionId,
      siteId: project.id,
      parentVersionId: current.id,
      buildStatus: "SUCCEEDED",
      changeSummary: [`Restored version ${previous.versionNumber}`],
      createdAt: new Date(),
    };
    let version: SiteVersion;
    try {
      version = await this.#commitVersion(project, draft, current.versionNumber + 1, { operation: "ROLLBACK" });
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === "PERSISTENCE_TRANSACTION_FAILED") { log("CONFLICT"); throw conflict(); }
      throw cause;
    }
    log("RESTORED", ` newVersion=${version.versionNumber} restoredFrom=${previous.versionNumber}`);
    return { version, restoredFromVersionId: previous.id };
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
    additionalChecks: readonly BrowserQACheckExecutor[] = [],
    failedCandidate?: Omit<FailedCandidateEvidenceRequest, "report" | "functionalContract"> & { readonly functionalContract?: ResolvedFunctionalContract },
    acceptance: "STRICT" | "USABLE_GENERATION" = "STRICT",
    plan?: BrowserQAPlan,
  ): Promise<{ readonly report: BrowserQAReport; readonly artifactRef: string } | undefined> {
    if (!enabled) return undefined;
    if (!this.deps.browserQA)
      throw new ApplicationError("VALIDATION_FAILED", "Browser QA is not configured");
    // Planned requirement assertions are passed explicitly; other functional.*
    // probes stay excluded from usable-generation acceptance as before.
    const planned = (check: BrowserQACheckExecutor) => /^functional\.(?:optional-)?requirements$/.test(check.definition.checkId);
    const allChecks = acceptance === "USABLE_GENERATION" ? usableGenerationChecks(failedCandidate?.functionalContract, (assetManifest?.assets.length ?? 0) > 0,
      additionalChecks.filter(check => plan ? planned(check) || !check.definition.checkId.startsWith("functional.") && check.definition.checkId !== "template-reference.requirements"
        : !check.definition.checkId.startsWith("functional.") && check.definition.checkId !== "template-reference.requirements")) : [
      ...browserQACoreCheckExecutors,
      ...browserQAResponsiveAndInteractionChecks,
      ...additionalChecks,
      ...browserQARuntimeChecks.filter(({ definition }) =>
        definition.checkId !== "broken-images" || (assetManifest?.assets.length ?? 0) > 0,
      ),
    ];
    const checks = plan ? checksForPlan(plan, allChecks) : allChecks;
    const rawReport = await this.deps.browserQA.run({
      runId: `${siteId}-${versionId}`,
      target: {
        baseUrl: previewUrl,
        projectId: siteId,
        siteVersionId: versionId,
      },
      routes: acceptance === "USABLE_GENERATION" ? [...new Set(["/", ...(siteSpec?.requirements.pages.map(({ path }) => path) ?? [])])] : siteSpec?.requirements.pages.map(({ path }) => path) ?? ["/"],
      ...(plan ? { targets: plan.targets, ...(plan.screenshotTargets === "ALL" ? {} : { screenshotTargets: plan.screenshotTargets }),
        policy: { fullPageScreenshots: plan.fullPageScreenshots } } : {}),
      checks,
      artifactPrefix: `sites/${siteId}/versions/${versionId}/qa/screenshots/browser`,
    });
    const report = applyOptionalRequirementPolicy(acceptance === "USABLE_GENERATION" ? applyUsableGenerationReportPolicy(rawReport) : rawReport);
    const artifactRef = await persistBrowserQAReport(this.deps.artifacts, siteId, versionId, report);
    if (report.status === "FAIL" && plan && evaluateQAVerification(plan, report).outcome === "INCONCLUSIVE") {
      // Infrastructure/timeouts prove only that verification did not finish. Never
      // promote the candidate, never label it defective, never spend a model repair.
      const blocking = report.checks.filter(check => check.status === "FAIL" && check.severity === "ERROR");
      throw new ApplicationError("BROWSER_QA_INCONCLUSIVE", "Browser verification could not complete. Your saved website is unchanged; please try again.", {
        metadata: { failureStage: "BROWSER_QA", qaOutcome: "INCONCLUSIVE", browserQAArtifactRef: artifactRef,
          failureKinds: [...new Set(blocking.map(check => check.failureKind ?? "UNCLASSIFIED"))],
          blockingChecks: blocking.slice(0, 12).map(check => ({ checkId: check.checkId, route: check.route, viewport: check.viewport?.id, failureKind: check.failureKind })) },
      });
    }
    if (report.status === "FAIL") {
      if (failedCandidate && this.deps.failedCandidateEvidence) {
        try {
          const path = await this.deps.failedCandidateEvidence.preserve({ ...failedCandidate, report });
          recordGenerationTelemetry(this.deps.developmentTelemetry, { jobId: failedCandidate.jobId, role: "generation", failureStage: "BROWSER_QA",
            ...(path ? { candidateDiagnosticPath: path } : {}) });
        }
        catch { console.warn("[sites] Local failed-candidate diagnostics unavailable; original QA failure preserved"); }
      }
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
            blockingFindings: blocking.map(check => ({ checkId: check.checkId, route: check.route, viewport: check.viewport?.id, message: check.message, ...(check.failureKind ? { failureKind: check.failureKind } : {}) })),
            failureStage: "BROWSER_QA",
            qaOutcome: "FAILED",
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
    options?: SiteVersionCommitOptions,
  ): Promise<SiteVersion> {
    if (this.deps.versionCommitter) return this.deps.versionCommitter.commit(project, draft, undefined, options);
    // Without an atomic committer, still refuse to replace a version that changed
    // after this candidate started (edit vs rollback race in one process).
    const latest = await this.deps.projects.getById(project.id);
    if (latest?.latestVersionId !== project.latestVersionId)
      throw new ApplicationError("PERSISTENCE_TRANSACTION_FAILED", "Current site changed while saving the result");
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
    // Redacted and bounded; npm's leading error lines carry the cause.
    const failure = summarizeInstallFailure(install.stderr, install.stdout, 4_000);
    console.error(
      `[sites] job=${jobId} ${source} dependency installation failed exit=${install.exitCode ?? "null"} timedOut=${install.timedOut}` +
        `${failure.npmErrorCode ? ` npmErrorCode=${failure.npmErrorCode}` : ""}\n${failure.output}`,
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
          ...(failure.npmErrorCode ? { npmErrorCode: failure.npmErrorCode } : {}),
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
  async #authorizeBilling(
    userId: UserId,
    provider: string,
  ): Promise<BillingAuthorization | undefined> {
    if (!this.deps.billing || provider === "mock" || provider === "mock-agent") return undefined;
    const model = this.deps.resolveAgentModel(provider);
    if (!model)
      throw new ApplicationError(
        "MODEL_CREDIT_RATE_NOT_FOUND",
        `The selected Sites provider '${provider}' did not expose a model`,
        { metadata: { provider, model: null } },
      );
    return this.deps.billing.preflight({ userId, provider, model });
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
