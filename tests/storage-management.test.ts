import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCleanupPlan, planStorageCleanup, recoverInterruptedCleanup, type CleanupPlan, type ExecuteOptions, type PlanInputs } from "../src/storage/storage-cleanup-planner.js";
import { EXPECTED_DATA_ROOT_ENV, EXPECTED_DATABASE_ENV } from "../src/storage/storage-environment.js";
import { MongoStorageReferenceSource, emptyPublishingReferences, unavailableReferences, type StorageReferenceSnapshot } from "../src/storage/storage-references.js";
import { reconcileExecutionWorkspaces, type ProcessInfo } from "../src/execution/local/workspace-reconciliation.js";
import { PROCESS_BOOT_ID, WORKSPACE_MARKER } from "../src/execution/local/workspace-ownership.js";
import type { MongoModels } from "../src/persistence/mongodb/mongo-models.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
const DAY = 24 * 60 * 60 * 1000;
const DEAD = 2_147_000_001, LIVE_OTHER = 2_147_000_002;
const asset = (seed: string) => `${createHash("sha256").update(seed).digest("hex")}.png`;

/** Recursively back-date a tree (files and directories). */
async function age(path: string, days: number) {
  const when = new Date(Date.now() - days * DAY);
  const info = await stat(path);
  if (info.isDirectory()) for (const entry of await readdir(path)) await age(join(path, entry), days);
  await utimes(path, when, when);
}
const sourceJson = (text: string) => JSON.stringify({ manifest: { schemaVersion: 2, files: [{ path: "src/App.tsx", sizeBytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }] }, files: { "src/App.tsx": text } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sites-storage-")); roots.push(root);
  const write = async (rel: string, content: string | Buffer) => { const path = join(root, ...rel.split("/")); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, content); return path; };
  /** One generation/edit attempt directory with source, build log, QA report and a screenshot. */
  const attempt = async (site: string, id: string, days: number, appText = `export const id = "${id}";`) => {
    const dir = `artifacts/sites/${site}/versions/${id}`;
    await write(`${dir}/source/source.json`, sourceJson(appText));
    await write(`${dir}/source/manifest.json`, "{}");
    await write(`${dir}/build/build.json`, JSON.stringify({ log: "vite build ok" }));
    await write(`${dir}/qa/report.json`, "{}");
    await write(`${dir}/qa/screenshots/browser/desktop-home.png`, Buffer.alloc(2048, 1));
    await age(join(root, ...dir.split("/")), days);
    return { dir, ref: `sites/${site}/versions/${id}/source/source.json` };
  };
  const workspace = async (id: string, days: number, marker?: Record<string, unknown>) => {
    await write(`execution/${id}/project/src/App.tsx`, "export default 1;");
    await write(`execution/${id}/project/node_modules/react/index.js`, "x".repeat(4096));
    if (marker) await write(`execution/${id}/${WORKSPACE_MARKER}`, JSON.stringify({ schemaVersion: 1, environmentId: id, createdAt: new Date(0).toISOString(), ...marker }));
    await age(join(root, "execution", id), days);
  };
  let references: StorageReferenceSnapshot = { available: true, retainedSourceRefs: new Map(), knownSiteIds: new Set(), activeSiteIds: new Set(), publishing: emptyPublishingReferences() };
  let processes: ProcessInfo[] = [];
  let scanFails = false;
  // Execution requires the explicitly configured local environment (single local MongoDB + this data root).
  const inputs = (extra: Partial<PlanInputs> = {}): Omit<ExecuteOptions, "approvedPlanId"> => ({
    dataRoot: root,
    databaseUri: "mongodb://127.0.0.1:27017/sites-test",
    environment: { [EXPECTED_DATA_ROOT_ENV]: root, [EXPECTED_DATABASE_ENV]: "127.0.0.1/sites-test" },
    references: { load: async () => references },
    listProcesses: async () => { if (scanFails) throw new Error("scan failed"); return processes; },
    reconcile: path => reconcileExecutionWorkspaces({ root: path, stopOrphanPreviews: false, isProcessAlive: pid => pid === LIVE_OTHER,
      listProcesses: async () => { if (scanFails) throw new Error("scan failed"); return processes; },
      isVersionRecoverable: async siteId => (references.retainedSourceRefs.get(siteId)?.length ?? 0) > 0 }),
    ...extra,
  });
  const exists = (rel: string) => stat(join(root, ...rel.split("/"))).then(() => true, () => false);
  const tree = async () => (await readdir(root, { recursive: true })).map(path => path.split("\\").join("/")).sort();
  return { root, write, attempt, workspace, inputs, exists, tree,
    setReferences: (value: StorageReferenceSnapshot) => { references = value; },
    setProcesses: (value: ProcessInfo[]) => { processes = value; },
    failScan: () => { scanFails = true; } };
}
const refs = (entries: Record<string, string[]>, active: string[] = []): StorageReferenceSnapshot =>
  ({ available: true, retainedSourceRefs: new Map(Object.entries(entries)), knownSiteIds: new Set(Object.keys(entries)), activeSiteIds: new Set(active), publishing: emptyPublishingReferences() });
