import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { LocalArtifactStore } from "../src/persistence/local-artifact-store.js";
import {
  InMemorySiteProjectRepository,
  InMemorySiteVersionRepository,
} from "../src/persistence/in-memory-repositories.js";
import type { UnnumberedSiteVersion } from "../src/persistence/version-committer.js";
import type { SiteProject, SiteVersion } from "../src/sites/domain/entities.js";
import type { SiteSourceSnapshot } from "../src/sites/generation/source-snapshot.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import { inspectTemplateZip } from "../src/templates/application/safe-template-zip.js";
import { TemplateInstantiationService } from "../src/templates/application/template-instantiation-service.js";
import type { SiteTemplate } from "../src/templates/domain/site-template.js";

const enc = new TextEncoder();

function sourceZip(overrides: Zippable = {}): Uint8Array {
  return zipSync({
    "site-template.json": enc.encode('{"templateKey":"modern-saas"}'),
    "package.json": enc.encode(JSON.stringify({
      name: "template",
      private: true,
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { vite: "6.4.1" },
    })),
    "package-lock.json": enc.encode('{"lockfileVersion":3}'),
    "index.html": enc.encode('<div id="root"></div>'),
    "src/main.jsx": enc.encode('document.querySelector("#root").textContent = "Template";'),
    ...overrides,
  });
}

function template(archive: Uint8Array, status: SiteTemplate["status"] = "active"): SiteTemplate {
  const now = new Date("2026-10-19T00:00:00.000Z");
  return {
    id: "template-1",
    templateKey: "modern-saas",
    version: 1,
    name: "Modern SaaS",
    description: "Template",
    categoryId: "category-1",
    tags: ["saas"],
    status,
    routes: [{ path: "/", label: "Home" }, { path: "/pricing", label: "Pricing" }],
    sourceObject: "sites/templates/modern-saas/v1/source/template.zip",
    sourceSha256: createHash("sha256").update(archive).digest("hex"),
    previews: { desktop: "desktop.webp", tablet: "tablet.webp", mobile: "mobile.webp" },
    createdAt: now,
    updatedAt: now,
  };
}

const qaReport = (status: BrowserQAReport["status"] = "PASS"): BrowserQAReport => ({
  reportVersion: 1,
  runId: "qa-1",
  status,
  browser: { name: "chromium", version: "test" },
  viewports: [],
  routes: ["/", "/pricing"],
  checks: [],
  artifactRefs: [],
  screenshots: [],
  summary: { passed: status === "PASS" ? 1 : 0, failed: status === "FAIL" ? 1 : 0, warnings: 0, skipped: 0 },
  startedAt: "2026-10-19T00:00:00.000Z",
  completedAt: "2026-10-19T00:00:01.000Z",
  durationMs: 1_000,
});

class FakeExecution {
  readonly files = new Map<string, Uint8Array>();
  readonly commands: string[] = [];
  readonly destroyed: string[] = [];
  buildFails = false;
  async createEnvironment() { return { id: "env-1", status: "READY" as const, createdAt: new Date() }; }
  async writeFileBytes(_id: string, path: string, bytes: Uint8Array) { this.files.set(path, bytes); }
  async readFile(_id: string, path: string) { return new TextDecoder().decode(this.files.get(path)); }
  async readFileBytes(_id: string, path: string) { return Buffer.from(this.files.get(path)!); }
  async listFiles() {
    return [...this.files].map(([path, bytes]) => ({ path, type: "FILE" as const, sizeBytes: bytes.byteLength }));
  }
  async executeCommand(_id: string, request: { executable: string; args?: readonly string[] }) {
    const command = `${request.executable} ${(request.args ?? []).join(" ")}`;
    this.commands.push(command);
    const failed = this.buildFails && command === "npm run build";
    return {
      exitCode: failed ? 1 : 0,
      stdout: failed ? "" : "ok",
      stderr: failed ? "build failed" : "",
      timedOut: false,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 1,
    };
  }
  async startPreview() { return { mode: "PROVIDER_URL" as const, url: "http://127.0.0.1:4173", port: 4173 }; }
  async destroyEnvironment(id: string) { this.destroyed.push(id); }
}

async function harness(options: { status?: SiteTemplate["status"]; hashMismatch?: boolean; qa?: BrowserQAReport["status"]; buildFails?: boolean } = {}) {
  const archive = sourceZip();
  const baseRecord = template(archive, options.status);
  const record = options.hashMismatch
    ? { ...baseRecord, sourceSha256: "0".repeat(64) }
    : baseRecord;
  const execution = new FakeExecution();
  execution.buildFails = options.buildFails ?? false;
  const projects = new InMemorySiteProjectRepository();
  const versions = new InMemorySiteVersionRepository();
  const artifacts = new LocalArtifactStore();
  const source = { readObject: vi.fn(async () => archive) };
  const repositories = {
    findTemplateVersion: vi.fn(async () => record),
    findLatestActiveTemplate: vi.fn(async () => record.status === "active" ? record : undefined),
    listActiveTemplates: vi.fn(),
    findById: vi.fn(),
  };
  const qaRun = vi.fn(async (request: unknown) => {
    void request;
    return qaReport(options.qa);
  });
  let committed: SiteVersion | undefined;
  const committer = {
    commit: vi.fn(async (project: SiteProject, draft: UnnumberedSiteVersion) => {
      committed = { ...draft, id: `${project.id}:v1` as VersionId, versionNumber: 1 };
      await versions.save(committed);
      await projects.save({ ...project, latestVersionId: committed.id, status: "ACTIVE", updatedAt: new Date() });
      return committed;
    }),
  };
  const cleanupSite = vi.fn(async (siteId: SiteId, ownerId: UserId) => {
    void ownerId;
    await artifacts.deletePrefix(`sites/${siteId}`);
  });
  const service = new TemplateInstantiationService({
    templates: repositories,
    source,
    execution: execution as never,
    artifacts,
    projects,
    versions: committer,
    browserQA: { run: qaRun } as never,
    cleanupSite,
  });
  return { service, archive, record, source, repositories, execution, projects, versions, artifacts, qaRun, committer, cleanupSite, committed: () => committed };
}

