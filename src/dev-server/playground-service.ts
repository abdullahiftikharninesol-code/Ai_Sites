import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createLocalPersistentSitesProduct } from "../sites/generation/create-local-persistent-sites-product.js";
import type { DeploymentId, SiteId, UserId, VersionId } from "../shared/types.js";
import { DevJobManager } from "./dev-job-manager.js";
import { DevelopmentPreviewManager } from "./development-preview-manager.js";
import { createAgentProviderRegistry } from "../agents/registry/create-agent-provider-registry.js";
import { loadConfig } from "../app/config/environment.js";

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
  visualRepairAttempts?: number;
}
const nonNegativeInteger = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};
export const loadPlaygroundConfig = (env: NodeJS.ProcessEnv = process.env): PlaygroundConfig => ({
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
  visualRepairAttempts: nonNegativeInteger(env.SITES_DEV_VISUAL_REPAIR_ATTEMPTS, 0),
});

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
  #started = false;
  constructor(readonly config: PlaygroundConfig = loadPlaygroundConfig()) {
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
    this.product = createLocalPersistentSitesProduct({
      databasePath: join(config.dataRoot, "sites.sqlite"),
      runtimeDatabasePath: join(config.dataRoot, "runtime.sqlite"),
      artifactRoot: join(config.dataRoot, "artifacts"),
      executionRoot: join(config.dataRoot, "execution"),
      visualQAEnabled: true,
      visualQAMaxRepairAttempts: config.visualRepairAttempts ?? 0,
      // The failure fixture requires a repair pass; default playground sites must be usable.
      visualQaScenario: (config.visualRepairAttempts ?? 0) > 0,
      ...(realAgentComposition ?? {}),
    });
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
      await this.hosting.start();
      await this.runtimeGateway.start();
      this.#started = true;
    } catch (error) {
      // Both close operations are idempotent and prevent a partial startup from
      // leaving one of the local ports occupied.
      await Promise.allSettled([this.runtimeGateway.close(), this.hosting.close()]);
      throw error;
    }
  }
  generate(prompt: string) {
    return this.jobs.start("GENERATE", async (onIntelligence) => {
      const result = await this.product.orchestrator.generateWebsite({
        userId: this.userId,
        prompt,
        // Planning is deterministic by default so one click spends provider
        // capacity on coding rather than on an extra planning request.
        planningMode: this.config.agentPlanningEnabled ? "agent-with-fallback" : "deterministic",
        agentProvider: this.agentProviderId,
        visualQAEnabled: true,
        onIntelligence,
      });
      return {
        projectId: result.siteId,
        versionId: result.versionId,
        ...(result.intelligence ? { intelligence: result.intelligence } : {}),
      };
    });
  }
  async edit(siteId: string, prompt: string, baseVersionId?: string) {
    const project = await this.#project(siteId);
    const versionId = (baseVersionId ?? project.latestVersionId) as VersionId | undefined;
    if (!versionId) throw this.#error("VERSION_NOT_FOUND", "No base version exists");
    return this.jobs.start("EDIT", async (onIntelligence) => {
      const result = await this.product.orchestrator.editWebsite({
        userId: this.userId,
        siteId: siteId as SiteId,
        versionId,
        instruction: prompt,
        agentProvider: this.agentProviderId,
        agentPlanningEnabled: this.config.agentPlanningEnabled === true,
        visualQAEnabled: true,
        onIntelligence,
      });
      return {
        projectId: result.siteId,
        versionId: result.newVersionId,
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
  async deleteSite(siteId: string) {
    const project = await this.#project(siteId);
    if (this.jobs.hasActiveProject(project.id))
      throw this.#error("DEV_JOB_BUSY", "Wait for the active generation to finish before deleting");
    const activePreview = this.previews.list().find((session) => session.siteId === project.id);
    if (activePreview) await this.previews.stop(activePreview.id);
    await this.product.siteRuntime.deleteRuntime(project.id);
    const artifactKeys = this.product.database.deleteSite(project.id);
    await Promise.all(artifactKeys.map((key) => this.product.artifacts.delete(key)));
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
      visualQAStatus: version.visualQAStatus,
      visualQAScore: version.visualQAScore,
      runtimeSchemaVersion: version.runtimeSchemaVersion,
      published,
    };
  }
  #error(code: string, message: string) {
    return Object.assign(new Error(message), { code });
  }
}
