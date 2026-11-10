import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalArtifactStore } from "../src/persistence/local-artifact-store.js";
import { MongoRuntimeState, MongoSiteProjectRepository, MongoSiteVersionCommitter, MongoSiteVersionRepository } from "../src/persistence/mongodb/mongo-repositories.js";
import type { MongoModels } from "../src/persistence/mongodb/mongo-models.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService, type SiteSourceSnapshot } from "../src/sites/generation/source-snapshot.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { LocalExecutionProvider } from "../src/execution/local/local-execution.provider.js";
import { DevelopmentPreviewManager } from "../src/dev-server/development-preview-manager.js";
import { PROCESS_BOOT_ID, WORKSPACE_MARKER } from "../src/execution/local/workspace-ownership.js";
import { isProcessAlive, ORPHAN_CANDIDATE_MARKER, reconcileExecutionWorkspaces, RECONCILIATION_REPORT } from "../src/execution/local/workspace-reconciliation.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteProject, SiteVersion } from "../src/sites/domain/entities.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
const temp = async (prefix: string) => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };

/** A verified source snapshot (correct size + SHA-256 per file), optionally with a binary asset. */
function snapshot(files: Record<string, string | Buffer>): SiteSourceSnapshot {
  const entries = Object.entries(files).map(([path, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return { path, bytes, encoding: Buffer.isBuffer(value) ? "base64" as const : undefined };
  });
  return {
    manifest: { schemaVersion: 2, technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1, createdAt: new Date(0).toISOString(),
      files: entries.map(({ path, bytes, encoding }) => ({ path, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), ...(encoding ? { encoding } : {}) })) },
    files: Object.fromEntries(entries.map(({ path, bytes, encoding }) => [path, encoding ? bytes.toString("base64") : bytes.toString("utf8")])),
  };
}

/** Minimal in-memory stand-in for the Mongoose project model (same CAS semantics as the real filter). */
function memoryModels() {
  const records = new Map<string, Record<string, unknown>>();
  const chain = <T>(read: () => T) => { const value = { lean: () => value, exec: async () => structuredClone(read()) }; return value; };
  const apply = (record: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
    const next = { ...record, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
    for (const key of Object.keys(update.$unset ?? {})) delete next[key];
    return next;
  };
  const projects = {
    findById: (id: string) => chain(() => records.get(id) ?? null),
    findOne: (filter: { _id: string; ownerId: string }) => chain(() => { const value = records.get(filter._id); return value?.ownerId === filter.ownerId ? value : null; }),
    exists: (filter: { _id: string }) => Promise.resolve(records.has(filter._id)),
    updateOne: (filter: { _id: string }, update: Record<string, Record<string, unknown>>, options?: { upsert?: boolean }) => chain(() => {
      const existing = records.get(filter._id);
      if (!existing && !options?.upsert) return { matchedCount: 0 };
      records.set(filter._id, apply(existing ?? {}, update)); return { matchedCount: existing ? 1 : 0 };
    }),
    findOneAndUpdate: (filter: { _id: string; ownerId?: string; versionNumber: number }, update: Record<string, Record<string, unknown>>) => chain(() => {
      const existing = records.get(filter._id);
      if (!existing || existing.versionNumber !== filter.versionNumber || (filter.ownerId && existing.ownerId !== filter.ownerId)) return null;
      const next = apply(existing, update); records.set(filter._id, next); return next;
    }),
  };
  return { models: { projects } as unknown as MongoModels, records };
}

async function harness() {
  const root = await temp("sites-storage-recovery-");
  const artifacts = new LocalArtifactStore(join(root, "artifacts"));
  const { models, records } = memoryModels();
  const state = new MongoRuntimeState();
  const projects = new MongoSiteProjectRepository(models, state);
  const versions = new MongoSiteVersionRepository(models, artifacts, state);
  const committer = new MongoSiteVersionCommitter(models, artifacts, state);
  const ai = new MockAgentProvider(); const createResponse = vi.spyOn(ai, "createResponse");
  const registry = new AgentProviderRegistry(); registry.register(ai);
  const billing = { preflight: vi.fn(), finalizeSuccessfulJob: vi.fn() };
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), artifacts, projects, versions,
    versionCommitter: committer, agentRegistry: registry, orchestrationAgent: ai, billing: billing as unknown as SiteCreditBillingService, execution: new MockExecutionProvider() as never });
  const siteId = "site-recovery" as SiteId, ownerId = "owner-a" as UserId;
  const put = async (ref: string, value: SiteSourceSnapshot | Buffer) =>
    artifacts.put(ref, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), { kind: "SOURCE_ARCHIVE", contentType: "application/json" });
  const refFor = (label: string) => `sites/${siteId}/versions/${label}/source.json`;
  const now = new Date();
  await projects.save({ id: siteId, ownerId, name: "Recovery", slug: "recovery", status: "ACTIVE", createdAt: now, updatedAt: now });
  /** Commits a verified version through the real Mongo compare-and-swap committer (like a generation/edit). */
  const commit = async (label: string, files: Record<string, string | Buffer>) => {
    await put(refFor(label), snapshot(files));
    const project = (await projects.getById(siteId))!;
    return committer.commit(project, { id: label as VersionId, siteId, sourceArtifactRef: refFor(label), buildStatus: "SUCCEEDED", browserQAStatus: "PASSED", createdAt: new Date() });
  };
  const listArtifacts = async () => (await readdir(join(root, "artifacts"), { recursive: true })).sort();
  return { root, artifacts, projects, versions, committer, product, records, siteId, ownerId, commit, put, refFor, createResponse, billing, listArtifacts };
}
const rollback = (h: Awaited<ReturnType<typeof harness>>, expected: string) =>
  h.product.pipeline.rollbackToPreviousVersion({ siteId: h.siteId, ownerId: h.ownerId, expectedVersionId: expected as VersionId });

