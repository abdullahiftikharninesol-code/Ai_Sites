import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { browserQACoreCheckExecutors } from "../../browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../../browser-qa/browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "../../browser-qa/browser-qa-runtime-checks.js";
import { persistBrowserQAReport } from "../../browser-qa/browser-qa-persistence.js";
import type { BrowserQARunner } from "../../browser-qa/browser-qa-runner.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import { ArtifactNamespace } from "../../persistence/artifact-namespace.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import type { SiteProjectRepository } from "../../persistence/repositories.js";
import type { SiteVersionCommitter, UnnumberedSiteVersion } from "../../persistence/version-committer.js";
import { SITE_V1_TECHNICAL_PROFILE } from "../../cli/runtime/site-technical-profile.js";
import type { SiteProject } from "../../sites/domain/entities.js";
import { SitePackageValidator } from "../../sites/generation/site-policies.js";
import { SiteSourceSnapshotService, summarizeChanges } from "../../sites/generation/source-snapshot.js";
import type { SiteId, UserId, VersionId } from "../../shared/types.js";
import type { SiteTemplateRepository } from "../repositories.js";
import type { TemplateArtifactReader } from "../publishing/template-artifact-storage.js";
import { validateTemplateSource } from "../publishing/template-source.js";
import { extractTemplateZip } from "./safe-template-zip.js";
import { markTemplateInstantiationStage, withTemplateInstantiationDiagnostics } from "./template-instantiation-diagnostics.js";

export interface InstantiateTemplateRequest {
  readonly ownerId: UserId;
  readonly templateKey: string;
  readonly version?: number;
  readonly projectName?: string;
}

export interface TemplateInstantiationResult {
  readonly projectId: SiteId;
  readonly versionId: VersionId;
  readonly environmentId: string;
  readonly preview: { readonly url: string; readonly port: number };
}

export interface TemplateInstantiationDependencies {
  readonly templates: SiteTemplateRepository;
  readonly source: TemplateArtifactReader;
  readonly execution: LocalExecutionProvider;
  readonly artifacts: ArtifactStore;
  readonly projects: SiteProjectRepository;
  readonly versions: SiteVersionCommitter;
  readonly browserQA: BrowserQARunner;
  readonly cleanupSite: (siteId: SiteId, ownerId: UserId) => Promise<void>;
}

export class TemplateInstantiationService {
  readonly #snapshots: SiteSourceSnapshotService;
  readonly #packages = new SitePackageValidator();

  constructor(private readonly deps: TemplateInstantiationDependencies) {
    this.#snapshots = new SiteSourceSnapshotService(deps.artifacts);
  }

