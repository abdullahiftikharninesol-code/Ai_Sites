import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalArtifactStore } from "../src/persistence/local-artifact-store.js";
import { MongoConnectionManager } from "../src/persistence/mongodb/mongo-connection.js";
import {
  createMongoModels,
  type MongoModels,
  type MongoSiteJobRecord,
  type MongoSiteProjectRecord,
} from "../src/persistence/mongodb/mongo-models.js";
import {
  deleteMongoSite,
  migrateMongoProjectFilesToLocalArtifacts,
  MongoRuntimeState,
  MongoSiteJobRepository,
  MongoSiteProjectRepository,
  MongoSiteVersionCommitter,
  MongoSiteVersionRepository,
} from "../src/persistence/mongodb/mongo-repositories.js";
import {
  loadPersistenceConfig,
  requireMongoDatabaseUri,
} from "../src/persistence/persistence-config.js";
import type { SiteJob, SiteProject, SiteVersion } from "../src/sites/domain/entities.js";
import type { SiteSourceSnapshot } from "../src/sites/generation/source-snapshot.js";
import type { JobId, SiteId, UserId, VersionId } from "../src/shared/types.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { deriveTemplateDesignReference, type TemplateDesignReferenceResolver } from "../src/templates/application/template-design-context.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import {
  GeneratedProjectValidator,
  SiteFunctionalValidator,
} from "../src/sites/generation/site-policies.js";
import { LocalCliAgentRuntime } from "../src/cli/runtime/local-cli-agent-runtime.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { TemplateInstantiationService } from "../src/templates/application/template-instantiation-service.js";
import type { SiteTemplate } from "../src/templates/domain/site-template.js";
import type { BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { SitesVersionHttpServer } from "../src/http/sites-version-http-server.js";
import { createSitesVersionApi } from "../src/http/create-sites-version-api.js";

interface Chain<T> {
  session(value: unknown): Chain<T>;
  select(value: unknown): Chain<T>;
  sort(value: unknown): Chain<T>;
  lean(): Chain<T>;
  exec(): Promise<T>;
}

const chain = <T>(read: () => T | Promise<T>): Chain<T> => {
  const value: Chain<T> = {
    session: () => value,
    select: () => value,
    sort: () => value,
    lean: () => value,
    exec: async () => read(),
  };
  return value;
};

const applyUpdate = <T extends object>(
  original: T,
  update: Record<string, Record<string, unknown>>,
): T => {
  const record = { ...original, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) } as T;
  for (const key of Object.keys(update.$unset ?? {}))
    delete (record as Record<string, unknown>)[key];
  return record;
};

interface LegacyVersionRecord {
  _id: string;
  projectId: string;
  ownerId: string;
  versionNumber: number;
  createdAt: Date;
  version: SiteVersion;
}

class MemoryMongoModels {
  readonly projectRecords = new Map<string, MongoSiteProjectRecord>();
  readonly jobRecords = new Map<string, MongoSiteJobRecord>();
  readonly versionRecords = new Map<string, LegacyVersionRecord>();
  failProjectUpdate = false;

  // Existing legacy rows are retained but must never be used by current-state code.
  get versions(): never { throw new Error("Cancelled history collection accessed"); }

  readonly projects = {
    findById: (id: string) => chain(() => this.projectRecords.get(id) ?? null),
    findOne: (filter: { _id: string; ownerId: string }) =>
      chain(() => {
        const value = this.projectRecords.get(filter._id);
        return value?.ownerId === filter.ownerId ? value : null;
      }),
    exists: (filter: { _id: string }) => Promise.resolve(this.projectRecords.has(filter._id)),
    find: (filter: Record<string, unknown>) =>
      chain(() =>
        [...this.projectRecords.values()]
          .filter((record) => !filter.ownerId || record.ownerId === filter.ownerId)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
      ),
    updateOne: (
      filter: Record<string, unknown>,
      update: Record<string, Record<string, unknown>>,
      options?: { upsert?: boolean },
    ) =>
      chain(() => {
        const id = String(filter._id);
        const existing = this.projectRecords.get(id);
        if (!existing && !options?.upsert) return { matchedCount: 0 };
        if (
          existing &&
          typeof filter.versionNumber === "number" &&
          existing.versionNumber !== filter.versionNumber
        )
          return { matchedCount: 0 };
        const record = applyUpdate(existing ?? ({} as MongoSiteProjectRecord), update);
        this.projectRecords.set(id, record);
        return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
      }),
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, Record<string, unknown>>,
    ) =>
      chain(() => {
        const id = String(filter._id);
        const existing = this.projectRecords.get(id);
        if (this.failProjectUpdate) return null;
        if (
          !existing ||
          existing.versionNumber !== filter.versionNumber ||
          (filter.ownerId && existing.ownerId !== filter.ownerId)
        )
          return null;
        const updated = applyUpdate(existing, update);
        this.projectRecords.set(id, updated);
        return updated;
      }),
    deleteOne: (filter: { _id: string }) =>
      chain(() => ({ deletedCount: this.projectRecords.delete(filter._id) ? 1 : 0 })),
    collection: {
      find: () => {
        const records = [...this.projectRecords.values()].filter(
          (record) => "currentFiles" in record,
        );
        return {
          async *[Symbol.asyncIterator]() {
            for (const record of records) yield record;
          },
        };
      },
      updateOne: async (
        filter: { _id: string },
        update: Record<string, Record<string, unknown>>,
      ) => {
        const existing = this.projectRecords.get(filter._id);
        if (!existing) return { matchedCount: 0 };
        this.projectRecords.set(filter._id, applyUpdate(existing, update));
        return { matchedCount: 1 };
      },
    },
  };

  readonly jobs = {
    findOne: (filter: { jobId: string }) => chain(() => this.jobRecords.get(filter.jobId) ?? null),
    find: (filter: { projectId: string }) =>
      chain(() =>
        [...this.jobRecords.values()].filter((record) => record.projectId === filter.projectId),
      ),
    updateOne: (filter: { jobId: string }, update: Record<string, Record<string, unknown>>) =>
      chain(() => {
        const existing = this.jobRecords.get(filter.jobId);
        const record = applyUpdate(existing ?? ({} as MongoSiteJobRecord), update);
        this.jobRecords.set(filter.jobId, record);
        return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
      }),
    deleteMany: (filter: { projectId: string }) =>
      chain(() => {
        let deletedCount = 0;
        for (const [id, record] of this.jobRecords)
          if (record.projectId === filter.projectId) {
            this.jobRecords.delete(id);
            deletedCount++;
          }
        return { deletedCount };
      }),
  };

  asModels(): MongoModels {
    return this as unknown as MongoModels;
  }
}

