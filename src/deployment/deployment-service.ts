import { createHash, randomUUID } from "node:crypto";
import { ApplicationError } from "../app/errors/application-error.js";
import type { LocalExecutionProvider } from "../execution/local/local-execution.provider.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type {
  SiteDeploymentRepository,
  SitePublicationRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../persistence/repositories.js";
import type { DeploymentId, SiteId, VersionId } from "../shared/types.js";
import type { SiteDeployment } from "../sites/domain/entities.js";
import type { LocalSiteGenerationPipeline } from "../sites/generation/local-site-generation-pipeline.js";
import { SiteArtifactSecurityScanner } from "../site-security/site-artifact-security-scanner.js";
export interface DeploySiteVersionRequest {
  readonly siteId: SiteId;
  readonly versionId: VersionId;
}
export interface DeploymentFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}
export interface SiteDeploymentManifest {
  readonly schemaVersion: 1;
  readonly siteId: SiteId;
  readonly versionId: VersionId;
  readonly technicalProfile?: string;
  readonly files: readonly DeploymentFile[];
  readonly entrypoint: "index.html";
  readonly createdAt: string;
}
export class DeploymentService {
  constructor(
    private readonly pipeline: LocalSiteGenerationPipeline,
    private readonly execution: LocalExecutionProvider,
    private readonly artifacts: ArtifactStore,
    private readonly projects: SiteProjectRepository & Partial<SitePublicationRepository>,
    private readonly versions: SiteVersionRepository,
    private readonly deployments: SiteDeploymentRepository,
    private readonly runtimeBaseUrl = "http://127.0.0.1:8090",
    private readonly securityScanner = new SiteArtifactSecurityScanner(),
  ) {}
  async deploy(request: DeploySiteVersionRequest): Promise<SiteDeployment> {
    const project = await this.projects.getById(request.siteId);
    if (!project) throw new ApplicationError("SITE_NOT_FOUND", "Site not found");
    const version = await this.versions.getById(request.versionId);
    if (!version || version.siteId !== request.siteId)
      throw new ApplicationError("VERSION_NOT_FOUND", "Version not found");
    const browserQaAccepted = version.browserQAStatus === "PASSED" || version.browserQAStatus === "PASSED_WITH_WARNINGS";
    const historicalVisualQaAccepted = version.browserQAStatus === undefined && version.visualQAStatus === "PASSED";
    if (version.buildStatus !== "SUCCEEDED" || (!browserQaAccepted && !historicalVisualQaAccepted))
      throw new ApplicationError(
        "DEPLOYMENT_BUILD_FAILED",
        "Version has not passed build and Browser QA policy",
      );
    const deploymentId = randomUUID() as DeploymentId;
    const restored = await this.pipeline.restoreVersion(version.id);
    try {
      const entries = await this.execution.listFiles(restored.environmentId, "dist");
      const files: DeploymentFile[] = [];
      for (const entry of entries)
        if (entry.type === "FILE") {
          const relative = entry.path.replace(/^dist\//, "");
          if (relative === ".env" || relative.includes(".."))
            throw new ApplicationError("DEPLOYMENT_ARTIFACT_INVALID", "Unsafe deployment output");
          const bytes = await this.execution.readFileBytes(restored.environmentId, entry.path);
          files.push({
            path: relative,
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            contentBase64: bytes.toString("base64"),
          });
        }
      if (!files.some((f) => f.path === "index.html"))
        throw new ApplicationError("DEPLOYMENT_ARTIFACT_INVALID", "dist/index.html missing");
      if (version.runtimeSchemaVersion !== undefined) {
        const index = files.findIndex((file) => file.path === "index.html");
        const original = Buffer.from(files[index]!.contentBase64, "base64").toString("utf8");
        const config = JSON.stringify({ siteId: request.siteId, baseUrl: this.runtimeBaseUrl });
        const contact = version.siteSpec?.runtime?.collections.some(
          (collection) => collection.name === "contact_submissions",
        );
        const bootstrap = `<script>window.__SITES_RUNTIME__=${config};window.sites={data:{create:(c,d)=>fetch(window.__SITES_RUNTIME__.baseUrl+'/runtime/v1/sites/'+encodeURIComponent(window.__SITES_RUNTIME__.siteId)+'/data/'+encodeURIComponent(c),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(async r=>{const x=await r.json();if(!r.ok||!x.ok)throw new Error(x.error?.message||'Runtime request failed');return x.data}),list:(c)=>fetch(window.__SITES_RUNTIME__.baseUrl+'/runtime/v1/sites/'+encodeURIComponent(window.__SITES_RUNTIME__.siteId)+'/data/'+encodeURIComponent(c)).then(r=>r.json())}};${contact ? `addEventListener('DOMContentLoaded',()=>{const m=document.querySelector('main');if(!m)return;const f=document.createElement('form');f.setAttribute('aria-label','Contact form');f.innerHTML='<label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Message<textarea name="message" required></textarea></label><button type="submit">Send</button><p role="status"></p>';f.onsubmit=async e=>{e.preventDefault();const s=f.querySelector('[role=status]');try{await window.sites.data.create('contact_submissions',Object.fromEntries(new FormData(f)));f.reset();s.textContent='Message sent';}catch{s.textContent='Unable to send';}};m.appendChild(f);});` : ""}</script>`;
        const content = Buffer.from(original.replace("</head>", `${bootstrap}</head>`));
        files[index] = {
          path: "index.html",
          sizeBytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          contentBase64: content.toString("base64"),
        };
      }
      this.securityScanner.scan(
        files.map((file) => ({
          path: file.path,
          content: Buffer.from(file.contentBase64, "base64"),
        })),
        "deployment",
      );
      const manifest: SiteDeploymentManifest = {
        schemaVersion: 1,
        siteId: request.siteId,
        versionId: version.id,
        ...(version.technicalProfileId ? { technicalProfile: version.technicalProfileId } : {}),
        files,
        entrypoint: "index.html",
        createdAt: new Date().toISOString(),
      };
      const artifactRef = `sites/${request.siteId}/deployments/${deploymentId}/build.json`;
      const manifestRef = `sites/${request.siteId}/deployments/${deploymentId}/manifest.json`;
      const data = Buffer.from(JSON.stringify(manifest));
      await this.artifacts.put(artifactRef, data, {
        kind: "DEPLOYMENT_BUILD",
        contentType: "application/json",
      });
      await this.artifacts.put(
        manifestRef,
        Buffer.from(
          JSON.stringify({
            ...manifest,
            files: files.map((file) => ({
              path: file.path,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
            })),
          }),
        ),
        { kind: "SOURCE_MANIFEST", contentType: "application/json" },
      );
      const deployment: SiteDeployment = {
        id: deploymentId,
        siteId: request.siteId,
        versionId: version.id,
        hostname: project.slug,
        status: "READY",
        hostingProvider: "local",
        deploymentArtifactRef: artifactRef,
        deploymentManifestRef: manifestRef,
        createdAt: new Date(),
        completedAt: new Date(),
        metrics: {
          finalBuildDurationMs: restored.build.durationMs,
          deploymentArtifactBytes: data.length,
          deploymentFileCount: files.length,
        },
      };
      await this.deployments.save(deployment);
      return deployment;
    } finally {
      await this.pipeline.disposeRestoredEnvironment(restored.environmentId);
    }
  }
  async publish(deployment: SiteDeployment): Promise<void> {
    try {
      if (this.projects.setPublication)
        await this.projects.setPublication(deployment.siteId, {
          versionId: deployment.versionId,
          deploymentId: deployment.id,
        });
      else {
        const project = await this.projects.getById(deployment.siteId);
        if (!project) throw new ApplicationError("SITE_NOT_FOUND", "Site not found");
        await this.projects.save({
          ...project,
          publishedVersionId: deployment.versionId,
          publishedDeploymentId: deployment.id,
          updatedAt: new Date(),
        });
      }
    } catch (cause) {
      throw new ApplicationError("PUBLISH_FAILED", "Atomic publish failed", { cause });
    }
  }
  async rollback(siteId: SiteId, deploymentId: DeploymentId) {
    const deployment = await this.deployments.getById(deploymentId);
    if (!deployment || deployment.siteId !== siteId)
      throw new ApplicationError("DEPLOYMENT_NOT_FOUND", "Deployment not found");
    await this.publish(deployment);
  }
  async unpublish(siteId: SiteId) {
    const project = await this.projects.getById(siteId);
    if (!project) throw new ApplicationError("SITE_NOT_FOUND", "Site not found");
    if (this.projects.setPublication) await this.projects.setPublication(siteId);
    else {
      const { publishedVersionId: _version, publishedDeploymentId: _deployment, ...current } =
        project;
      await this.projects.save({ ...current, updatedAt: new Date() });
    }
  }
}
