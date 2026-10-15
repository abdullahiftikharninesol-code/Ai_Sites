import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createMongoPersistentSitesProduct } from "../sites/generation/create-mongo-persistent-sites-product.js";
import type { DeploymentId, JobId, SiteId, UserId, VersionId } from "../shared/types.js";
import { DevJobManager } from "./dev-job-manager.js";
import { DevelopmentPreviewManager } from "./development-preview-manager.js";
import { createAgentProviderRegistry } from "../agents/registry/create-agent-provider-registry.js";
import { loadConfig } from "../app/config/environment.js";
import type { SiteSourceSnapshot } from "../sites/generation/source-snapshot.js";
import { loadPersistenceConfig } from "../persistence/persistence-config.js";
import type { MongoConnectionManager } from "../persistence/mongodb/mongo-connection.js";
import { ArtifactMediaStore } from "../sites/assets/media-store.js";
import { ingestUserImage, userAssetsManifest, type UserProvidedAsset } from "../sites/assets/user-asset-ingestion.js";
import { MongoIdentityRepository, type IdentityRepository } from "../auth/identity-repository.js";
import { resolveTerminalJobBillingFields } from "./job-billing-result.js";

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

const DEVELOPMENT_PLAYGROUND_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
] as const;

const explicitPlaygroundOrigins = (env: NodeJS.ProcessEnv): readonly string[] | undefined => {
  const configured = env.SITES_PLAYGROUND_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = configured?.length
    ? [...new Set(configured)]
    : env.SITES_PLAYGROUND_ORIGIN?.trim()
      ? [env.SITES_PLAYGROUND_ORIGIN.trim()]
      : undefined;
  if (origins?.includes("*"))
    throw new Error("Sites playground CORS requires explicit origins; wildcard is not allowed");
  return origins;
};

const playgroundOrigins = (env: NodeJS.ProcessEnv): readonly string[] => {
  const configured = explicitPlaygroundOrigins(env);
  if (configured) return configured;
  return env.NODE_ENV === "production" ? [] : DEVELOPMENT_PLAYGROUND_ORIGINS;
};
/**
 * Every user-facing method takes the authenticated `ownerId` first and scopes
 * its project, job, asset and preview lookups to it. Nothing here falls back to
 * a default owner.
 */