describe("Phase 6 template instantiation", () => {
  it("resolves canonical active metadata, builds, runs routes through QA, and persists a normal owned version", async () => {
    const h = await harness();
    const beforeTemp = (await readdir(tmpdir())).filter((name) => name.startsWith("sites-template-instantiation-"));
    const result = await h.service.instantiate({
      ownerId: "owner-from-jwt" as UserId,
      templateKey: "modern-saas",
      version: 1,
      projectName: "My Site",
      sourceObject: "attacker/object.zip",
      sourceSha256: "attacker-hash",
    } as never);

    expect(h.repositories.findTemplateVersion).toHaveBeenCalledWith("modern-saas", 1);
    expect(h.source.readObject).toHaveBeenCalledWith(h.record.sourceObject);
    expect(h.execution.commands).toEqual([
      "npm ci --prefer-offline --no-audit --no-fund",
      "npm run build",
    ]);
    expect((h.qaRun.mock.calls[0]![0] as { routes: readonly string[] }).routes).toEqual([
      "/",
      "/pricing",
    ]);
    expect(await h.projects.getById(result.projectId)).toMatchObject({
      ownerId: "owner-from-jwt",
      name: "My Site",
      latestVersionId: result.versionId,
    });
    expect(h.committed()).toMatchObject({
      templateId: "modern-saas",
      templateVersion: 1,
      buildStatus: "SUCCEEDED",
      browserQAStatus: "PASSED",
      usageSummary: { logicalCalls: 0, physicalRequests: 0, creditsCharged: 0 },
    });
    const stored = await h.artifacts.get(h.committed()!.sourceArtifactRef);
    const snapshot = JSON.parse(Buffer.from(stored!).toString("utf8")) as SiteSourceSnapshot;
    expect(snapshot.files["src/main.jsx"]).toBe('document.querySelector("#root").textContent = "Template";');
    expect(snapshot.files).not.toHaveProperty("site-template.json");
    expect(h.cleanupSite).not.toHaveBeenCalled();
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("sites-template-instantiation-"))).toEqual(beforeTemp);
  });

  it("rejects draft, missing, and hash-mismatched templates before project creation", async () => {
    const draft = await harness({ status: "draft" });
    await expect(draft.service.instantiate({ ownerId: "owner" as UserId, templateKey: "modern-saas", version: 1 })).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(draft.source.readObject).not.toHaveBeenCalled();
    expect((await draft.projects.listByOwner("owner")).items).toHaveLength(0);

    const missing = await harness();
    missing.repositories.findTemplateVersion.mockImplementationOnce(async () => undefined as never);
    await expect(missing.service.instantiate({ ownerId: "owner" as UserId, templateKey: "missing", version: 1 })).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    const mismatch = await harness({ hashMismatch: true });
    await expect(mismatch.service.instantiate({ ownerId: "owner" as UserId, templateKey: "modern-saas", version: 1 })).rejects.toMatchObject({ code: "TEMPLATE_SOURCE_INTEGRITY_FAILED" });
    expect(mismatch.committer.commit).not.toHaveBeenCalled();
  });

  it("leaves no successful project and cleans execution when build or Browser QA fails", async () => {
    const build = await harness({ buildFails: true });
    await expect(build.service.instantiate({ ownerId: "owner" as UserId, templateKey: "modern-saas", version: 1 })).rejects.toMatchObject({ code: "TEMPLATE_INSTANTIATION_BUILD_FAILED" });
    expect(build.committer.commit).not.toHaveBeenCalled();
    expect(build.execution.destroyed).toEqual(["env-1"]);
    expect(build.cleanupSite).toHaveBeenCalledOnce();

    const qa = await harness({ qa: "FAIL" });
    await expect(qa.service.instantiate({ ownerId: "owner" as UserId, templateKey: "modern-saas", version: 1 })).rejects.toMatchObject({ code: "TEMPLATE_INSTANTIATION_QA_FAILED" });
    expect(qa.committer.commit).not.toHaveBeenCalled();
    expect(qa.execution.destroyed).toEqual(["env-1"]);
  });
});

describe("Phase 6 safe ZIP inspection", () => {
  it.each([
    ["traversal", "../escape.txt"],
    ["absolute", "/absolute.txt"],
    ["drive-letter", "C:/escape.txt"],
    ["UNC", "\\\\server\\share\\escape.txt"],
  ])("rejects %s paths", (_label, path) => {
    expect(() => inspectTemplateZip(zipSync({ [path]: enc.encode("bad") }))).toThrow(/Unsafe ZIP entry path/);
  });

  it("rejects symbolic-link entries before decompression", () => {
    const archive = zipSync({
      "link": [enc.encode("target"), { os: 3, attrs: 0o120777 << 16 }],
    });
    expect(() => inspectTemplateZip(archive)).toThrow(/Links and special ZIP entries/);
  });
});
