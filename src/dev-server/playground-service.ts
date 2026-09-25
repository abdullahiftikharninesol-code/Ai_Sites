import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createMongoPersistentSitesProduct } from "../sites/generation/create-mongo-persistent-sites-product.js";
import type { DeploymentId, SiteId, UserId, VersionId } from "../shared/types.js";
import { DevJobManager } from "./dev-job-manager.js";
import { DevelopmentPreviewManager } from "./development-preview-manager.js";
import { createAgentProviderRegistry } from "../agents/registry/create-agent-provider-registry.js";
import { loadConfig } from "../app/config/environment.js";
import type { SiteSourceSnapshot } from "../sites/generation/source-snapshot.js";
import { loadPersistenceConfig } from "../persistence/persistence-config.js";
import type { MongoConnectionManager } from "../persistence/mongodb/mongo-connection.js";
import { ArtifactMediaStore } from "../sites/assets/media-store.js";
import { ingestUserImage, userAssetsManifest, type UserProvidedAsset } from "../sites/assets/user-asset-ingestion.js";

export interface PlaygroundConfig {
  host: string;
  port: number;
  webOrigins: readonly string[];
  hostingHost: string;
  hostingPort: number;
  runtimeHost: string;
  runtimePort: number;
  previewIdleTtlMs: number;
  dataRoot: string;
  agentProvider: string;
  agentPlanningEnabled?: boolean;
  databaseUri?: string;
}
export const loadPlaygroundConfig = (env: NodeJS.ProcessEnv = process.env): PlaygroundConfig => {
  const persistence = loadPersistenceConfig(env);
  return {
    host: env.SITES_DEV_SERVER_HOST ?? "127.0.0.1",
    port: Number(env.SITES_DEV_SERVER_PORT ?? 4310),
    webOrigins: playgroundOrigins(env),
    hostingHost: "127.0.0.1",
    hostingPort: Number(env.SITES_DEV_HOSTING_PORT ?? 4311),
    runtimeHost: "127.0.0.1",
    runtimePort: Number(env.SITES_DEV_RUNTIME_PORT ?? 8090),
    previewIdleTtlMs: Number(env.SITES_DEV_PREVIEW_IDLE_TTL_MS ?? 3_600_000),
    dataRoot: resolve(env.SITES_DEV_DATA_ROOT ?? join(".sites-runtime", "playground")),
    agentProvider: env.SITES_DEV_AGENT_PROVIDER?.trim() || "mock",
    agentPlanningEnabled: env.SITES_DEV_AGENT_PLANNING === "true",
    ...(persistence.databaseUri ? { databaseUri: persistence.databaseUri } : {}),
  };
};

