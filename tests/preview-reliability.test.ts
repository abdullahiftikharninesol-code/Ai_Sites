import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalExecutionProvider } from "../src/execution/local/local-execution.provider.js";
import { DevelopmentPreviewManager } from "../src/dev-server/development-preview-manager.js";
import { PlaygroundService, loadPlaygroundConfig } from "../src/dev-server/playground-service.js";
import type { SiteId, VersionId } from "../src/shared/types.js";
import type * as PortAllocator from "../src/execution/local/local-port-allocator.js";

// Port allocation is real unless a test queues a specific port (port-conflict race).
const forced = vi.hoisted(() => ({ ports: [] as number[] }));
vi.mock("../src/execution/local/local-port-allocator.js", async importOriginal => {
  const actual = await importOriginal<typeof PortAllocator>();
  return { allocateLocalPort: (host: string) => forced.ports.length ? Promise.resolve(forced.ports.shift()!) : actual.allocateLocalPort(host) };
});

/**
 * Offline stand-in for the workspace's Vite binary (same argv contract). It
 * answers `/@vite/client`, honors --strictPort semantics (exits on EADDRINUSE),
 * can delay readiness, hang, or exit on request to simulate a crash.
 */
const FAKE_VITE = `
const http = require("node:http"); const fs = require("node:fs");
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg("--port")), host = arg("--host");
let mode = { delayMs: 0, hang: false };
try { mode = { ...mode, ...JSON.parse(fs.readFileSync(".fake-vite.json", "utf8")) }; } catch {}
if (mode.hang) setInterval(() => {}, 1000);
else setTimeout(() => {
  const server = http.createServer((request, response) => {
    if (request.url === "/__exit") { response.end("bye"); setTimeout(() => process.exit(0), 10); return; }
    response.writeHead(200, { "content-type": request.url === "/@vite/client" ? "text/javascript" : "text/html" }).end("<div id=root>ok</div>");
  });
  server.on("error", error => { console.error(error.code === "EADDRINUSE" ? "Error: Port " + port + " is already in use" : String(error.message)); process.exit(1); });
  server.listen(port, host);
}, mode.delayMs);
`;

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  forced.ports.length = 0;
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function provider(previewStartTimeoutMs = 8_000) {
  const root = await mkdtemp(join(tmpdir(), "sites-preview-reliability-")); roots.push(root);
  return new LocalExecutionProvider({ rootDirectory: root, keepWorkspace: false, previewHost: "127.0.0.1", previewStartTimeoutMs, commandTimeoutMs: 10_000, maxLogBytes: 64_000 });
}
/** A restored workspace: what pipeline.restoreVersion yields, without npm ci/build. */
async function workspace(execution: LocalExecutionProvider, mode: Record<string, unknown> = {}) {
  const environment = await execution.createEnvironment({});
  const path = execution.getWorkspacePath(environment.id);
  await mkdir(join(path, "node_modules/vite/bin"), { recursive: true });
  await writeFile(join(path, "node_modules/vite/bin/vite.js"), FAKE_VITE);
  await writeFile(join(path, ".fake-vite.json"), JSON.stringify(mode));
  return environment.id;
}
const fakePipeline = (execution: LocalExecutionProvider) => ({
  restoreVersion: vi.fn(async () => ({ environmentId: await workspace(execution, { delayMs: 150 }), build: {} })),
  disposeRestoredEnvironment: vi.fn((id: string) => execution.destroyEnvironment(id)),
  generate: vi.fn(), edit: vi.fn(),
});
const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  for (const started = Date.now(); !condition(); await new Promise(resolve => setTimeout(resolve, 25)))
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
};