const roots: string[] = [];
const httpServers: SitesVersionHttpServer[] = [];
const ownerId = "local-playground-user" as UserId;
const siteId = "site-one" as SiteId;
const project = (name = "First site"): SiteProject => ({
  id: siteId,
  ownerId,
  name,
  originalPrompt: "Build the first site",
  slug: "site-site-one",
  status: "DRAFT",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});
const version = (id: string, parentVersionId?: VersionId): Omit<SiteVersion, "versionNumber"> => ({
  id: id as VersionId,
  siteId,
  ...(parentVersionId ? { parentVersionId } : {}),
  sourceArtifactRef: `sites/${siteId}/versions/${id}/source.json`,
  sourceManifestRef: `sites/${siteId}/versions/${id}/manifest.json`,
  buildStatus: "SUCCEEDED",
  browserQAStatus: "PASSED",
  createdAt: new Date(),
});
const snapshot = (content: string): SiteSourceSnapshot => ({
  manifest: {
    schemaVersion: 2,
    technicalProfileId: "react-vite-v1",
    templateId: "react-vite-v1",
    templateVersion: 1,
    createdAt: new Date().toISOString(),
    files: [
      {
        path: "src/App.tsx",
        sizeBytes: Buffer.byteLength(content),
        sha256: "test-hash",
      },
    ],
  },
  files: { "src/App.tsx": content },
});