const playgroundOrigins = (env: NodeJS.ProcessEnv): readonly string[] => {
  const configured = env.SITES_PLAYGROUND_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured?.length) return [...new Set(configured)];
  if (env.SITES_PLAYGROUND_ORIGIN?.trim()) return [env.SITES_PLAYGROUND_ORIGIN.trim()];
  return ["http://127.0.0.1:5173", "http://localhost:5173"];
};
export class PlaygroundService {
  readonly userId = "local-playground-user" as UserId;
  readonly agentProviderId: string;
  readonly agentModel: string;
  readonly product;
  readonly jobs;
  readonly previews;
  readonly hosting;
  readonly runtimeGateway;
  readonly #mediaStore: ArtifactMediaStore;
  readonly #uploadedAssets = new Map<string, UserProvidedAsset>();
  #started = false;
  constructor(
    readonly config: PlaygroundConfig = loadPlaygroundConfig(),
    mongoConnection?: MongoConnectionManager,
  ) {
    const providerId = config.agentProvider === "mock-agent" ? "mock" : config.agentProvider;
    this.agentProviderId = providerId;
    const realAgentComposition = (() => {
      if (providerId === "mock") return undefined;
      const providerEnv = { ...process.env, DEFAULT_AGENT_PROVIDER: providerId };
      const agentRegistry = createAgentProviderRegistry(loadConfig(providerEnv), providerEnv);
      return { agentRegistry, orchestrationAgent: agentRegistry.get(providerId) };
    })();
    this.agentModel =
      realAgentComposition?.orchestrationAgent.getCapabilities().models[0] ?? "mock-sites-v1";
    this.product = createMongoPersistentSitesProduct({
      ...(config.databaseUri ? { databaseUri: config.databaseUri } : {}),
      ...(mongoConnection ? { mongoConnection } : {}),
      artifactRoot: join(config.dataRoot, "artifacts"),
      executionRoot: join(config.dataRoot, "execution"),
      ...(realAgentComposition ?? {}),
    });
    this.#mediaStore = new ArtifactMediaStore(this.product.artifacts);
    this.jobs = new DevJobManager(this.product.progress);
    this.previews = new DevelopmentPreviewManager(
      this.product.pipeline,
      this.product.execution,
      config.previewIdleTtlMs,
    );
    this.hosting = this.product.createHostingGateway(config.hostingHost, config.hostingPort);
    this.runtimeGateway = this.product.createRuntimeGateway(
      [...config.webOrigins, `http://${config.hostingHost}:${config.hostingPort}`],
      config.runtimeHost,
      config.runtimePort,
    );
  }
  async start() {
    if (this.#started) return;
    await mkdir(this.config.dataRoot, { recursive: true });
    try {
      await this.product.connectPersistence();
      await this.hosting.start();
      await this.runtimeGateway.start();
      this.#started = true;
    } catch (error) {
      // Both close operations are idempotent and prevent a partial startup from
      // leaving one of the local ports occupied.
      await Promise.allSettled([this.runtimeGateway.close(), this.hosting.close()]);
      await this.product.close();
      throw error;
    }
  }
  databaseStatus() {
    return this.product.databaseStatus();
  }
  async ingestImage(upload: { readonly originalName: string; readonly mimeType: string; readonly bytes: Uint8Array }) {
    const asset = await ingestUserImage(this.#mediaStore, upload);
    this.#uploadedAssets.set(asset.id, asset);
    return { id: asset.id, originalName: asset.originalName, mimeType: asset.mimeType, managedPath: asset.managedPath };
  }
  #assets(ids: readonly string[] | undefined, referenceIds: readonly string[] = []) {
    const assets = (ids ?? []).map((id) => this.#uploadedAssets.get(id));
    if (assets.some((asset) => !asset)) throw this.#error("USER_ASSET_NOT_FOUND", "One or more selected images are no longer available");
    if (!assets.length && referenceIds.length) throw this.#error("INVALID_REQUEST", "Design references must be selected attachments");
    return assets.length ? userAssetsManifest(assets as UserProvidedAsset[], referenceIds) : undefined;
  }
  generate(prompt: string, attachmentIds?: readonly string[], referenceIds: readonly string[] = []) {
    const assetManifest = this.#assets(attachmentIds, referenceIds);
    return this.jobs.start("GENERATE", async (onIntelligence) => {
      const result = await this.product.orchestrator.generateWebsite({
        userId: this.userId,
        prompt,
        // Planning is deterministic by default so one click spends provider
        // capacity on coding rather than on an extra planning request.
        planningMode: this.config.agentPlanningEnabled ? "agent-with-fallback" : "deterministic",
        agentProvider: this.agentProviderId,
        browserQAEnabled: true,
        retainPreview: true,
        ...(assetManifest ? { assetManifest } : {}),
        onIntelligence,
      });
      const preview = await this.previews.adopt(result.siteId, result.versionId, result.preview.environmentId, {
        url: result.preview.url!,
        port: result.preview.port,
      });
      return {
        projectId: result.siteId,
        versionId: result.versionId,
        preview: { sessionId: preview.id, url: preview.url },
        ...(result.intelligence ? { intelligence: result.intelligence } : {}),
      };
    });
  }
  async edit(siteId: string, prompt: string, baseVersionId?: string, attachmentIds?: readonly string[], referenceIds: readonly string[] = []) {
    const project = await this.#project(siteId);
    const versionId = (baseVersionId ?? project.latestVersionId) as VersionId | undefined;
    if (!versionId) throw this.#error("VERSION_NOT_FOUND", "No base version exists");
    const assetManifest = this.#assets(attachmentIds, referenceIds);
    return this.jobs.start("EDIT", async (onIntelligence) => {
      const result = await this.product.orchestrator.editWebsite({
        userId: this.userId,
        siteId: siteId as SiteId,
        versionId,
        instruction: prompt,
        agentProvider: this.agentProviderId,
        agentPlanningEnabled: this.config.agentPlanningEnabled === true,
        browserQAEnabled: true,
        retainPreview: true,
        ...(assetManifest ? { assetManifest } : {}),
        onIntelligence,
      });
      const preview = await this.previews.adopt(result.siteId, result.newVersionId, result.preview.environmentId, {
        url: result.preview.url!,
        port: result.preview.port,
      });
      return {
        projectId: result.siteId,
        versionId: result.newVersionId,
        preview: { sessionId: preview.id, url: preview.url },
        ...(result.intelligence ? { intelligence: result.intelligence } : {}),
      };
    });
  }
  async listSites() {
    const projects = (await this.product.queries.listProjects(this.userId)).items;
    return Promise.all(
      projects.map(async (project) => {
        const latest = project.latestVersionId
          ? await this.product.versions.getById(project.latestVersionId)
          : undefined;
        return {
          projectId: project.id,
          name: project.name,
          slug: project.slug,
          latestVersion: latest?.versionNumber,
          publishedVersionId: project.publishedVersionId,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
          hostedUrl: project.publishedDeploymentId ? this.hosting.url(project.slug) : undefined,
        };
      }),
    );
  }
  async siteDetail(siteId: string) {
    const project = await this.#project(siteId);
    const versions = (await this.product.versions.listBySite(project.id)).items;
    const deployments = (await this.product.deployments.listBySite(project.id)).items;
    const domains = await this.product.customDomains.listForSite(project.id);
    const runtime = await this.product.siteRuntime.getRuntime(project.id);
    const activePreview = this.previews.list().find((session) => session.siteId === project.id);
    const latest =
      versions.find((version) => version.id === project.latestVersionId) ?? versions.at(-1);
    return {
      project: {
        projectId: project.id,
        name: project.name,
        slug: project.slug,
        status: project.status,
        latestVersionId: project.latestVersionId,
        publishedVersionId: project.publishedVersionId,
        publishedDeploymentId: project.publishedDeploymentId,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
      capabilities: {
        runtime: runtime?.status === "ACTIVE",
        collections: runtime?.spec.collections.map(({ name }) => name) ?? [],
        auth: latest?.siteSpec?.requirements.features.includes("site authentication") ?? false,
        actions:
          latest?.siteSpec?.requirements.features
            .filter((feature) => feature.startsWith("named action:"))
            .map((feature) => feature.replace("named action: ", "")) ?? [],
      },
      plans: latest?.siteSpec
        ? {
            requirements: latest.siteSpec.requirements,
            design: latest.siteSpec.design,
            runtime: latest.siteSpec.runtime ?? { enabled: false, collections: [] },
            auth: latest.siteSpec.auth,
            integrations: latest.siteSpec.integrations,
            content: latest.siteSpec.content,
          }
        : undefined,
      versions: versions.map((version) =>
        this.#version(version, project.publishedVersionId === version.id),
      ),
      deployments: deployments.map((deployment) => ({
        deploymentId: deployment.id,
        versionId: deployment.versionId,
        status: deployment.status,
        published: project.publishedDeploymentId === deployment.id,
        createdAt: deployment.createdAt.toISOString(),
      })),
      domains: domains.map((domain) => ({
        id: domain.id,
        hostname: domain.hostname,
        status: domain.status,
      })),
      activePreview: activePreview
        ? {
            previewSessionId: activePreview.id,
            versionId: activePreview.versionId,
            previewUrl: activePreview.url,
          }
        : undefined,
      hostedUrl: project.publishedDeploymentId ? this.hosting.url(project.slug) : undefined,
    };
  }
  async versions(siteId: string) {
    return (await this.siteDetail(siteId)).versions;
  }
  async sourceFiles(siteId: string, versionId: string, requestedPath?: string) {
    await this.#project(siteId);
    const version = await this.product.versions.getById(versionId as VersionId);
    if (!version || version.siteId !== siteId)
      throw this.#error("VERSION_NOT_FOUND", "Version not found");
    const artifact = await this.product.artifacts.get(version.sourceArtifactRef);
    if (!artifact) throw this.#error("SOURCE_NOT_FOUND", "Source snapshot not found");
    let snapshot: SiteSourceSnapshot;
    try {
      snapshot = JSON.parse(Buffer.from(artifact).toString("utf8")) as SiteSourceSnapshot;
    } catch {
      throw this.#error("SOURCE_NOT_FOUND", "Source snapshot is unavailable");
    }
    const files = snapshot.manifest?.files?.filter((file) => safeSourcePath(file.path)) ?? [];
    if (requestedPath === undefined) {
      return {
        siteId,
        versionId,
        files: files.map((file) => ({
          path: file.path,
          sizeBytes: file.sizeBytes,
          ...(file.encoding ? { encoding: file.encoding } : {}),
        })),
      };
    }
    if (!safeSourcePath(requestedPath)) throw this.#error("INVALID_REQUEST", "Unsafe source path");
    const file = files.find((candidate) => candidate.path === requestedPath);
    if (!file) throw this.#error("SOURCE_FILE_NOT_FOUND", "Source file not found");
    const content = snapshot.files?.[requestedPath];
    if (typeof content !== "string") throw this.#error("SOURCE_FILE_NOT_FOUND", "Source file not found");
    return {
      siteId,
      versionId,
      path: requestedPath,
      sizeBytes: file.sizeBytes,
      content,
      ...(file.encoding ? { encoding: file.encoding } : {}),
    };
  }
  async renameSite(siteId: string, name: string) {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw this.#error("INVALID_REQUEST", "A site name is required");
    const project = await this.#project(siteId);
    await this.product.projects.save({ ...project, name: trimmed, updatedAt: new Date() });
    return { projectId: project.id, name: trimmed };
  }
  async createPersistenceTestSite(name: string) {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw this.#error("INVALID_REQUEST", "A site name is required");
    const now = new Date();
    const id = randomUUID() as SiteId;
    await this.product.projects.save({
      id,
      ownerId: this.userId,
      name: trimmed,
      slug: `site-${id.slice(0, 8)}`,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    });
    return { projectId: id, name: trimmed };
  }
  async deleteSite(siteId: string) {
    const project = await this.#project(siteId);
    if (this.jobs.hasActiveProject(project.id))
      throw this.#error("DEV_JOB_BUSY", "Wait for the active generation to finish before deleting");
    const activePreview = this.previews.list().find((session) => session.siteId === project.id);
    if (activePreview) await this.previews.stop(activePreview.id);
    await this.product.siteRuntime.deleteRuntime(project.id);
    await this.product.deleteSite(project.id);
    return { deleted: true };
  }
  async startPreview(siteId: string, versionId: string) {
    const version = await this.product.versions.getById(versionId as VersionId);
    if (!version || version.siteId !== siteId)
      throw this.#error("VERSION_NOT_FOUND", "Version not found");
    const session = await this.previews.start(siteId as SiteId, version.id);
    return {
      previewSessionId: session.id,
      previewUrl: session.url,
      environmentId: session.environmentId,
      workspacePath: this.product.execution.getWorkspacePath(session.environmentId),
    };
  }
  async previewInspector(id: string) {
    const session = this.previews.get(id);
    if (!session) throw this.#error("INVALID_REQUEST", "Preview instance was not found");
    const logs = await this.product.execution.readLogs(session.environmentId);
    return {
      previewSessionId: session.id,
      siteId: session.siteId,
      versionId: session.versionId,
      environmentId: session.environmentId,
      workspacePath: this.product.execution.getWorkspacePath(session.environmentId),
      previewUrl: session.url,
      status: "RUNNING" as const,
      processCount: this.product.execution.ownedProcessCount(session.environmentId),
      createdAt: session.createdAt,
      lastAccessedAt: session.lastAccessedAt,
      logs: logs.slice(-100),
    };
  }
  stopPreview(id: string) {
    return this.previews.stop(id);
  }
  async publish(siteId: string, versionId: string) {
    const deployment = await this.product.deploymentService.deploy({
      siteId: siteId as SiteId,
      versionId: versionId as VersionId,
    });
    await this.product.deploymentService.publish(deployment);
    const project = await this.#project(siteId);
    return {
      deploymentId: deployment.id,
      versionId: deployment.versionId,
      hostedUrl: this.hosting.url(project.slug),
    };
  }
  async rollback(siteId: string, deploymentId: string) {
    await this.product.deploymentService.rollback(siteId as SiteId, deploymentId as DeploymentId);
    return this.siteDetail(siteId);
  }
  async unpublish(siteId: string) {
    await this.product.deploymentService.unpublish(siteId as SiteId);
    return { unpublished: true };
  }
  async runtimeInspector(siteId: string) {
    const project = await this.#project(siteId);
    const runtime = await this.product.siteRuntime.getRuntime(project.id);
    if (!runtime) return { enabled: false, collections: [] };
    return {
      enabled: true,
      schemaVersion: runtime.schemaVersion,
      collections: await Promise.all(
        runtime.spec.collections.map(async (collection) => ({
          name: collection.name,
          fields: collection.fields.map(({ name, type, required }) => ({
            name,
            type,
            required: Boolean(required),
          })),
          access: collection.access ?? {},
          recordCount: (
            await this.product.siteRuntime.listRecords(project.id, collection.name, { limit: 1 })
          ).total,
        })),
      ),
    };
  }
  async close() {
    if (!this.#started) {
      await this.previews.close();
      await this.product.close();
      return;
    }
    await this.previews.close();
    await this.runtimeGateway.close();
    await this.hosting.close();
    await this.product.close();
    this.#started = false;
  }
  async resetForTests() {
    await this.close();
    await rm(this.config.dataRoot, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
  async #project(siteId: string) {
    const project = await this.product.projects.getById(siteId as SiteId);
    if (!project || project.ownerId !== this.userId)
      throw this.#error("SITE_NOT_FOUND", "Site not found");
    return project;
  }
  #version(
    version: Awaited<ReturnType<typeof this.product.versions.getById>> extends infer T
      ? Exclude<T, undefined>
      : never,
    published: boolean,
  ) {
    return {
      versionId: version.id,
      versionNumber: version.versionNumber,
      parentVersionId: version.parentVersionId,
      createdAt: version.createdAt.toISOString(),
      buildStatus: version.buildStatus,
      browserQAStatus: version.browserQAStatus,
      runtimeSchemaVersion: version.runtimeSchemaVersion,
      published,
    };
  }
  #error(code: string, message: string) {
    return Object.assign(new Error(message), { code });
  }
}

function safeSourcePath(value: string): boolean {
  return Boolean(
    value &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.split("/").includes("..") &&
      !value.split("/").some((part) => /^\.env(?:\.|$)/i.test(part)) &&
      !/^(?:node_modules|dist)(?:\/|$)/i.test(value),
  );
}