describe("Previous-version recovery (Mongo current-state model, real CAS committer)", () => {
  it("retains exactly one recoverable previous version reference, atomically with each commit", async () => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    expect(h.records.get(h.siteId)?.previousVersion).toBeUndefined();
    await h.commit("b", { "src/App.tsx": "export const v = 2;" });
    const current = (await h.versions.getById(`${h.siteId}:v2` as VersionId))!;
    expect(current.parentVersionId).toBe(`${h.siteId}:v1`);
    expect((await h.versions.getById(`${h.siteId}:v1` as VersionId))?.sourceArtifactRef).toBe(h.refFor("a"));
    await h.commit("c", { "src/App.tsx": "export const v = 3;" });
    expect((await h.versions.getById(`${h.siteId}:v2` as VersionId))?.sourceArtifactRef).toBe(h.refFor("b"));
    expect(await h.versions.getById(`${h.siteId}:v1` as VersionId)).toBeUndefined();
    // Retaining a reference never deletes the older artifact.
    expect(await h.artifacts.exists(h.refFor("a"))).toBe(true);
  });

  it("rolls back one step without AI, build or charge, reusing the previous artifacts; the rollback itself is undoable", async () => {
    const h = await harness();
    const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await h.commit("a", { "src/App.tsx": "export const v = 1;", "public/logo.png": logo });
    await h.commit("b", { "src/App.tsx": "export const v = 2;" });
    const before = await h.listArtifacts();
    const restored = await rollback(h, `${h.siteId}:v2`);
    expect(restored).toMatchObject({ version: { versionNumber: 3, sourceArtifactRef: h.refFor("a"), changeSummary: ["Restored version 1"] }, restoredFromVersionId: `${h.siteId}:v1` });
    const project = (await h.projects.getById(h.siteId))!;
    expect(project).toMatchObject({ latestVersionId: `${h.siteId}:v3`, lastOperation: "ROLLBACK" });
    // The replaced version stays recoverable, and both versions' sources (incl. the binary asset) are intact.
    expect((await h.versions.getById(`${h.siteId}:v2` as VersionId))?.sourceArtifactRef).toBe(h.refFor("b"));
    const verified = await new SiteSourceSnapshotService(h.artifacts).verify(h.refFor("a"));
    expect(Buffer.from(verified.files["public/logo.png"]!, "base64")).toEqual(logo);
    expect(await h.listArtifacts()).toEqual(before.concat().sort()); // no copies, nothing removed
    const undo = await rollback(h, `${h.siteId}:v3`);
    expect(undo.version).toMatchObject({ versionNumber: 4, sourceArtifactRef: h.refFor("b") });
    expect(h.createResponse).not.toHaveBeenCalled();
    expect(h.billing.preflight).not.toHaveBeenCalled(); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
  });

  it.each([
    ["corrupted", async (h: Awaited<ReturnType<typeof harness>>) => h.put(h.refFor("a"), Buffer.from("{not json"))],
    ["tampered", async (h: Awaited<ReturnType<typeof harness>>) => {
      const value = snapshot({ "src/App.tsx": "export const v = 1;" });
      await h.put(h.refFor("a"), { ...value, files: { "src/App.tsx": "export const v = 666;" } });
    }],
    ["missing", async (h: Awaited<ReturnType<typeof harness>>) => { await h.artifacts.delete(h.refFor("a")); }],
  ] as const)("a %s previous snapshot is refused and the current version is preserved", async (_name, damage) => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    await h.commit("b", { "src/App.tsx": "export const v = 2;" });
    const before = structuredClone(h.records.get(h.siteId));
    await damage(h);
    const failure = await rollback(h, `${h.siteId}:v2`).then(() => ({ code: "RESOLVED", message: "" }), (error: unknown) => error as { code: string; message: string });
    expect(failure).toMatchObject({ code: "ROLLBACK_SOURCE_UNAVAILABLE" });
    expect(failure.message).not.toMatch(/sites\/|source\.json|[A-Z]:\\/);
    expect(h.records.get(h.siteId)).toEqual(before);
    expect((await h.projects.getById(h.siteId))?.latestVersionId).toBe(`${h.siteId}:v2`);
  });

  it("refuses when there is nothing to restore", async () => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    await expect(rollback(h, `${h.siteId}:v1`)).rejects.toMatchObject({ code: "ROLLBACK_UNAVAILABLE" });
    await expect(h.product.pipeline.rollbackToPreviousVersion({ siteId: h.siteId, ownerId: "intruder", expectedVersionId: `${h.siteId}:v1` as VersionId }))
      .rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
  });

  it("an edit that commits during a rollback wins cleanly; neither silently overwrites the other", async () => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    await h.commit("b", { "src/App.tsx": "export const v = 2;" });
    const staleProject = (await h.projects.getById(h.siteId))!;
    await h.put(h.refFor("edit"), snapshot({ "src/App.tsx": "export const v = 'edit';" }));
    const get = h.artifacts.get.bind(h.artifacts);
    let raced = false;
    vi.spyOn(h.artifacts, "get").mockImplementation(async ref => {
      if (!raced && ref === h.refFor("a")) {
        raced = true; // An edit job commits while the rollback is verifying the previous snapshot.
        await h.committer.commit(staleProject, { id: "edit" as VersionId, siteId: h.siteId, sourceArtifactRef: h.refFor("edit"), buildStatus: "SUCCEEDED", createdAt: new Date() });
      }
      return get(ref);
    });
    await expect(rollback(h, `${h.siteId}:v2`)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(h.records.get(h.siteId)).toMatchObject({ versionNumber: 3, sourceArtifactRef: h.refFor("edit"), lastOperation: "EDIT" });
    // A late edit based on the pre-rollback version cannot overwrite a completed rollback either.
    vi.restoreAllMocks();
    const beforeRollback = (await h.projects.getById(h.siteId))!;
    await rollback(h, `${h.siteId}:v3`);
    await expect(h.committer.commit(beforeRollback, { id: "late" as VersionId, siteId: h.siteId, sourceArtifactRef: h.refFor("edit"), buildStatus: "SUCCEEDED", createdAt: new Date() }))
      .rejects.toMatchObject({ code: "PERSISTENCE_TRANSACTION_FAILED" });
    expect(h.records.get(h.siteId)).toMatchObject({ versionNumber: 4, lastOperation: "ROLLBACK" });
  });

  it("two concurrent rollbacks of the same version: exactly one applies", async () => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    await h.commit("b", { "src/App.tsx": "export const v = 2;" });
    const results = await Promise.allSettled([rollback(h, `${h.siteId}:v2`), rollback(h, `${h.siteId}:v2`)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
    expect(h.records.get(h.siteId)?.versionNumber).toBe(3);
  });

  it("preview restoration only reads persisted source", async () => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    const before = await readFile(join(h.root, "artifacts", ...h.refFor("a").split("/")));
    const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
    await new SiteSourceSnapshotService(h.artifacts).restore(execution as never, environment.id, h.refFor("a"));
    await execution.writeFile(environment.id, "src/App.tsx", "changed in the preview workspace");
    expect(await readFile(join(h.root, "artifacts", ...h.refFor("a").split("/")))).toEqual(before);
  });
});