describe("Local preview startup (real processes, offline)", () => {
  it("publishes the URL only after this workspace's dev server is ready", async () => {
    const execution = await provider(), id = await workspace(execution, { delayMs: 600 });
    const started = Date.now();
    const preview = await execution.startPreview(id, { port: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect((await fetch(`${preview.url}/@vite/client`)).ok).toBe(true);
    expect(execution.isPreviewRunning(id)).toBe(true);
    await execution.destroyEnvironment(id);
    expect(execution.isPreviewRunning(id)).toBe(false);
  });

  it("never adopts another process on a conflicting port; retries once on a fresh port", async () => {
    // A foreign server (like an unrelated backend) already owns the allocated port.
    const foreign = createServer((request, response) => { response.writeHead(request.url === "/" ? 200 : 404).end("foreign"); }); servers.push(foreign);
    await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
    const taken = (foreign.address() as { port: number }).port;
    forced.ports.push(taken);
    const execution = await provider(), id = await workspace(execution, { delayMs: 300 });
    const preview = await execution.startPreview(id, { port: 0 });
    expect(preview.port).not.toBe(taken);
    expect(await (await fetch(preview.url!)).text()).toContain("ok");
    await execution.destroyEnvironment(id);
  });

  it("fails within the bounded timeout and leaves no preview process behind", async () => {
    const execution = await provider(1_200), id = await workspace(execution, { hang: true });
    const started = Date.now();
    await expect(execution.startPreview(id, { port: 0 })).rejects.toMatchObject({ code: "PREVIEW_FAILED" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(() => execution.ownedProcessCount(id) === 0);
    expect(execution.getLatestPreview(id)).toBeUndefined();
    await execution.destroyEnvironment(id);
  });

  it("stops advertising a preview whose process terminated", async () => {
    const execution = await provider(), id = await workspace(execution);
    const preview = await execution.startPreview(id, { port: 0 });
    await fetch(`${preview.url}/__exit`);
    await until(() => !execution.isPreviewRunning(id));
    expect(execution.getLatestPreview(id)).toBeUndefined();
    await execution.destroyEnvironment(id);
  });
});

describe("Development preview sessions", () => {
  it("restores from the saved version after the preview process terminated, without AI or charges", async () => {
    const execution = await provider(), pipeline = fakePipeline(execution);
    const manager = new DevelopmentPreviewManager(pipeline as never, execution, 60_000);
    try {
      const first = await manager.start("site" as SiteId, "v1" as VersionId);
      await fetch(`${first.url}/__exit`);
      await until(() => !execution.isPreviewRunning(first.environmentId));
      // The dead session is expired (workspace released) rather than handed out.
      expect(await manager.active("site" as SiteId)).toBeUndefined();
      expect(pipeline.disposeRestoredEnvironment).toHaveBeenCalledWith(first.environmentId);
      const second = await manager.start("site" as SiteId, "v1" as VersionId);
      expect(second.id).not.toBe(first.id);
      expect((await fetch(second.url)).ok).toBe(true);
      expect(pipeline.restoreVersion).toHaveBeenCalledTimes(2);
      expect(pipeline.generate).not.toHaveBeenCalled(); expect(pipeline.edit).not.toHaveBeenCalled();
    } finally { await manager.close(); }
  });

  it("serves concurrent requests for the same version with one restore and one live process", async () => {
    const execution = await provider(), pipeline = fakePipeline(execution);
    const manager = new DevelopmentPreviewManager(pipeline as never, execution, 60_000);
    try {
      const [a, b] = await Promise.all([manager.start("site" as SiteId, "v1" as VersionId), manager.start("site" as SiteId, "v1" as VersionId)]);
      expect(b.id).toBe(a.id);
      expect(pipeline.restoreVersion).toHaveBeenCalledOnce();
      expect(execution.ownedProcessCount(a.environmentId)).toBe(1);
      expect((await fetch(a.url)).ok).toBe(true);
      // A different version still replaces the site's single preview.
      const c = await manager.start("site" as SiteId, "v2" as VersionId);
      expect(manager.list().map(session => session.id)).toEqual([c.id]);
      expect(pipeline.disposeRestoredEnvironment).toHaveBeenCalledWith(a.environmentId);
    } finally { await manager.close(); }
  });

  it("idle cleanup spares a preview that is being viewed and releases idle or dead ones", async () => {
    const ttl = 60_000, execution = await provider(), pipeline = fakePipeline(execution);
    const manager = new DevelopmentPreviewManager(pipeline as never, execution, ttl);
    try {
      const session = await manager.start("site" as SiteId, "v1" as VersionId);
      const createdAt = Date.parse(session.lastAccessedAt);
      // Viewing (site detail / keepalive) refreshes the idle timer.
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(createdAt + ttl - 1_000);
      expect((await manager.active("site" as SiteId))?.id).toBe(session.id);
      await manager.sweep(createdAt + ttl + 500);
      expect(manager.list()).toHaveLength(1);
      vi.useRealTimers();
      await manager.sweep(Date.now() + 2 * ttl);
      expect(manager.list()).toHaveLength(0);
      expect(pipeline.disposeRestoredEnvironment).toHaveBeenCalledWith(session.environmentId);
    } finally { vi.useRealTimers(); await manager.close(); }
  });
});

describe("Playground preview API: restart, expiry, missing data and saved-source integrity", () => {
  async function service(root?: string) {
    const dataRoot = root ?? await mkdtemp(join(tmpdir(), "sites-preview-service-")); if (!root) roots.push(dataRoot);
    const instance = new PlaygroundService(loadPlaygroundConfig({ SITES_DEV_DATA_ROOT: dataRoot, SITES_DEV_HOSTING_PORT: "0", SITES_DEV_RUNTIME_PORT: "0" }));
    const product = instance.product as unknown as {
      projects: { getOwnedById: (id: string, owner: string) => Promise<unknown> };
      versions: { getById: (id: string) => Promise<unknown> };
      artifacts: { put: (ref: string, bytes: Buffer, meta: unknown) => Promise<void> };
      pipeline: { restoreVersion: unknown; generate: unknown; edit: unknown };
      execution: LocalExecutionProvider;
    };
    product.projects.getOwnedById = async (id, owner) => id === "site" && owner === "owner" ? { id: "site", ownerId: "owner", latestVersionId: "v1" } : undefined;
    product.versions.getById = async id => id === "v1" ? { id: "v1", siteId: "site", sourceArtifactRef: "sites/site/versions/v1/source.json" } : undefined;
    const generate = vi.spyOn(product.pipeline as never, "generate" as never), edit = vi.spyOn(product.pipeline as never, "edit" as never);
    return { instance, product, generate, edit, dataRoot };
  }

  it("recovers after a backend restart: the old session is expired, the saved version is restored without AI", async () => {
    const before = await service();
    const restore = (execution: LocalExecutionProvider) => vi.fn(async () => ({ environmentId: await workspace(execution, { delayMs: 100 }), build: {} }));
    let oldId = "";
    try {
      before.product.pipeline.restoreVersion = restore(before.product.execution);
      const started = await before.instance.startPreview("owner", "site", "v1");
      oldId = started.previewSessionId;
      expect(started).not.toHaveProperty("workspacePath");
      expect((await fetch(started.previewUrl)).ok).toBe(true);
    } finally { await before.instance.close(); }
    // A new process (same data root): in-memory sessions are gone, data is not.
    const after = await service(before.dataRoot);
    try {
      after.product.pipeline.restoreVersion = restore(after.product.execution);
      await expect(after.instance.previewInspector("owner", oldId)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
      const restored = await after.instance.startPreview("owner", "site", "v1");
      expect((await fetch(restored.previewUrl)).ok).toBe(true);
      const inspected = await after.instance.previewInspector("owner", restored.previewSessionId);
      expect(inspected).toMatchObject({ status: "RUNNING" }); expect(inspected).not.toHaveProperty("workspacePath");
      expect(after.generate).not.toHaveBeenCalled(); expect(after.edit).not.toHaveBeenCalled();
      expect(before.generate).not.toHaveBeenCalled();
    } finally { await after.instance.close(); }
  });

  it("distinguishes an ended session from a missing project or version", async () => {
    const { instance } = await service();
    try {
      await expect(instance.previewInspector("owner", "no-such-session")).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
      await expect(instance.startPreview("owner", "missing-site", "v1")).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
      await expect(instance.startPreview("other-owner", "site", "v1")).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
      await expect(instance.startPreview("owner", "site", "v0")).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    } finally { await instance.close(); }
  });

  it.each([
    ["missing", undefined],
    ["corrupted", Buffer.from("{not json")],
    ["unsupported", Buffer.from(JSON.stringify({ manifest: { schemaVersion: 99, files: [] }, files: {} }))],
  ] as const)("reports a %s saved snapshot as unavailable source, without internal paths or AI", async (_name, bytes) => {
    const { instance, product, generate, edit } = await service();
    try {
      if (bytes) await product.artifacts.put("sites/site/versions/v1/source.json", bytes, { kind: "SOURCE_ARCHIVE", contentType: "application/json" });
      const failure = await instance.startPreview("owner", "site", "v1").catch((error: unknown) => error as { code: string; message: string });
      expect(failure).toMatchObject({ code: "PREVIEW_SOURCE_UNAVAILABLE" });
      expect((failure as { message: string }).message).not.toMatch(/sites\/site|source\.json|[A-Z]:\\|\/tmp\//);
      expect(instance.previews.list()).toHaveLength(0);
      expect(generate).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });
});