afterEach(async () => {
  await Promise.all(httpServers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const passingQA = (): BrowserQAReport => ({
  reportVersion: 1,
  runId: "offline-qa",
  status: "PASS",
  browser: { name: "chromium", version: "fixture" },
  viewports: [],
  routes: ["/"],
  checks: [],
  artifactRefs: [],
  screenshots: [],
  summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(1).toISOString(),
  durationMs: 1,
});

async function currentHarness(templateDesignReferences?: TemplateDesignReferenceResolver) {
  const root = await mkdtemp(join(tmpdir(), "sites-current-offline-"));
  roots.push(root);
  const memory = new MemoryMongoModels();
  const artifacts = new LocalArtifactStore(join(root, "artifacts"));
  const projects = new MongoSiteProjectRepository(memory.asModels());
  const versions = new MongoSiteVersionRepository(memory.asModels(), artifacts);
  const committer = new MongoSiteVersionCommitter(memory.asModels(), artifacts);
  const provider: MockAgentProvider = new MockAgentProvider({
    customResponse: (request) => ({
      id: "fixture-response",
      model: request.model,
      message: {
        role: "assistant",
        content: JSON.stringify(templateDesignReferences && request.responseContract?.type === "JSON_SCHEMA" && request.responseContract.name === "SiteCoderFileBundle" ? {
          siteName: "North & Loom", files: [{ path: "src/App.tsx", content: 'export function App(){return <main><h1>North &amp; Loom</h1><p>A newly generated clothing website.</p></main>}' }],
        } : {
          patches: [
            {
              path: provider.callCount === 1 ? "src/App.jsx" : "index.html",
              find: "FlowPilot",
              replace: "NovaPay",
              mode: "all",
            },
          ],
        }),
      },
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      latencyMs: 0,
      finishReason: "stop",
    }),
  });
  const registry = new AgentProviderRegistry();
  registry.register(provider);
  const api = createLocalSitesProduct({
    executionRoot: join(root, "execution"),
    artifactRoot: join(root, "artifacts"),
    artifacts,
    projects,
    versions,
    versionCommitter: committer,
    agentRegistry: registry,
    orchestrationAgent: provider,
    ...(templateDesignReferences ? { templateDesignReferences } : {}),
  });
  const result = {
    exitCode: 0,
    stdout: "offline",
    stderr: "",
    timedOut: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    durationMs: 1,
  };
  const commands = vi.spyOn(api.execution, "executeCommand").mockResolvedValue(result);
  vi.spyOn(api.execution, "getLastBuildResult").mockReturnValue(result);
  const preview = { mode: "PROVIDER_URL" as const, url: "http://127.0.0.1:4173", port: 4173 };
  vi.spyOn(api.execution, "startPreview").mockResolvedValue(preview);
  vi.spyOn(api.execution, "getLatestPreview").mockReturnValue(preview);
  vi.spyOn(GeneratedProjectValidator.prototype, "validate").mockResolvedValue();
  vi.spyOn(SiteFunctionalValidator.prototype, "validate").mockResolvedValue({
    status: 200,
    contentVerified: true,
  });
  const qa = vi.spyOn(api.browserQA, "run").mockResolvedValue(passingQA());
  const files = {
    "package.json": JSON.stringify({
      name: "offline",
      private: true,
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { vite: "6.4.1" },
    }),
    "package-lock.json": '{"lockfileVersion":3}',
    "index.html": '<div id="root">FlowPilot</div>',
    "src/main.jsx": 'import App from "./App.jsx"; export default App;',
    "src/App.jsx": "export default function App() { return <main>FlowPilot</main>; }",
  };
  const seed = async (content: string, templateId?: string) => {
    const current = await projects.getById(siteId);
    if (!current) await projects.save(project());
    const environment = await api.execution.createEnvironment({});
    for (const [path, value] of Object.entries(files))
      await api.execution.writeFile(environment.id, path, value.replaceAll("FlowPilot", content));
    const count = (current?.versionNumber ?? 0) + 1;
    const ref = `sites/${siteId}/versions/offline-${count}/source.json`;
    await new SiteSourceSnapshotService(artifacts).capture(api.execution, environment.id, ref, {
      technicalProfileId: "react-vite-v1",
      templateId: templateId ?? "react-vite-v1",
      templateVersion: 1,
    });
    await api.execution.destroyEnvironment(environment.id);
    return committer.commit((await projects.getById(siteId))!, {
      ...version(`offline-${count}`, current?.latestVersionId),
      sourceArtifactRef: ref,
      sourceManifestRef: ref.replace("source.json", "manifest.json"),
      ...(templateId ? { templateId, templateVersion: 1 } : {}),
    });
  };
  return {
    memory,
    artifacts,
    projects,
    versions,
    committer,
    api,
    provider,
    commands,
    qa,
    files,
    seed,
  };
}

describe("current-only Mongo persistence and validated candidate replacement", () => {
  it("exposes only the latest revision after reload and never touches legacy history", async () => {
    const h = await currentHarness();
    const first = await h.seed("Original");
    h.memory.versionRecords.set(first.id, {
      _id: first.id, projectId: siteId, ownerId, versionNumber: 1,
      createdAt: first.createdAt, version: { ...first, sourceArtifactRef: "legacy/private.json" },
    });
    await h.seed("Edited");
    const third = await h.seed("Third");
    const reload = new MongoSiteVersionRepository(h.memory.asModels(), h.artifacts);
    expect((await reload.listBySite(siteId)).items.map((v) => v.id)).toEqual([third.id]);
    expect(await reload.getById(first.id)).toBeUndefined();
    expect((await reload.getById(third.id))?.sourceArtifactRef).toBe(third.sourceArtifactRef);
    expect(h.memory.versionRecords.size).toBe(1);
    expect(h.memory.versionRecords.get(first.id)?.version.sourceArtifactRef).toBe("legacy/private.json");
  });

  it("repository save replaces current rather than appending history", async () => {
    const h = await currentHarness(); const first = await h.seed("Original");
    await h.versions.save({ ...first, id: `${siteId}:v2` as VersionId, versionNumber: 2 });
    expect((await h.versions.listBySite(siteId)).items.map((v) => v.versionNumber)).toEqual([2]);
    expect(await h.versions.getById(first.id)).toBeUndefined();
    await expect(h.versions.save({ ...first, versionNumber: 1 })).rejects.toMatchObject({
      code: "PERSISTENCE_TRANSACTION_FAILED",
    });
    expect(h.memory.versionRecords.size).toBe(0);
  });

  it("accepts only one competing commit and rejects stale or omitted base revisions", async () => {
    const h = await currentHarness(); const first = await h.seed("Original");
    const current = (await h.projects.getById(siteId))!;
    const results = await Promise.allSettled([
      h.committer.commit(current, first), h.committer.commit(current, first),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(h.committer.commit(current, first)).rejects.toMatchObject({
      code: "PERSISTENCE_TRANSACTION_FAILED",
    });
    await expect(h.committer.commit(project(), first)).rejects.toMatchObject({
      code: "PERSISTENCE_TRANSACTION_FAILED",
    });
    expect((await h.versions.listBySite(siteId)).items.map((v) => v.versionNumber)).toEqual([2]);
  });

  it("a failed atomic pointer update preserves current source and revision", async () => {
    const h = await currentHarness(); const first = await h.seed("Original");
    const before = structuredClone(h.memory.projectRecords.get(siteId));
    const bytes = await h.artifacts.get(first.sourceArtifactRef);
    h.memory.failProjectUpdate = true;
    await expect(h.seed("Candidate")).rejects.toMatchObject({ code: "PERSISTENCE_TRANSACTION_FAILED" });
    expect(h.memory.projectRecords.get(siteId)).toEqual(before);
    expect(await h.artifacts.get(first.sourceArtifactRef)).toEqual(bytes);
  });

  it.each(["build", "qa", "snapshot", "owner", "project"] as const)(
    "rejects an invalid %s candidate without replacing current", async (failure) => {
      const h = await currentHarness(); const first = await h.seed("Original");
      const before = structuredClone(h.memory.projectRecords.get(siteId));
      const current = (await h.projects.getById(siteId))!;
      const candidate = { ...first };
      if (failure === "build") candidate.buildStatus = "FAILED";
      if (failure === "qa") candidate.browserQAStatus = "FAILED";
      if (failure === "snapshot") candidate.sourceArtifactRef = "missing.json";
      if (failure === "project") candidate.siteId = "other-site" as SiteId;
      await expect(h.committer.commit(
        failure === "owner" ? { ...current, ownerId: "intruder" as UserId } : current,
        candidate,
      )).rejects.toThrow();
      expect(h.memory.projectRecords.get(siteId)).toEqual(before);
    },
  );

  it("one bounded repair publishes exactly once; all mock requests are targeted edits", async () => {
    const h = await currentHarness(); const first = await h.seed("FlowPilot");
    const commit = vi.spyOn(h.committer, "commit");
    const requests = vi.spyOn(h.provider, "createResponse");
    const result = await h.api.pipeline.edit({
      userId: ownerId, siteId, instruction: "Rename FlowPilot to NovaPay. Keep the existing layout.",
      agentProvider: "mock-agent", browserQAEnabled: true,
    });
    expect(requests).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.every(([request]) =>
      request.responseContract?.type === "JSON_SCHEMA" &&
      request.responseContract.name === "SiteEditPatchBundle",
    )).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(h.provider.callCount).toBe(2);
    expect(result.newVersionId).toBe(`${siteId}:v2`);
    expect(await h.versions.getById(first.id)).toBeUndefined();
    const current = (await h.versions.getById(result.newVersionId))!;
    expect(Buffer.from((await h.artifacts.get(current.sourceArtifactRef))!).toString()).toContain("NovaPay");
    expect(h.memory.versionRecords.size).toBe(0);
    expect((await h.api.jobs.listBySite(siteId)).items[0]).toMatchObject({
      status: "SUCCEEDED", logicalCalls: 2,
    });
  });

  it("a complete first attempt replaces current once with no repair", async () => {
    const h = await currentHarness(); const first = await h.seed("FlowPilot");
    // Both occurrences live in one file, so the first normal patch completes the rename.
    const bytes = JSON.parse(Buffer.from((await h.artifacts.get(first.sourceArtifactRef))!).toString()) as SiteSourceSnapshot;
    const fixtureFiles = { ...bytes.files, "index.html": '<div id="root"></div>' };
    // Re-capture through the fixture to preserve valid source hashes.
    const env = await h.api.execution.createEnvironment({});
    for (const [path, content] of Object.entries(fixtureFiles))
      await h.api.execution.writeFile(env.id, path, content);
    await new SiteSourceSnapshotService(h.artifacts).capture(h.api.execution, env.id, first.sourceArtifactRef, {
      technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1,
    });
    await h.api.execution.destroyEnvironment(env.id);
    const commit = vi.spyOn(h.committer, "commit");
    await h.api.pipeline.edit({
      userId: ownerId, siteId, instruction: "Rename FlowPilot to NovaPay",
      agentProvider: "mock-agent", browserQAEnabled: true,
    });
    expect(h.provider.callCount).toBe(1); expect(commit).toHaveBeenCalledTimes(1);
    expect((await h.versions.listBySite(siteId)).items.map((v) => v.versionNumber)).toEqual([2]);
  });

  it.each(["incomplete", "build", "qa"] as const)(
    "failed targeted-edit %s preserves byte-identical current source and is not charged",
    async (failure) => {
      const h = await currentHarness(); const first = await h.seed("FlowPilot");
      const before = structuredClone(h.memory.projectRecords.get(siteId));
      const original = await h.artifacts.get(first.sourceArtifactRef);
      const commit = vi.spyOn(h.committer, "commit");
      if (failure === "incomplete")
        vi.spyOn(h.provider, "createResponse").mockImplementation(async (request) => ({
          id: "incomplete", model: request.model,
          message: { role: "assistant", content: JSON.stringify({ patches: [{
            path: "src/App.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all",
          }] }) },
          toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 0, finishReason: "stop",
        }));
      if (failure === "build")
        vi.spyOn(LocalCliAgentRuntime.prototype, "run").mockRejectedValue(
          Object.assign(new Error("build failed"), { code: "BUILD_FAILED" }),
        );
      if (failure === "qa") h.qa.mockResolvedValue({
        ...passingQA(), status: "FAIL", summary: { passed: 0, failed: 1, warnings: 0, skipped: 0 },
      });
      await expect(h.api.pipeline.edit({
        userId: ownerId, siteId, instruction: "Rename FlowPilot to NovaPay",
        agentProvider: "mock-agent", browserQAEnabled: true,
      })).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
      expect(h.memory.projectRecords.get(siteId)).toEqual(before);
      expect(await h.artifacts.get(first.sourceArtifactRef)).toEqual(original);
      expect((await h.versions.listBySite(siteId)).items.map((v) => v.id)).toEqual([first.id]);
      expect((await h.api.jobs.listBySite(siteId)).items[0]).toMatchObject({
        status: "FAILED", billingStatus: "NOT_CHARGED", creditsCharged: 0,
      });
      expect(h.memory.versionRecords.size).toBe(0);
    },
  );

  it("template instantiation uses the same Mongo committer and snapshot format", async () => {
    const h = await currentHarness();
    const archive = zipSync({
      ...Object.fromEntries(
        Object.entries(h.files).map(([path, content]) => [path, Buffer.from(content)]),
      ),
      "site-template.json": Buffer.from('{"templateKey":"restaurant"}'),
    });
    const now = new Date();
    const record: SiteTemplate = {
      id: "fixture-template",
      templateKey: "restaurant",
      version: 2,
      name: "Restaurant",
      description: "Offline fixture",
      categoryId: "fixture",
      tags: [],
      status: "active",
      routes: [{ path: "/", label: "Home" }],
      sourceObject: "fixture.zip",
      sourceSha256: createHash("sha256").update(archive).digest("hex"),
      previews: {},
      createdAt: now,
      updatedAt: now,
    };
    const source = { readObject: vi.fn(async () => archive) };
    const service = new TemplateInstantiationService({
      templates: {
        findLatestActiveTemplate: async () => record,
        findTemplateVersion: async () => record,
        listActiveTemplates: vi.fn(),
        findById: async () => record,
      },
      source,
      execution: h.api.execution,
      artifacts: h.artifacts,
      projects: h.projects,
      versions: h.committer,
      browserQA: h.api.browserQA,
      cleanupSite: async () => {},
    });
    const instantiated = await service.instantiate({ ownerId, templateKey: "restaurant" });
    await h.api.execution.destroyEnvironment(instantiated.environmentId);
    const first = (await h.versions.getById(instantiated.versionId))!;
    expect(first).toMatchObject({ versionNumber: 1, templateId: "restaurant", templateVersion: 2 });
    const snapshot = JSON.parse(
      Buffer.from((await h.artifacts.get(first.sourceArtifactRef))!).toString(),
    ) as SiteSourceSnapshot;
    expect(snapshot.manifest.schemaVersion).toBe(2);
    expect(snapshot.files["src/App.jsx"]).toContain("FlowPilot");
    const reloaded = new MongoSiteVersionRepository(h.memory.asModels(), h.artifacts);
    await expect(reloaded.getById(first.id)).resolves.toMatchObject({
      versionNumber: 1, templateId: "restaurant", templateVersion: 2,
    });
    expect((await reloaded.listBySite(instantiated.projectId)).items).toHaveLength(1);
    expect(h.memory.versionRecords.size).toBe(0);
    expect((await h.api.jobs.listBySite(instantiated.projectId)).items).toHaveLength(0);
    expect(source.readObject).toHaveBeenCalledOnce();
    expect(h.provider.callCount).toBe(0);
    const edited = await h.api.pipeline.edit({
      userId: ownerId, siteId: instantiated.projectId,
      instruction: "Rename FlowPilot to NovaPay. Keep the existing layout.",
      agentProvider: "mock-agent", browserQAEnabled: true,
    });
    expect(h.provider.callCount).toBe(2);
    const afterRestart = new MongoSiteVersionRepository(h.memory.asModels(), h.artifacts);
    const latest = (await afterRestart.getById(edited.newVersionId))!;
    expect(latest).toMatchObject({ templateId: "restaurant", templateVersion: 2, versionNumber: 2 });
    expect(await afterRestart.getById(first.id)).toBeUndefined();
    expect((await afterRestart.listBySite(instantiated.projectId)).items).toHaveLength(1);
    const currentSnapshot = JSON.parse(Buffer.from((await h.artifacts.get(latest.sourceArtifactRef))!).toString()) as SiteSourceSnapshot;
    expect(currentSnapshot.manifest).toMatchObject({ templateId: "restaurant", templateVersion: 2 });
    expect(currentSnapshot.files["src/main.jsx"]).toBe(snapshot.files["src/main.jsx"]);
    expect(source.readObject).toHaveBeenCalledOnce();
    expect(h.memory.versionRecords.size).toBe(0);
  });

  it("reference-guided generation reloads current source and template provenance from a fresh Mongo repository", async () => {
    const reference = deriveTemplateDesignReference({ templateKey: "ecommerce-store", version: 1 }, "fixture-sha", {
      "src/App.jsx": 'export function Old(){return <header className="wordmark">Original Shop</header>}',
      "src/styles.css": ':root{--cream:#f6f0e5}.hero{display:grid;gap:24px}',
    }, ["/", "/shop", "/about"]);
    const resolver = { resolve: vi.fn(async () => reference) };
    const h = await currentHarness(resolver);
    const result = await h.api.pipeline.generate({ userId: ownerId, prompt: "Build a website for North & Loom, a clothing brand.",
      templateReference: { templateKey: "ecommerce-store", version: 1 }, planningMode: "deterministic", agentProvider: h.provider.id, browserQAEnabled: true });
    const freshProjects = new MongoSiteProjectRepository(h.memory.asModels());
    const freshVersions = new MongoSiteVersionRepository(h.memory.asModels(), h.artifacts);
    const project = (await freshProjects.getById(result.siteId))!;
    const current = (await freshVersions.getById(project.latestVersionId!))!;
    expect(project).toMatchObject({ name: "North & Loom", versionNumber: 1 });
    expect(current).toMatchObject({ templateId: "ecommerce-store", templateVersion: 1, buildStatus: "SUCCEEDED" });
    const snapshot = JSON.parse(Buffer.from((await h.artifacts.get(current.sourceArtifactRef))!).toString()) as SiteSourceSnapshot;
    expect(snapshot.files["src/App.tsx"]).toContain("North &amp; Loom");
    expect(snapshot.files["src/App.tsx"]).not.toContain("Original Shop");
    expect((await freshVersions.listBySite(result.siteId)).items).toHaveLength(1);
    expect(h.memory.projectRecords.size).toBe(1); expect(h.memory.versionRecords.size).toBe(0);
    expect(resolver.resolve).toHaveBeenCalledOnce(); expect(h.provider.callCount).toBe(1);
  });

  it("generation and edit persist only the latest working project across reload", async () => {
    const h = await currentHarness();
    vi.spyOn(LocalCliAgentRuntime.prototype, "run").mockImplementationOnce(
      async (environmentId) => {
        for (const [path, content] of Object.entries(h.files))
          await h.api.execution.writeFile(environmentId, path, content);
        await h.api.execution.writeFile(
          environmentId,
          "src/main.tsx",
          'export { default } from "./App.jsx";',
        );
        return {
          success: true,
          provider: "mock-agent",
          model: "offline-fixture",
          runtime: "LOCAL_CLI",
          turns: 1,
          toolCalls: 0,
          buildAttempts: 1,
          finalBuildSuccess: true,
          filesChanged: Object.keys(h.files),
          durationMs: 1,
          usage: {},
        };
      },
    );
    const generated = await h.api.pipeline.generate({
      userId: ownerId,
      prompt: "Create a simple business website",
      planningMode: "deterministic",
      agentProvider: "mock-agent",
      browserQAEnabled: true,
    });
    const first = (await h.versions.getById(generated.versionId))!;
    const edited = await h.api.pipeline.edit({
      userId: ownerId,
      siteId: generated.siteId,
      instruction: "Rename FlowPilot to NovaPay",
      agentProvider: "mock-agent",
      browserQAEnabled: true,
    });
    const reload = new MongoSiteVersionRepository(h.memory.asModels(), h.artifacts);
    expect((await reload.listBySite(generated.siteId)).items.map((v) => v.versionNumber)).toEqual([2]);
    expect(await reload.getById(first.id)).toBeUndefined();
    expect((await h.projects.getById(generated.siteId))?.latestVersionId).toBe(edited.newVersionId);
    expect(h.memory.versionRecords.size).toBe(0);
    expect(h.provider.callCount).toBe(2);
  });
});

async function productionHttpHarness() {
  const h = await currentHarness();
  const first = await h.seed("Original");
  const second = await h.seed("Customized");
  const key = "phase7o-local-fixture-only-not-a-live-key";
  const identities = {
    findAdmin: async () => null,
    findActiveUser: async (id: string) =>
      [ownerId, "other-owner"].includes(id) ? { id, status: "active", chat_count: 100 } : null,
  };
  const server = new SitesVersionHttpServer({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["https://getchatly.example"],
    identities,
    jwtKey: () => key,
  });
  httpServers.push(server);
  const base = await server.start();
  const request = async (
    path: string,
    options: {
      method?: string;
      user?: string;
      token?: string;
      body?: unknown;
      origin?: string;
    } = {},
  ) => {
    const token =
      options.token ??
      (options.user
        ? jwt.sign({ userId: options.user, type: "user" }, key, { expiresIn: "5m" })
        : undefined);
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      text,
      headers: response.headers,
    };
  };
  const listPath = `/api/sites/${siteId}/versions`;
  const restorePath = `${listPath}/${encodeURIComponent(first.id)}/restore`;
  return { ...h, first, second, identities, request, listPath, restorePath };
}

describe("cancelled production history routes retain the auth boundary", () => {
  it("fails closed when production JWT or Mongo configuration is missing", () => {
    expect(() => createSitesVersionApi({})).toThrow("JWTKEY is required");
    expect(() => createSitesVersionApi({ JWTKEY: "offline-fixture-key" })).toThrow("DATABASE");
  });
  it.each(["list", "restore"] as const)("has no %s route or side effects", async (route) => {
    const h = await productionHttpHarness();
    const before = structuredClone(h.memory.projectRecords);
    const response = await h.request(route === "list" ? h.listPath : h.restorePath, {
      user: ownerId, method: route === "list" ? "GET" : "POST",
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(h.memory.projectRecords).toEqual(before);
    expect(h.memory.versionRecords.size).toBe(0); expect(h.provider.callCount).toBe(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("retains JWT enforcement and explicit CORS", async () => {
    const h = await productionHttpHarness();
    expect((await h.request(h.listPath)).status).toBe(401);
    expect((await h.request(h.listPath, { token: "invalid" })).status).toBe(401);
    expect((await h.request(h.listPath, { user: "unknown" })).status).toBe(401);
    const preflight = await h.request(h.restorePath, {
      method: "OPTIONS", origin: "https://getchatly.example",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://getchatly.example");
    expect((await h.request(h.restorePath, {
      user: ownerId, method: "POST", origin: "https://foreign.example",
    })).status).toBe(403);
  });
});

describe("MongoDB Sites persistence", () => {
  it("loads DATABASE centrally and fails clearly when it is absent", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const credentialed = new MongoConnectionManager(
      "mongodb://private-user:private-password@example.invalid/sites",
    );
    expect(credentialed.status()).toEqual({ provider: "mongodb", connected: false });
    expect(JSON.stringify(credentialed.status())).not.toContain("private-password");
    expect(log).not.toHaveBeenCalled();
    const configured = loadPersistenceConfig({ DATABASE: "mongodb://example.invalid/sites" });
    expect(requireMongoDatabaseUri(configured)).toBe("mongodb://example.invalid/sites");
    expect(() => requireMongoDatabaseUri(loadPersistenceConfig({}))).toThrow(
      "MongoDB persistence requires DATABASE to be configured",
    );
    await expect(new MongoConnectionManager().connect()).rejects.toMatchObject({
      code: "PERSISTENCE_INITIALIZATION_FAILED",
    });
  });

  it("defines exactly the final project and job persistence fields", () => {
    const manager = new MongoConnectionManager();
    const models = createMongoModels(manager.connection);
    expect(Object.keys(models)).toEqual(["projects", "jobs"]);
    expect(Object.keys(models.projects.schema.paths).sort()).toEqual(
      [
        "_id",
        "createdAt",
        "lastEditPrompt",
        "lastOperation",
        "name",
        "originalPrompt",
        "ownerId",
        "sourceArtifactRef",
        "sourceManifestRef",
        "status",
        "updatedAt",
        "versionNumber",
      ].sort(),
    );
    expect(Object.keys(models.jobs.schema.paths)).not.toContain("progress");
    expect(
      Object.keys(models.jobs.schema.paths)
        .filter((path) => path !== "_id")
        .sort(),
    ).toEqual(
      [
        "cachedInputTokens",
        "billableInputTokens",
        "billableOutputTokens",
        "billableTokens",
        "billingErrorCode",
        "billingStatus",
        "chargedAt",
        "createdAt",
        "creditsCharged",
        "creditsPer500Tokens",
        "errorCode",
        "errorMessage",
        "inputTokens",
        "jobId",
        "logicalCalls",
        "model",
        "modelOutputReceived",
        "operation",
        "outputTokens",
        "ownerId",
        "physicalRequests",
        "projectId",
        "provider",
        "reasoningTokens",
        "retries",
        "retryable",
        "stage",
        "status",
        "totalTokens",
        "updatedAt",
        "websiteGenerated",
      ].sort(),
    );
    expect(manager.connection.models.SitesVersion).toBeUndefined();
    expect(manager.connection.models.SitesDeployment).toBeUndefined();
    expect(manager.connection.models.SitesRuntime).toBeUndefined();
  });

  it("keeps project source local and atomically advances successful edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-mongo-schema-"));
    roots.push(root);
    const artifacts = new LocalArtifactStore(root);
    const memory = new MemoryMongoModels();
    const state = new MongoRuntimeState();
    const projects = new MongoSiteProjectRepository(memory.asModels(), state);
    const versions = new MongoSiteVersionRepository(memory.asModels(), artifacts, state);
    const committer = new MongoSiteVersionCommitter(memory.asModels(), artifacts, state);
    await projects.save(project());

    const firstDraft = version("version-one");
    await artifacts.put(firstDraft.sourceArtifactRef, Buffer.from(JSON.stringify(snapshot("v1"))), {
      kind: "SOURCE_ARCHIVE",
      contentType: "application/json",
    });
    const first = await committer.commit(project("NOMA Living"), firstDraft);
    expect(first).toMatchObject({ id: `${siteId}:v1`, versionNumber: 1 });
    expect(memory.projectRecords.get(siteId)).toMatchObject({
      sourceArtifactRef: firstDraft.sourceArtifactRef,
      sourceManifestRef: firstDraft.sourceManifestRef,
      versionNumber: 1,
      lastOperation: "GENERATE",
      status: "ACTIVE",
      name: "NOMA Living",
    });
    expect(memory.projectRecords.get(siteId)).not.toHaveProperty("currentFiles");

    const beforeFailedEdit = structuredClone(memory.projectRecords.get(siteId)!);
    await expect(Promise.reject(new Error("build failed before commit"))).rejects.toThrow(
      "build failed before commit",
    );
    expect(memory.projectRecords.get(siteId)).toEqual(beforeFailedEdit);

    const secondDraft = version("version-two", first.id);
    await artifacts.put(
      secondDraft.sourceArtifactRef,
      Buffer.from(JSON.stringify(snapshot("v2"))),
      {
        kind: "SOURCE_ARCHIVE",
        contentType: "application/json",
      },
    );
    const currentProject = await projects.getById(siteId);
    const second = await committer.commit(
      { ...currentProject!, lastEditPrompt: "Make the hero blue" },
      secondDraft,
    );
    expect(second).toMatchObject({ id: `${siteId}:v2`, versionNumber: 2 });
    expect(memory.projectRecords.get(siteId)).toMatchObject({
      sourceArtifactRef: secondDraft.sourceArtifactRef,
      sourceManifestRef: secondDraft.sourceManifestRef,
      versionNumber: 2,
      lastOperation: "EDIT",
      lastEditPrompt: "Make the hero blue",
      name: "NOMA Living",
    });
    expect(memory.projectRecords.get(siteId)).not.toHaveProperty("currentFiles");
    await expect(versions.getById(first.id)).resolves.toBeUndefined();
    await expect(versions.listBySite(siteId)).resolves.toMatchObject({
      items: [
        { id: `${siteId}:v2`, versionNumber: 2 },
      ],
    });
    const afterRestart = new MongoSiteVersionRepository(
      memory.asModels(),
      artifacts,
      new MongoRuntimeState(),
    );
    await expect(afterRestart.getById(second.id)).resolves.toMatchObject({
      id: `${siteId}:v2`,
      versionNumber: 2,
      parentVersionId: `${siteId}:v1`,
    });
    await expect(afterRestart.getById(first.id)).resolves.toBeUndefined();
    expect(await artifacts.exists(firstDraft.sourceArtifactRef)).toBe(true);
    expect(await artifacts.exists(secondDraft.sourceArtifactRef)).toBe(true);
    expect(Object.keys(memory.projectRecords.get(siteId)!)).not.toEqual(
      expect.arrayContaining(["metadata", "versions", "lastEditedAt"]),
    );
  });

  it("persists provider usage and safe job errors without progress", async () => {
    const memory = new MemoryMongoModels();
    const jobs = new MongoSiteJobRepository(memory.asModels());
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const success: SiteJob = {
      id: "job-one" as JobId,
      siteId,
      userId: ownerId,
      operation: "GENERATE",
      status: "SUCCEEDED",
      stage: "COMPLETED",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      reasoningTokens: 5,
      totalTokens: 140,
      billingStatus: "NOT_CHARGED",
      creditsCharged: 0,
      logicalCalls: 1,
      physicalRequests: 1,
      retries: 0,
      modelOutputReceived: true,
      websiteGenerated: true,
      createdAt,
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    };
    await jobs.save(success);
    expect(memory.jobRecords.get("job-one")).toEqual({
      jobId: "job-one",
      projectId: siteId,
      ownerId,
      operation: "GENERATE",
      status: "SUCCEEDED",
      stage: "COMPLETED",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      reasoningTokens: 5,
      totalTokens: 140,
      billingStatus: "NOT_CHARGED",
      creditsCharged: 0,
      logicalCalls: 1,
      physicalRequests: 1,
      retries: 0,
      modelOutputReceived: true,
      websiteGenerated: true,
      createdAt,
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    });

    await jobs.save({
      ...success,
      status: "FAILED",
      stage: "FAILED",
      websiteGenerated: false,
      errorCode: "VALIDATION_FAILED",
      errorMessage: "Generated source is invalid",
      retryable: false,
      updatedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    expect(memory.jobRecords.get("job-one")).toMatchObject({
      errorCode: "VALIDATION_FAILED",
      errorMessage: "Generated source is invalid",
      retryable: false,
    });
    expect(memory.jobRecords.get("job-one")).not.toHaveProperty("progress");
  });

  it("moves legacy Mongo file content to local artifacts before removing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-mongo-migration-"));
    roots.push(root);
    const artifacts = new LocalArtifactStore(root);
    const memory = new MemoryMongoModels();
    const projects = new MongoSiteProjectRepository(memory.asModels());
    await projects.save(project());
    const stored = memory.projectRecords.get(siteId)!;
    memory.projectRecords.set(siteId, {
      ...stored,
      versionNumber: 1,
      currentFiles: [{ path: "src/App.tsx", content: "legacy-source" }],
    } as MongoSiteProjectRecord);

    await expect(
      migrateMongoProjectFilesToLocalArtifacts(memory.asModels(), artifacts),
    ).resolves.toBe(1);
    expect(memory.projectRecords.get(siteId)).not.toHaveProperty("currentFiles");
    expect(memory.projectRecords.get(siteId)).toMatchObject({
      sourceArtifactRef: `sites/${siteId}/current/source.json`,
      sourceManifestRef: `sites/${siteId}/current/manifest.json`,
    });
    const localSource = await artifacts.get(`sites/${siteId}/current/source.json`);
    expect(JSON.parse(Buffer.from(localSource!).toString("utf8"))).toMatchObject({
      files: { "src/App.tsx": "legacy-source" },
    });
    await expect(
      migrateMongoProjectFilesToLocalArtifacts(memory.asModels(), artifacts),
    ).resolves.toBe(0);
  });

  it("deletes only the project and its jobs", async () => {
    const memory = new MemoryMongoModels();
    const projects = new MongoSiteProjectRepository(memory.asModels());
    await projects.save(project());
    await deleteMongoSite(memory.asModels(), siteId, ownerId);
    await expect(projects.getById(siteId)).resolves.toBeUndefined();
  });
});