const byPath = (plan: CleanupPlan) => new Map(plan.candidates.map(candidate => [candidate.path, candidate]));
const viteOf = (root: string, env: string) => `"node.exe" "${join(root, "execution", env, "project", "node_modules", "vite", "bin", "vite.js")}" --port 5000`;

describe("Reference-aware storage planning (dry run)", () => {
  it("1/2/11. never plans the current or previous version; keeps the newest attempts as bounded diagnostics", async () => {
    const f = await fixture();
    const current = await f.attempt("site", "v-current", 400), previous = await f.attempt("site", "v-previous", 500);
    const attempts = [];
    for (let i = 0; i < 6; i++) attempts.push(await f.attempt("site", `failed-${i}`, 30 + i));
    f.setReferences(refs({ site: [current.ref, previous.ref] }));
    const plan = await planStorageCleanup(f.inputs());
    const candidates = byPath(plan);
    expect(candidates.has(current.dir)).toBe(false); expect(candidates.has(previous.dir)).toBe(false);
    // Newest two failed attempts (30, 31 days) keep their screenshots/QA/build logs as evidence.
    expect(candidates.has(attempts[0]!.dir)).toBe(false); expect(candidates.has(attempts[1]!.dir)).toBe(false);
    expect([...candidates.keys()].sort()).toEqual(attempts.slice(2).map(item => item.dir).sort());
    expect(plan.protected).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "CURRENT_VERSION", count: 1 }),
      expect.objectContaining({ reason: "PREVIOUS_VERSION", count: 1 }), expect.objectContaining({ reason: "RETAINED_DIAGNOSTIC_ATTEMPT", count: 2 })]));
    expect(candidates.get(attempts[5]!.dir)).toMatchObject({ category: "SUPERSEDED_VERSION_ARTIFACTS" });
    expect(candidates.get(attempts[5]!.dir)?.checks).toEqual(expect.arrayContaining(["NOT_CURRENT_OR_PREVIOUS", "NO_ACTIVE_JOB"]));
    expect(plan.totals.reclaimableBytes).toBe(plan.candidates.reduce((sum, item) => sum + item.sizeBytes, 0));
    expect(plan.retention.failedCandidateEvidence).toMatch(/5 files/);
  });

  it("3. protects assets referenced by retained/diagnostic versions, pending uploads and recent uploads", async () => {
    const f = await fixture();
    const [used, pending, fresh, unused, diagnostic] = ["used", "pending", "fresh", "unused", "diagnostic"].map(asset);
    const current = await f.attempt("site", "v1", 300, `<img src="/__sites/assets/${used}"/>`);
    await f.attempt("site", "failed", 40, `<img src="/__sites/assets/${diagnostic}"/>`);
    for (const name of [used!, pending!, unused!, diagnostic!]) { await f.write(`artifacts/assets/content/${name}`, Buffer.alloc(1000)); await age(join(f.root, "artifacts/assets/content", name), 60); }
    await f.write(`artifacts/assets/content/${fresh}`, Buffer.alloc(1000));
    f.setReferences(refs({ site: [current.ref] }));
    const plan = await planStorageCleanup(f.inputs({ protectedAssetKeys: new Set([`assets/content/${pending}`]) }));
    const assets = plan.candidates.filter(candidate => candidate.category === "UNREFERENCED_ASSET").map(candidate => candidate.path);
    expect(assets).toEqual([`artifacts/assets/content/${unused}`]);
    expect(plan.protected.find(group => group.reason === "REFERENCED_ASSET")?.count).toBe(3);
    expect(plan.protected.find(group => group.reason === "RECENT_OR_PENDING_UPLOAD")?.count).toBe(1);
  });

  it("4/5/6/7. workspaces: only a confirmed, inactive, process-free orphan (or verified recoverable cache) is a candidate", async () => {
    const f = await fixture();
    const current = await f.attempt("site", "v1", 300);
    await f.workspace("env-mine", 2, { ownerPid: process.pid, ownerBootId: PROCESS_BOOT_ID });
    await f.workspace("env-other-live", 2, { ownerPid: LIVE_OTHER, ownerBootId: "x" });
    await f.workspace("env-legacy", 30);
    await f.workspace("env-orphan", 2, { ownerPid: DEAD, ownerBootId: "crashed" });
    await f.workspace("env-orphan-recent", 0, { ownerPid: DEAD, ownerBootId: "crashed" });
    await f.workspace("env-orphan-running", 2, { ownerPid: DEAD, ownerBootId: "crashed" });
    await f.workspace("env-orphan-in-use", 2, { ownerPid: DEAD, ownerBootId: "crashed" });
    await f.workspace("env-preview-cache", 2, { ownerPid: DEAD, ownerBootId: "crashed", purpose: "PREVIEW", siteId: "site", versionId: "site:v1" });
    await f.workspace("env-preview-broken", 2, { ownerPid: DEAD, ownerBootId: "crashed", purpose: "PREVIEW", siteId: "broken", versionId: "broken:v1" });
    await f.write("artifacts/sites/broken/versions/b1/source/source.json", "{corrupt");
    f.setReferences(refs({ site: [current.ref], broken: ["sites/broken/versions/b1/source/source.json"] }));
    f.setProcesses([{ pid: 9, ppid: 4, commandLine: viteOf(f.root, "env-orphan-running") }]);
    const plan = await planStorageCleanup(f.inputs({ activeEnvironmentIds: new Set(["env-orphan-in-use"]) }));
    const workspaces = plan.candidates.filter(candidate => candidate.path.startsWith("execution/"));
    expect(workspaces.map(candidate => [candidate.path, candidate.category]).sort()).toEqual([
      ["execution/env-orphan", "ORPHANED_WORKSPACE"], ["execution/env-preview-cache", "RECOVERABLE_WORKSPACE"]]);
    const reasons = Object.fromEntries(plan.protected.map(group => [group.reason, group.count]));
    expect(reasons).toMatchObject({ ACTIVE_WORKSPACE: 2, UNKNOWN_WORKSPACE_OWNERSHIP: 1, RECENTLY_ACTIVE_WORKSPACE: 1, WORKSPACE_IN_USE: 2, RECOVERABLE_SOURCE_NOT_VERIFIED: 1 });
    // A process scan that cannot run makes every non-active workspace uncertain.
    f.failScan();
    const blind = await planStorageCleanup(f.inputs());
    expect(blind.candidates.filter(candidate => candidate.path.startsWith("execution/"))).toEqual([]);
  });

  it("5. an active job protects everything its site owns", async () => {
    const f = await fixture();
    const current = await f.attempt("site", "v1", 300);
    await f.attempt("site", "in-flight", 90); await f.attempt("site", "a", 91); await f.attempt("site", "b", 92);
    f.setReferences(refs({ site: [current.ref] }, ["site"]));
    const plan = await planStorageCleanup(f.inputs());
    expect(plan.candidates).toEqual([]);
    expect(plan.protected.find(group => group.reason === "ACTIVE_JOB")?.count).toBe(4);
  });

  it("8. fails closed when MongoDB is unavailable: no snapshot, version artifact or asset is a candidate", async () => {
    const f = await fixture();
    await f.attempt("site", "v1", 300); await f.attempt("site", "old", 300); await f.attempt("site", "older", 301); await f.attempt("site", "oldest", 302);
    await f.write(`artifacts/assets/content/${asset("x")}`, Buffer.alloc(10)); await age(join(f.root, "artifacts/assets"), 90);
    f.setReferences(unavailableReferences("MONGODB_UNAVAILABLE"));
    const plan = await planStorageCleanup(f.inputs());
    expect(plan).toMatchObject({ referencesAvailable: false, referencesReason: "MONGODB_UNAVAILABLE", candidates: [] });
    expect(plan.protected.find(group => group.reason === "REFERENCES_UNAVAILABLE")?.count).toBe(5);
    // The real source reports unavailability rather than an empty reference set.
    expect(await new MongoStorageReferenceSource({} as MongoModels, () => false).load()).toMatchObject({ available: false, reason: "MONGODB_UNAVAILABLE" });
    const broken = { projects: { find: () => { throw new Error("socket closed"); } } } as unknown as MongoModels;
    expect(await new MongoStorageReferenceSource(broken, () => true).load()).toMatchObject({ available: false, reason: "MONGODB_QUERY_FAILED" });
  });

  it("10. a link or junction inside or on a candidate makes it uncertain, and execution refuses escapes", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "sites-outside-")); roots.push(outside);
    await writeFile(join(outside, "precious.txt"), "must survive");
    const current = await f.attempt("site", "v1", 300);
    const linked = await f.attempt("site", "linked", 200); await f.attempt("site", "keep1", 30); await f.attempt("site", "keep2", 31);
    await symlink(outside, join(f.root, ...linked.dir.split("/"), "escape"), "junction");
    f.setReferences(refs({ site: [current.ref] }));
    const plan = await planStorageCleanup(f.inputs());
    expect(byPath(plan).has(linked.dir)).toBe(false);
    expect(plan.protected.find(group => group.reason === "UNCERTAIN_TREE")?.count).toBe(1);
    // A hand-edited plan cannot steer deletion outside the data root.
    const forged: CleanupPlan = { ...plan, candidates: [{ id: "forged", category: "SUPERSEDED_VERSION_ARTIFACTS", path: "artifacts/sites/../../..", sizeBytes: 1, newestModifiedMs: 0, reason: "x", checks: [] }] };
    const outcome = await executeCleanupPlan(forged, { ...f.inputs(), approvedPlanId: forged.planId });
    expect(outcome).toEqual([expect.objectContaining({ result: "SKIPPED" })]);
    expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe("must survive");
  });
});