describe("Local (non-Mongo) persistence keeps the same rollback guarantees", () => {
  it("carries the previous asset manifest reference and refuses when it is missing", async () => {
    const root = await temp("sites-local-rollback-");
    const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), execution: new MockExecutionProvider() as never });
    const siteId = "local-site" as SiteId, ownerId = "owner" as UserId, now = new Date();
    const save = async (id: string, number: number, parent?: string, asset?: string) => {
      const ref = `sites/${siteId}/versions/${id}/source.json`;
      await product.artifacts.put(ref, Buffer.from(JSON.stringify(snapshot({ "src/App.tsx": `export const v = ${number};` }))), { kind: "SOURCE_ARCHIVE", contentType: "application/json" });
      if (asset) await product.artifacts.put(asset, Buffer.from("{}"), { kind: "GENERATED_ASSET", contentType: "application/json" });
      const version: SiteVersion = { id: id as VersionId, siteId, versionNumber: number, sourceArtifactRef: ref, buildStatus: "SUCCEEDED", createdAt: now,
        ...(parent ? { parentVersionId: parent as VersionId } : {}), ...(asset ? { assetManifestArtifactRef: asset } : {}) };
      await product.versions.save(version);
    };
    const asset = `sites/${siteId}/versions/v1/generated-asset/manifest.json`;
    await save("v1", 1, undefined, asset); await save("v2", 2, "v1");
    const project: SiteProject = { id: siteId, ownerId, name: "Local", slug: "local", status: "ACTIVE", latestVersionId: "v2" as VersionId, createdAt: now, updatedAt: now };
    await product.projects.save(project);
    const restored = await product.pipeline.rollbackToPreviousVersion({ siteId, ownerId, expectedVersionId: "v2" as VersionId });
    expect(restored.version).toMatchObject({ versionNumber: 3, assetManifestArtifactRef: asset, parentVersionId: "v2" });
    expect((await product.projects.getById(siteId))?.latestVersionId).toBe(restored.version.id);
    await product.projects.save({ ...project, latestVersionId: "v2" as VersionId });
    await product.artifacts.delete(asset);
    await expect(product.pipeline.rollbackToPreviousVersion({ siteId, ownerId, expectedVersionId: "v2" as VersionId })).rejects.toMatchObject({ code: "ROLLBACK_SOURCE_UNAVAILABLE" });
    expect((await product.projects.getById(siteId))?.latestVersionId).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// Crash/restart reconciliation
// ---------------------------------------------------------------------------

const FAKE_VITE = `const http=require("node:http");const port=Number(process.argv[process.argv.indexOf("--port")+1]);
http.createServer((q,r)=>r.writeHead(200,{"content-type":"text/javascript"}).end("ok")).listen(port,"127.0.0.1");`;
async function workspaceDir(root: string, id: string, marker?: Record<string, unknown>) {
  await mkdir(join(root, id, "project", "src"), { recursive: true });
  await writeFile(join(root, id, "project", "src", "App.tsx"), "export const keep = true;");
  if (marker) await writeFile(join(root, id, WORKSPACE_MARKER), JSON.stringify({ schemaVersion: 1, environmentId: id, createdAt: new Date(0).toISOString(), ...marker }));
}
const vite = (root: string, id: string) => `"C:\\node\\node.exe" "${join(root, id, "project", "node_modules", "vite", "bin", "vite.js")}" --host 127.0.0.1 --port 5555 --strictPort`;

describe("Crash/restart workspace reconciliation (never deletes)", () => {
  it("classifies active, recoverable, orphaned and unknown; stops only provably orphaned previews of this root", async () => {
    const root = await temp("sites-reconcile-");
    const deadOwner = 2_147_000_001, liveOtherServer = 2_147_000_002;
    await workspaceDir(root, "env-active", { ownerPid: process.pid, ownerBootId: PROCESS_BOOT_ID });
    await workspaceDir(root, "env-other-server", { ownerPid: liveOtherServer, ownerBootId: "other" });
    await workspaceDir(root, "env-preview", { ownerPid: deadOwner, ownerBootId: "crashed", purpose: "PREVIEW", siteId: "site", versionId: "site:v2" });
    await workspaceDir(root, "env-stale-preview", { ownerPid: deadOwner, ownerBootId: "crashed", purpose: "PREVIEW", siteId: "site", versionId: "site:v1" });
    await workspaceDir(root, "env-job", { ownerPid: deadOwner, ownerBootId: "crashed" });
    await workspaceDir(root, "env-legacy");
    const processes = [
      { pid: 101, commandLine: vite(root, "env-active") },
      { pid: 102, commandLine: vite(root, "env-other-server") },
      { pid: 103, commandLine: vite(root, "env-preview") },
      { pid: 104, commandLine: vite(root, "env-job") },
      { pid: 105, commandLine: vite(root, "env-legacy") },
      { pid: 106, commandLine: vite(root, "env-deleted") },
      { pid: 107, commandLine: `node --enable-source-maps "D:\\Abdullah\\PDF chatbot\\dist\\main"` },
      { pid: 108, commandLine: `node "${join(tmpdir(), "elsewhere", "env-job", "project", "node_modules", "vite", "bin", "vite.js")}"` },
    ];
    const stopped: number[] = [];
    const report = await reconcileExecutionWorkspaces({ root, listProcesses: async () => processes, isProcessAlive: pid => pid === liveOtherServer,
      stopProcess: pid => { stopped.push(pid); }, isVersionRecoverable: async (siteId, versionId) => siteId === "site" && versionId === "site:v2" });
    const state = Object.fromEntries(report.entries.map(entry => [entry.environmentId, entry.state]));
    expect(state).toEqual({ "env-active": "ACTIVE", "env-other-server": "ACTIVE", "env-preview": "RECOVERABLE", "env-stale-preview": "ORPHANED", "env-job": "ORPHANED", "env-legacy": "UNKNOWN" });
    expect(stopped.sort()).toEqual([103, 104]);
    expect(report.counts).toMatchObject({ ACTIVE: 2, RECOVERABLE: 1, ORPHANED: 2, UNKNOWN: 1, stoppedProcesses: 2, untrackedPreviewProcesses: 1 });
    // Nothing is deleted; confirmed candidates are marked and the bounded report is written.
    for (const id of Object.keys(state)) expect((await stat(join(root, id, "project", "src", "App.tsx"))).isFile()).toBe(true);
    expect((await readdir(join(root, "env-job"))).includes(ORPHAN_CANDIDATE_MARKER)).toBe(true);
    expect((await readdir(join(root, "env-active"))).includes(ORPHAN_CANDIDATE_MARKER)).toBe(false);
    expect(JSON.parse(await readFile(join(root, RECONCILIATION_REPORT), "utf8"))).toMatchObject({ counts: { ORPHANED: 2 } });
  });

  it("is bounded: a hung process scan or a huge root cannot block startup, and nothing is stopped without a scan", async () => {
    const root = await temp("sites-reconcile-bounded-");
    for (let i = 0; i < 5; i++) await workspaceDir(root, `env-${i}`, { ownerPid: 2_147_000_001, ownerBootId: "crashed" });
    const stop = vi.fn();
    const started = Date.now();
    const report = await reconcileExecutionWorkspaces({ root, maxWorkspaces: 3, timeoutMs: 2_000, stopProcess: stop,
      listProcesses: () => Promise.reject(new Error("process scan timed out")) });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(report).toMatchObject({ processScan: "UNAVAILABLE", truncated: true, scanned: 3 });
    expect(stop).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(expect.arrayContaining(["env-0", "env-1", "env-2", "env-3", "env-4"]));
  });

  it("finds and stops a real orphaned preview process left by a crashed server (real process scan)", async () => {
    const root = await temp("sites-reconcile-real-");
    await workspaceDir(root, "env-crashed", { ownerPid: 2_147_000_001, ownerBootId: "crashed", purpose: "PREVIEW", siteId: "gone", versionId: "gone:v1" });
    const script = join(root, "env-crashed", "project", "node_modules", "vite", "bin", "vite.js");
    await mkdir(join(script, ".."), { recursive: true }); await writeFile(script, FAKE_VITE);
    const orphan = spawn(process.execPath, [script, "--host", "127.0.0.1", "--port", "0"], { cwd: join(root, "env-crashed", "project"), stdio: "ignore", windowsHide: true });
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(isProcessAlive(orphan.pid!)).toBe(true);
      const report = await reconcileExecutionWorkspaces({ root, isVersionRecoverable: async () => false });
      expect(report.processScan).toBe("OK");
      expect(report.entries).toEqual([expect.objectContaining({ environmentId: "env-crashed", state: "ORPHANED", previewProcesses: 1, stoppedProcesses: 1 })]);
      await new Promise<void>(resolve => { if (orphan.exitCode !== null || orphan.signalCode !== null) resolve(); else orphan.once("exit", () => resolve()); });
      expect((await stat(join(root, "env-crashed"))).isDirectory()).toBe(true);
    } finally { if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill(); }
  }, 30_000);

  it("never touches an active preview owned by this server", async () => {
    const root = await temp("sites-reconcile-active-");
    const execution = new LocalExecutionProvider({ rootDirectory: root, keepWorkspace: false, previewHost: "127.0.0.1", previewStartTimeoutMs: 8_000, commandTimeoutMs: 10_000, maxLogBytes: 64_000 });
    const pipeline = {
      restoreVersion: async () => {
        const environment = await execution.createEnvironment({});
        const script = join(execution.getWorkspacePath(environment.id), "node_modules", "vite", "bin", "vite.js");
        await mkdir(join(script, ".."), { recursive: true }); await writeFile(script, FAKE_VITE);
        return { environmentId: environment.id, build: {} };
      },
      disposeRestoredEnvironment: (id: string) => execution.destroyEnvironment(id),
    };
    const manager = new DevelopmentPreviewManager(pipeline as never, execution, 60_000);
    try {
      const session = await manager.start("site" as SiteId, "site:v1" as VersionId);
      const report = await reconcileExecutionWorkspaces({ root, isVersionRecoverable: async () => true });
      expect(report.entries).toEqual([expect.objectContaining({ environmentId: session.environmentId, state: "ACTIVE", purpose: "PREVIEW", siteId: "site", stoppedProcesses: 0 })]);
      expect(execution.isPreviewRunning(session.environmentId)).toBe(true);
      expect((await fetch(session.url)).ok).toBe(true);
      // Ownership markers live beside the project directory and never enter source.
      expect(await execution.fileExists(session.environmentId, WORKSPACE_MARKER)).toBe(false);
    } finally { await manager.close(); }
  }, 30_000);

  it("leaves referenced artifacts untouched", async () => {
    const h = await harness();
    await h.commit("a", { "src/App.tsx": "export const v = 1;" });
    const before = await h.listArtifacts();
    await workspaceDir(join(h.root, "execution"), "env-x", { ownerPid: 2_147_000_001, ownerBootId: "crashed" });
    await reconcileExecutionWorkspaces({ root: join(h.root, "execution"), listProcesses: async () => [] });
    expect(await h.listArtifacts()).toEqual(before);
    expect(await h.artifacts.exists(h.refFor("a"))).toBe(true);
  });
});