  async instantiate(request: InstantiateTemplateRequest): Promise<TemplateInstantiationResult> {
    return withTemplateInstantiationDiagnostics(request.templateKey, () => this.#instantiate(request));
  }

  async #instantiate(request: InstantiateTemplateRequest): Promise<TemplateInstantiationResult> {
    const template = request.version === undefined
      ? await this.deps.templates.findLatestActiveTemplate(request.templateKey)
      : await this.deps.templates.findTemplateVersion(request.templateKey, request.version);
    if (
      !template ||
      template.status !== "active" ||
      !template.sourceObject ||
      !template.sourceSha256
    )
      throw new ApplicationError("TEMPLATE_NOT_FOUND", "Active template was not found");

    markTemplateInstantiationStage("GCS_DOWNLOAD");
    const archive = await this.deps.source.readObject(template.sourceObject);
    if (!archive)
      throw new ApplicationError("TEMPLATE_NOT_FOUND", "Template source artifact was not found");
    markTemplateInstantiationStage("SHA_VALIDATION");
    const actualSha256 = createHash("sha256").update(archive).digest("hex");
    if (actualSha256 !== template.sourceSha256)
      throw new ApplicationError(
        "TEMPLATE_SOURCE_INTEGRITY_FAILED",
        "Template source integrity verification failed",
      );

    markTemplateInstantiationStage("EXTRACTION");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sites-template-instantiation-"));
    const extractedRoot = join(temporaryRoot, "source");
    const siteId = randomUUID() as SiteId;
    const draftVersionId = randomUUID() as VersionId;
    let environmentId: string | undefined;
    let succeeded = false;
    try {
      await mkdir(extractedRoot, { recursive: true });
      await extractTemplateZip(archive, extractedRoot);
      markTemplateInstantiationStage("SOURCE_VALIDATION");
      const source = await validateTemplateSource(extractedRoot);
      const environment = await this.deps.execution.createEnvironment({});
      environmentId = environment.id;
      for (const path of source.packageFiles)
        await this.deps.execution.writeFileBytes(
          environment.id,
          path,
          new Uint8Array(await readFile(join(source.directory, ...path.split("/")))),
        );

      this.#packages.validate(await this.deps.execution.readFile(environment.id, "package.json"));
      markTemplateInstantiationStage("BUILD");
      const install = await this.deps.execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
        timeoutMs: 300_000,
      });
      if (install.exitCode !== 0 || install.timedOut) {
        markTemplateInstantiationStage("BUILD", { command: "npm ci", exitCode: install.exitCode, timedOut: install.timedOut });
        throw new ApplicationError(
          "TEMPLATE_INSTANTIATION_BUILD_FAILED",
          "Template dependency installation failed",
        );
      }
      const buildCommand = await this.deps.execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: 180_000,
      });
      if (buildCommand.exitCode !== 0 || buildCommand.timedOut) {
        markTemplateInstantiationStage("BUILD", { command: "npm run build", exitCode: buildCommand.exitCode, timedOut: buildCommand.timedOut });
        throw new ApplicationError(
          "TEMPLATE_INSTANTIATION_BUILD_FAILED",
          "Template build validation failed",
        );
      }
      markTemplateInstantiationStage("PREVIEW_INITIALIZATION");
      const preview = await this.deps.execution.startPreview(environment.id, { port: 0 });
      if (!preview.url)
        throw new ApplicationError(
          "TEMPLATE_INSTANTIATION_BUILD_FAILED",
          "Template preview did not become ready",
        );

      markTemplateInstantiationStage("BROWSER_QA");
      const browserQA = await this.deps.browserQA.run({
        runId: `${siteId}-${draftVersionId}`,
        target: {
          baseUrl: preview.url,
          projectId: siteId,
          siteVersionId: draftVersionId,
        },
        routes: template.routes.map((route) => route.path),
        checks: [
          ...browserQACoreCheckExecutors,
          ...browserQAResponsiveAndInteractionChecks,
          ...browserQARuntimeChecks.filter(({ definition }) => definition.checkId !== "broken-images"),
        ],
        artifactPrefix: `sites/${siteId}/versions/${draftVersionId}/qa/screenshots/browser`,
      });
      if (browserQA.status === "FAIL") {
        markTemplateInstantiationStage("BROWSER_QA", { failures: browserQA.checks.filter((check) => check.status === "FAIL").map((check) => ({ checkId: check.checkId, route: check.route, viewport: check.viewport?.id, severity: check.severity })) });
        throw new ApplicationError(
          "TEMPLATE_INSTANTIATION_QA_FAILED",
          "Template Browser QA failed",
        );
      }

      markTemplateInstantiationStage("PERSISTENCE");
      const sourceArtifactRef = ArtifactNamespace.version(
        siteId,
        draftVersionId,
        "SOURCE_ARCHIVE",
        "source.json",
      );
      const sourceManifestRef = ArtifactNamespace.version(
        siteId,
        draftVersionId,
        "SOURCE_MANIFEST",
        "manifest.json",
      );
      const snapshot = await this.#snapshots.capture(
        this.deps.execution,
        environment.id,
        sourceArtifactRef,
        {
          technicalProfileId: SITE_V1_TECHNICAL_PROFILE.id,
          technicalProfileVersion: SITE_V1_TECHNICAL_PROFILE.version,
          templateId: template.templateKey,
          templateVersion: template.version,
        },
      );
      const browserQAArtifactRef = await persistBrowserQAReport(
        this.deps.artifacts,
        siteId,
        draftVersionId,
        browserQA,
      );
      const buildArtifactRef = ArtifactNamespace.version(
        siteId,
        draftVersionId,
        "PRODUCTION_BUILD",
        "build.json",
      );
      await this.deps.artifacts.put(
        buildArtifactRef,
        Buffer.from(JSON.stringify({
          success: true,
          command: { executable: "npm", args: ["run", "build"] },
          exitCode: buildCommand.exitCode,
          stdout: buildCommand.stdout,
          stderr: buildCommand.stderr,
          startedAt: buildCommand.startedAt,
          finishedAt: buildCommand.finishedAt,
          durationMs: buildCommand.durationMs,
        })),
        { kind: "PRODUCTION_BUILD", contentType: "application/json" },
      );

      const now = new Date();
      const requestedName = request.projectName?.trim();
      const project: SiteProject = {
        id: siteId,
        ownerId: request.ownerId,
        name: requestedName ? requestedName.slice(0, 60) : template.name,
        slug: `site-${siteId.slice(0, 8)}`,
        status: "DRAFT",
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.projects.save(project);
      const draft: UnnumberedSiteVersion = {
        id: draftVersionId,
        siteId,
        sourceArtifactRef,
        sourceManifestRef,
        buildArtifactRef,
        buildStatus: "SUCCEEDED",
        technicalProfileId: SITE_V1_TECHNICAL_PROFILE.id,
        templateId: template.templateKey,
        templateVersion: template.version,
        changeSummary: summarizeChanges(undefined, snapshot).summary,
        browserQAStatus: browserQA.status === "PASS" ? "PASSED" : "PASSED_WITH_WARNINGS",
        browserQAArtifactRef,
        browserQAScreenshotRefs: browserQA.artifactRefs,
        usageSummary: {
          logicalCalls: 0,
          physicalRequests: 0,
          creditsCharged: 0,
          source: "template",
        },
        createdAt: new Date(),
      };
      const committed = await this.deps.versions.commit(project, draft);
      succeeded = true;
      return {
        projectId: siteId,
        versionId: committed.id,
        environmentId: environment.id,
        preview: { url: preview.url, port: preview.port },
      };
    } catch (cause) {
      await Promise.allSettled([this.deps.cleanupSite(siteId, request.ownerId)]);
      throw cause;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
      if (!succeeded && environmentId)
        await Promise.allSettled([this.deps.execution.destroyEnvironment(environmentId)]);
    }
  }
}