export class PlaygroundService {
  /**
   * Development identity used only by the unauthenticated loopback Socket.IO
   * playground until the GetChatly socket integration phase. Authenticated HTTP
   * routes never use it.
   */
  readonly userId = "local-playground-user" as UserId;
  readonly agentProviderId: string;
  readonly agentModel: string;
  readonly product;
  readonly jobs;
  readonly previews;
  readonly hosting;
  readonly runtimeGateway;
  /** GetChatly users/adminusers, read through the Sites DATABASE connection. */
  readonly identities: IdentityRepository;
  readonly #mediaStore: ArtifactMediaStore;
  readonly #uploadedAssets = new Map<string, { readonly ownerId: string; readonly asset: UserProvidedAsset }>();
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
    this.identities = new MongoIdentityRepository(this.product.database.connection);
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
  async ingestImage(
    ownerId: string,
    upload: { readonly originalName: string; readonly mimeType: string; readonly bytes: Uint8Array },
  ) {
    const owner = this.#owner(ownerId);
    const asset = await ingestUserImage(this.#mediaStore, upload);
    this.#uploadedAssets.set(asset.id, { ownerId: owner, asset });
    return { id: asset.id, originalName: asset.originalName, mimeType: asset.mimeType, managedPath: asset.managedPath };
  }
  #assets(ownerId: string, ids: readonly string[] | undefined, referenceIds: readonly string[] = []) {
    // Another owner's upload resolves exactly like a missing one.
    const assets = (ids ?? []).map((id) => {
      const entry = this.#uploadedAssets.get(id);
      return entry?.ownerId === ownerId ? entry.asset : undefined;
    });
    if (assets.some((asset) => !asset)) throw this.#error("USER_ASSET_NOT_FOUND", "One or more selected images are no longer available");
    if (!assets.length && referenceIds.length) throw this.#error("INVALID_REQUEST", "Design references must be selected attachments");
    return assets.length ? userAssetsManifest(assets as UserProvidedAsset[], referenceIds) : undefined;
  }
  getJob(ownerId: string, jobId: string) {
    return this.jobs.getOwned(jobId, this.#owner(ownerId));
  }
  generate(ownerId: string, prompt: string, attachmentIds?: readonly string[], referenceIds: readonly string[] = []) {
    const owner = this.#owner(ownerId);
    const assetManifest = this.#assets(owner, attachmentIds, referenceIds);
    return this.jobs.start("GENERATE", async (onIntelligence) => {
      const result = await this.product.orchestrator.generateWebsite({
        userId: owner as UserId,
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
      const billing = await resolveTerminalJobBillingFields({
        jobId: result.jobId as JobId,
        ownerId: owner,
        jobs: this.product.jobs,
        readCanonicalQuota: this.product.readCanonicalQuota,
      });
      return {
        projectId: result.siteId,
        versionId: result.versionId,
        preview: { sessionId: preview.id, url: preview.url },
        ...(billing ?? {}),
        ...(result.intelligence ? { intelligence: result.intelligence } : {}),
      };
    }, owner);
  }
  async edit(ownerId: string, siteId: string, prompt: string, baseVersionId?: string, attachmentIds?: readonly string[], referenceIds: readonly string[] = []) {
    const owner = this.#owner(ownerId);
    const project = await this.#project(owner, siteId);
    const versionId = (baseVersionId ?? project.latestVersionId) as VersionId | undefined;
    if (!versionId) throw this.#error("VERSION_NOT_FOUND", "No base version exists");
    // A client-chosen base version must belong to this project, otherwise an
    // edit could restore another owner's source into this site.
    if (baseVersionId !== undefined) {
      const base = await this.product.versions.getById(versionId);
      if (!base || base.siteId !== project.id)
        throw this.#error("VERSION_NOT_FOUND", "Version not found");
    }
    const assetManifest = this.#assets(owner, attachmentIds, referenceIds);
    return this.jobs.start("EDIT", async (onIntelligence) => {
      const result = await this.product.orchestrator.editWebsite({
        userId: owner as UserId,
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
      const billing = await resolveTerminalJobBillingFields({
        jobId: result.jobId as JobId,
        ownerId: owner,
        jobs: this.product.jobs,
        readCanonicalQuota: this.product.readCanonicalQuota,
      });
      return {
        projectId: result.siteId,
        versionId: result.newVersionId,
        preview: { sessionId: preview.id, url: preview.url },
        ...(billing ?? {}),
        ...(result.intelligence ? { intelligence: result.intelligence } : {}),
      };
    }, owner);
  }
  async listSites(ownerId: string) {
    const projects = (await this.product.queries.listProjects(this.#owner(ownerId) as UserId)).items;
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
  async siteDetail(ownerId: string, siteId: string) {
    const project = await this.#project(ownerId, siteId);
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
  async versions(ownerId: string, siteId: string) {
    return (await this.siteDetail(ownerId, siteId)).versions;
  }
  async sourceFiles(ownerId: string, siteId: string, versionId: string, requestedPath?: string) {
    await this.#project(ownerId, siteId);
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
  async renameSite(ownerId: string, siteId: string, name: string) {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw this.#error("INVALID_REQUEST", "A site name is required");
    const project = await this.#project(ownerId, siteId);
    // Only the name changes; ownerId is carried over from the owner-scoped read.
    await this.product.projects.save({ ...project, name: trimmed, updatedAt: new Date() });
    return { projectId: project.id, name: trimmed };
  }
  async createPersistenceTestSite(ownerId: string, name: string) {
    const owner = this.#owner(ownerId);
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw this.#error("INVALID_REQUEST", "A site name is required");
    const now = new Date();
    const id = randomUUID() as SiteId;
    await this.product.projects.save({
      id,
      ownerId: owner as UserId,
      name: trimmed,
      slug: `site-${id.slice(0, 8)}`,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    });
    return { projectId: id, name: trimmed };
  }
  async deleteSite(ownerId: string, siteId: string) {
    const project = await this.#project(ownerId, siteId);
    if (this.jobs.hasActiveProject(project.id))
      throw this.#error("DEV_JOB_BUSY", "Wait for the active generation to finish before deleting");
    const activePreview = this.previews.list().find((session) => session.siteId === project.id);
    if (activePreview) await this.previews.stop(activePreview.id);
    await this.product.siteRuntime.deleteRuntime(project.id);
    await this.product.deleteSite(project.id, project.ownerId);
    return { deleted: true };
  }
  async startPreview(ownerId: string, siteId: string, versionId: string) {
    const project = await this.#project(ownerId, siteId);
    const version = await this.product.versions.getById(versionId as VersionId);
    if (!version || version.siteId !== project.id)
      throw this.#error("VERSION_NOT_FOUND", "Version not found");
    const session = await this.previews.start(project.id, version.id);
    return {
      previewSessionId: session.id,
      previewUrl: session.url,
      environmentId: session.environmentId,
      workspacePath: this.product.execution.getWorkspacePath(session.environmentId),
    };
  }
  async previewInspector(ownerId: string, id: string) {
    const session = await this.#ownedPreview(ownerId, id);
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
  async stopPreview(ownerId: string, id: string) {
    // Another owner's preview behaves exactly like a missing one.
    return (await this.#ownedPreview(ownerId, id)) ? this.previews.stop(id) : false;
  }
  async publish(ownerId: string, siteId: string, versionId: string) {
    const project = await this.#project(ownerId, siteId);
    const deployment = await this.product.deploymentService.deploy({
      siteId: project.id,
      versionId: versionId as VersionId,
    });
    await this.product.deploymentService.publish(deployment);
    return {
      deploymentId: deployment.id,
      versionId: deployment.versionId,
      hostedUrl: this.hosting.url(project.slug),
    };
  }
  async rollback(ownerId: string, siteId: string, deploymentId: string) {
    const project = await this.#project(ownerId, siteId);
    await this.product.deploymentService.rollback(project.id, deploymentId as DeploymentId);
    return this.siteDetail(ownerId, siteId);
  }
  async unpublish(ownerId: string, siteId: string) {
    const project = await this.#project(ownerId, siteId);
    await this.product.deploymentService.unpublish(project.id);
    return { unpublished: true };
  }
  async runtimeInspector(ownerId: string, siteId: string) {
    const project = await this.#project(ownerId, siteId);
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
  /** Cross-owner access is indistinguishable from a missing site (404). */
  async #project(ownerId: string, siteId: string) {
    const project = await this.product.projects.getOwnedById(siteId as SiteId, this.#owner(ownerId));
    if (!project) throw this.#error("SITE_NOT_FOUND", "Site not found");
    return project;
  }
  async #ownedPreview(ownerId: string, id: string) {
    const session = this.previews.list().find((candidate) => candidate.id === id);
    if (!session) return undefined;
    try {
      await this.#project(ownerId, session.siteId);
    } catch (error) {
      if ((error as { code?: unknown }).code === "SITE_NOT_FOUND") return undefined;
      throw error;
    }
    return this.previews.get(id);
  }
  #owner(ownerId: string) {
    if (typeof ownerId !== "string" || !ownerId)
      throw this.#error("AUTHENTICATION_REQUIRED", "An authenticated owner is required");
    return ownerId;
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