describe("Playground rollback endpoint", () => {
  it("refuses while a generation/edit is running, stops the stale preview after rollback, and maps safe errors", async () => {
    const { PlaygroundService, loadPlaygroundConfig } = await import("../src/dev-server/playground-service.js");
    const root = await temp("sites-rollback-service-");
    const service = new PlaygroundService(loadPlaygroundConfig({ SITES_DEV_DATA_ROOT: root, SITES_DEV_HOSTING_PORT: "0", SITES_DEV_RUNTIME_PORT: "0" }));
    const product = service.product as unknown as { projects: { getOwnedById: (id: string, owner: string) => Promise<unknown> }; pipeline: { rollbackToPreviousVersion: unknown } };
    product.projects.getOwnedById = async (id, owner) => id === "site" && owner === "owner" ? { id: "site", ownerId: "owner", latestVersionId: "site:v2" } : undefined;
    const rollbackSpy = vi.fn(async () => ({ version: { id: "site:v3", versionNumber: 3 }, restoredFromVersionId: "site:v1" }));
    product.pipeline.rollbackToPreviousVersion = rollbackSpy;
    try {
      vi.spyOn(service.jobs, "mutationRunning", "get").mockReturnValue(true);
      await expect(service.rollback("owner", "site", "site:v2")).rejects.toMatchObject({ code: "DEV_JOB_BUSY" });
      expect(rollbackSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      const stale = { id: "preview-1", siteId: "site" };
      vi.spyOn(service.previews, "list").mockReturnValue([stale as never]);
      const stop = vi.spyOn(service.previews, "stop").mockResolvedValue(true);
      await expect(service.rollback("owner", "site", "site:v2")).resolves.toEqual({ projectId: "site", versionId: "site:v3", versionNumber: 3, restoredFromVersionId: "site:v1" });
      expect(stop).toHaveBeenCalledWith("preview-1");
      await expect(service.rollback("intruder", "site", "site:v2")).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
    } finally { await service.close(); }
  });
});