describe("Guarded execution (fixture data only)", () => {
  async function eligibleFixture() {
    const f = await fixture();
    const current = await f.attempt("site", "v1", 300);
    await f.attempt("site", "keep1", 30); await f.attempt("site", "keep2", 31);
    const stale = await f.attempt("site", "stale", 200);
    f.setReferences(refs({ site: [current.ref] }));
    return { f, current, stale };
  }

  it("12. dry run deletes nothing", async () => {
    const { f } = await eligibleFixture();
    await f.workspace("env-orphan", 2, { ownerPid: DEAD, ownerBootId: "crashed" });
    const before = await f.tree();
    const plan = await planStorageCleanup(f.inputs());
    expect(plan.mode).toBe("DRY_RUN"); expect(plan.totals.candidates).toBe(2);
    const after = await f.tree();
    expect(before.filter(path => !after.includes(path))).toEqual([]);
  });

  it("deletes only with the exact approved plan id, then leaves no trash behind", async () => {
    const { f, stale } = await eligibleFixture();
    const plan = await planStorageCleanup(f.inputs());
    expect((await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: "something-else" }))[0]).toMatchObject({ result: "SKIPPED", reason: "PLAN_NOT_APPROVED" });
    expect(await f.exists(stale.dir)).toBe(true);
    expect(await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId })).toEqual([expect.objectContaining({ path: stale.dir, result: "DELETED" })]);
    expect(await f.exists(stale.dir)).toBe(false);
    expect(await f.exists("artifacts/sites/site/versions/v1/source/source.json")).toBe(true);
    expect(await readdir(join(f.root, ".cleanup-trash"))).toEqual([]);
  });

  it("9/13. a candidate that becomes referenced or active before execution is never removed", async () => {
    const { f, current, stale } = await eligibleFixture();
    const plan = await planStorageCleanup(f.inputs());
    // An edit/rollback makes the planned attempt the previous version, concurrently.
    f.setReferences(refs({ site: [current.ref, stale.ref] }));
    expect(await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId })).toEqual([expect.objectContaining({ result: "SKIPPED", reason: "NO_LONGER_ELIGIBLE" })]);
    expect(await f.exists(stale.dir)).toBe(true);
    // A job starts on the site after planning.
    f.setReferences(refs({ site: [current.ref] }, ["site"]));
    expect((await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId }))[0]).toMatchObject({ result: "SKIPPED" });
    // New files written into the candidate after planning.
    f.setReferences(refs({ site: [current.ref] }));
    await f.write(`${stale.dir}/qa/late.json`, "{}");
    expect((await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId }))[0]).toMatchObject({ result: "SKIPPED" });
    expect(await f.exists(stale.dir)).toBe(true);
  });

  it("14. an interrupted execution is restored on the next run", async () => {
    const { f, stale } = await eligibleFixture();
    const plan = await planStorageCleanup(f.inputs());
    await expect(executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId, afterMove: () => { throw new Error("process killed"); } })).rejects.toThrow("process killed");
    expect(await f.exists(stale.dir)).toBe(false);
    expect(await recoverInterruptedCleanup(f.root)).toEqual({ restored: [stale.dir], unresolved: [] });
    expect(JSON.parse(await readFile(join(f.root, ...stale.dir.split("/"), "source", "source.json"), "utf8"))).toMatchObject({ files: { "src/App.tsx": 'export const id = "stale";' } });
  });

  it("15. planning and execution make no network/AI calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { f } = await eligibleFixture();
    const plan = await planStorageCleanup(f.inputs());
    await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId });
    expect(fetch).not.toHaveBeenCalled();
  });
});
