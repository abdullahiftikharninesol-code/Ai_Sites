import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditLegacyWorkspaces, type LegacyAuditInputs, type LegacyWorkspaceFinding } from "../src/storage/legacy-workspace-audit.js";
import { loadLegacyStoreSiteIds, withLegacyStoreReferences } from "../src/storage/legacy-store-references.js";
import { executeCleanupPlan, planStorageCleanup, type ExecuteOptions } from "../src/storage/storage-cleanup-planner.js";
import { describeDatabase, EXPECTED_DATA_ROOT_ENV, EXPECTED_DATABASE_ENV, verifyStorageEnvironment } from "../src/storage/storage-environment.js";
import { unavailableReferences, type StorageReferenceSnapshot } from "../src/storage/storage-references.js";
import { reconcileExecutionWorkspaces, type ProcessInfo } from "../src/execution/local/workspace-reconciliation.js";
import { WORKSPACE_MARKER } from "../src/execution/local/workspace-ownership.js";
import { LocalArtifactStore } from "../src/persistence/local-artifact-store.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
const DAY = 24 * 60 * 60 * 1000;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const env = (n: number) => `env_${n.toString(16).padStart(12, "0")}`;
type Files = Record<string, string>;
const site = (name: string, extra: Files = {}): Files => ({
  "package.json": JSON.stringify({ name: "site", dependencies: { react: "19.0.0" } }),
  "index.html": `<title>${name}</title>`,
  "src/App.tsx": `export default function App() { return "${name}"; }`,
  ...extra,
});

async function age(path: string, days: number) {
  const when = new Date(Date.now() - days * DAY);
  const info = await stat(path);
  if (info.isDirectory()) for (const entry of await readdir(path)) await age(join(path, entry), days);
  await utimes(path, when, when);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sites-legacy-")); roots.push(root);
  const write = async (rel: string, content: string | Buffer) => { const path = join(root, ...rel.split("/")); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, content); return path; };
  /** A saved source snapshot exactly as SiteSourceSnapshotService writes it. */
  const snapshot = async (siteId: string, attempt: string, files: Files, days = 30) => {
    const manifest = { schemaVersion: 2, files: Object.entries(files).map(([path, text]) => ({ path, sizeBytes: Buffer.byteLength(text), sha256: sha(text) })).sort((a, b) => a.path.localeCompare(b.path)) };
    const dir = `artifacts/sites/${siteId}/versions/${attempt}`;
    await write(`${dir}/source/source.json`, JSON.stringify({ manifest, files }));
    await write(`${dir}/source/manifest.json`, JSON.stringify(manifest));
    await age(join(root, ...dir.split("/")), days);
    return `sites/${siteId}/versions/${attempt}/source/source.json`;
  };
  /** A pre-marker workspace: project source plus regenerated dependencies and build output. */
  const legacy = async (id: string, files: Files, days = 10, extra: Files = {}) => {
    for (const [path, text] of Object.entries({ ...files, ...extra })) await write(`execution/${id}/project/${path}`, text);
    await write(`execution/${id}/project/node_modules/vite/bin/vite.js`, "x".repeat(4096));
    await write(`execution/${id}/project/dist/index.html`, "<html></html>");
    await age(join(root, "execution", id), days);
  };
  let references: StorageReferenceSnapshot = { available: true, retainedSourceRefs: new Map(), knownSiteIds: new Set(), activeSiteIds: new Set() };
  let processes: ProcessInfo[] = [];
  let scanFails = false;
  const listProcesses = vi.fn(async () => { if (scanFails) throw new Error("scan failed"); return processes; });
  const audit = (extra: Partial<LegacyAuditInputs> = {}) => auditLegacyWorkspaces({ dataRoot: root, references, listProcesses, ...extra });
  const configured = { [EXPECTED_DATA_ROOT_ENV]: root, [EXPECTED_DATABASE_ENV]: "127.0.0.1/sites" };
  const inputs = (extra: Partial<ExecuteOptions> = {}): Omit<ExecuteOptions, "approvedPlanId"> => ({
    dataRoot: root, databaseUri: "mongodb://127.0.0.1:27017/sites", environment: configured,
    references: { load: async () => references }, listProcesses,
    reconcile: path => reconcileExecutionWorkspaces({ root: path, stopOrphanPreviews: false, listProcesses: async () => processes }),
    ...extra,
  });
  const files = async () => {
    const out: string[] = [];
    for (const entry of await readdir(root, { recursive: true })) {
      const info = await stat(join(root, entry)); out.push(`${entry.split("\\").join("/")}:${info.isDirectory() ? "d" : `${info.size}:${info.mtimeMs}`}`);
    }
    return out.sort();
  };
  return { root, write, snapshot, legacy, audit, inputs, files, listProcesses, configured,
    setReferences: (value: StorageReferenceSnapshot) => { references = value; },
    setProcesses: (value: ProcessInfo[]) => { processes = value; },
    failScan: () => { scanFails = true; } };
}
const refs = (entries: Record<string, string[]>, active: string[] = []): StorageReferenceSnapshot =>
  ({ available: true, retainedSourceRefs: new Map(Object.entries(entries)), knownSiteIds: new Set(Object.keys(entries)), activeSiteIds: new Set(active) });
const by = (findings: readonly LegacyWorkspaceFinding[]) => new Map(findings.map(finding => [finding.environmentId, finding]));

describe("Legacy workspace classification (read-only, evidence-based)", () => {
  it("attributes workspaces by byte-identical snapshot content and never modifies them", async () => {
    const f = await fixture();
    const current = await f.snapshot("shop", "v2", site("Shop v2")), previous = await f.snapshot("shop", "v1", site("Shop v1"));
    await f.legacy(env(1), site("Shop v2"));
    await f.legacy(env(2), site("Shop v1"));
    await f.legacy(env(3), site("Something never saved"));
    await f.legacy(env(4), site("Shop v2"), 10, { "notes/todo.md": "unsaved work" });
    await f.legacy(env(5), site("Shop v2"), 10, { "site-template.json": JSON.stringify({ templateKey: "restaurant" }) });
    await f.legacy(env(6), site("Shop v2"));
    await f.write(`execution/${env(6)}/${WORKSPACE_MARKER}`, JSON.stringify({ schemaVersion: 1, environmentId: env(6), ownerPid: 1, ownerBootId: "x", createdAt: new Date(0).toISOString() }));
    f.setReferences(refs({ shop: [current, previous] }));
    const before = await f.files();
    const audit = await f.audit();
    const result = by(audit.findings);
    expect(result.get(env(1))).toMatchObject({ classification: "SAFE_CANDIDATE", reason: "REDUNDANT_COPY_OF_VERIFIED_SAVED_SNAPSHOT",
      matches: [{ siteId: "shop", attempt: "v2", role: "CURRENT", siteRecorded: true }], identifiers: { packageName: "site", title: "Shop v2" } });
    expect(result.get(env(1))?.evidence).toEqual(expect.arrayContaining(["NO_LINKS", "NO_PROCESS_REFERENCES_WORKSPACE", "INACTIVE", "BYTE_IDENTICAL_TO_SAVED_SNAPSHOT",
      "MATCHED_SNAPSHOT_VERIFIED", "RECORDED_SITES_CURRENT_AND_PREVIOUS_VERIFIED", "ASSETS_AVAILABLE_OUTSIDE_WORKSPACE", "NO_UNSAVED_FILES"]));
    expect(result.get(env(2))).toMatchObject({ classification: "SAFE_CANDIDATE", matches: [{ attempt: "v1", role: "PREVIOUS" }] });
    expect(result.get(env(3))).toMatchObject({ classification: "UNKNOWN", reason: "NO_MATCHING_SNAPSHOT", bestPartialMatch: { siteId: "shop", matchingFiles: 1, workspaceFiles: 3 } });
    expect(result.get(env(4))).toMatchObject({ classification: "RECOVERABLE", reason: "UNSAVED_FILES_PRESENT", unsavedFiles: ["notes/todo.md"] });
    // The template manifest is regenerable metadata, never unsaved work.
    expect(result.get(env(5))).toMatchObject({ classification: "SAFE_CANDIDATE", identifiers: { templateKey: "restaurant" } });
    // Marker-bearing workspaces belong to the Phase 3A/3B rules.
    expect(result.has(env(6))).toBe(false); expect(audit.markedWorkspacesSkipped).toBe(1);
    expect(audit.totals.SAFE_CANDIDATE.count).toBe(3);
    expect(await f.files()).toEqual(before);
  });

  it("active preview/process/job or recent activity makes a legacy workspace ACTIVE; missing evidence makes it UNKNOWN", async () => {
    const f = await fixture();
    const shop = await f.snapshot("shop", "v1", site("Shop")), busy = await f.snapshot("busy", "v1", site("Busy"));
    await f.legacy(env(11), site("Shop")); await f.legacy(env(12), site("Shop")); await f.legacy(env(13), site("Shop"), 0); await f.legacy(env(14), site("Busy"));
    f.setReferences(refs({ shop: [shop], busy: [busy] }, ["busy"]));
    // A non-node binary (esbuild service) running from inside the workspace counts as use.
    f.setProcesses([{ pid: 4242, commandLine: `"${join(f.root, "execution", env(12), "project", "node_modules", "@esbuild", "win32-x64", "esbuild.exe")}" --service=0.25.0` }]);
    const result = by((await f.audit({ activeEnvironmentIds: new Set([env(11)]) })).findings);
    expect(result.get(env(11))).toMatchObject({ classification: "ACTIVE", reason: "IN_USE_BY_THIS_SERVER" });
    expect(result.get(env(12))).toMatchObject({ classification: "ACTIVE", reason: "PROCESS_USES_WORKSPACE:4242" });
    expect(result.get(env(13))).toMatchObject({ classification: "ACTIVE", reason: "RECENT_FILE_ACTIVITY" });
    expect(result.get(env(14))).toMatchObject({ classification: "ACTIVE", reason: "ACTIVE_JOB_FOR_MATCHED_SITE" });

    f.setProcesses([]); f.failScan();
    expect((await f.audit()).findings.every(finding => finding.classification === "UNKNOWN" || finding.reason === "IN_USE_BY_THIS_SERVER")).toBe(true);
    const g = await fixture();
    await g.snapshot("shop", "v1", site("Shop")); await g.legacy(env(15), site("Shop"));
    g.setReferences(unavailableReferences("MONGODB_UNAVAILABLE"));
    expect((await g.audit()).findings[0]).toMatchObject({ classification: "UNKNOWN", reason: "REFERENCES_UNAVAILABLE:MONGODB_UNAVAILABLE" });
  });

  it("missing or corrupted snapshots and assets keep the workspace (it may be the only intact copy)", async () => {
    const f = await fixture();
    // Matched snapshot tampered after its manifest was written.
    const tampered = await f.snapshot("tampered", "v1", site("Tampered"));
    await f.write("artifacts/sites/tampered/versions/v1/source/source.json", JSON.stringify({ manifest: JSON.parse(await readFile(join(f.root, "artifacts/sites/tampered/versions/v1/source/manifest.json"), "utf8")) as unknown, files: site("Changed") }));
    await f.legacy(env(21), site("Tampered"));
    // Workspace matches an older attempt, but the website's current snapshot is gone.
    await f.snapshot("lost", "old", site("Lost old"));
    await f.legacy(env(22), site("Lost old"));
    // Current fine, previous corrupted.
    const okCurrent = await f.snapshot("prev", "v2", site("Prev v2")), badPrevious = await f.snapshot("prev", "v1", site("Prev v1"));
    await f.write("artifacts/sites/prev/versions/v1/source/source.json", "{corrupt");
    await f.legacy(env(23), site("Prev v2"));
    // Current references a managed asset that is missing from the content store.
    const image = Buffer.from("png-bytes"), imageName = `${sha(image)}.png`;
    const withAsset = await f.snapshot("media", "v1", site("Media", { "src/hero.tsx": `<img src="/__sites/assets/${imageName}"/>` }));
    await f.legacy(env(24), site("Media", { "src/hero.tsx": `<img src="/__sites/assets/${imageName}"/>` }));
    // Recorded website with no saved version at all.
    await f.snapshot("draft", "attempt", site("Draft"));
    await f.legacy(env(25), site("Draft"));
    f.setReferences(refs({ tampered: [tampered], lost: ["sites/lost/versions/missing/source/source.json"], prev: [okCurrent, badPrevious], media: [withAsset], draft: [] }));
    let result = by((await f.audit()).findings);
    expect(result.get(env(21))).toMatchObject({ classification: "UNKNOWN", reason: "MATCHED_SNAPSHOT_INTEGRITY_FAILED" });
    expect(result.get(env(22))).toMatchObject({ classification: "UNKNOWN", reason: "SITE_NOT_RESTORABLE:CURRENT_SNAPSHOT_INTEGRITY_FAILED", matches: [{ role: "SUPERSEDED" }] });
    expect(result.get(env(23))).toMatchObject({ classification: "UNKNOWN", reason: "SITE_NOT_RESTORABLE:PREVIOUS_SNAPSHOT_INTEGRITY_FAILED" });
    expect(result.get(env(24))).toMatchObject({ classification: "UNKNOWN", reason: "SITE_NOT_RESTORABLE:CURRENT_ASSET_MISSING_OR_CORRUPT" });
    expect(result.get(env(25))).toMatchObject({ classification: "UNKNOWN", reason: "SITE_NOT_RESTORABLE:SITE_HAS_NO_SAVED_VERSION" });
    // A corrupt asset is as bad as a missing one; the intact asset makes the website restorable.
    await f.write(`artifacts/assets/content/${imageName}`, "not the same bytes");
    expect(by((await f.audit()).findings).get(env(24))?.reason).toBe("SITE_NOT_RESTORABLE:CURRENT_ASSET_MISSING_OR_CORRUPT");
    await f.write(`artifacts/assets/content/${imageName}`, image);
    result = by((await f.audit()).findings);
    expect(result.get(env(24))).toMatchObject({ classification: "SAFE_CANDIDATE" });
  });

  it("a link or junction inside a legacy workspace makes it UNKNOWN", async () => {
    const f = await fixture();
    const current = await f.snapshot("shop", "v1", site("Shop"));
    await f.legacy(env(31), site("Shop"));
    const outside = await mkdtemp(join(tmpdir(), "sites-outside-")); roots.push(outside);
    await symlink(outside, join(f.root, "execution", env(31), "project", "node_modules", "linked"), "junction");
    f.setReferences(refs({ shop: [current] }));
    expect((await f.audit()).findings[0]).toMatchObject({ classification: "UNKNOWN", reason: "LINK_OR_JUNCTION_IN_WORKSPACE" });
  });
});

describe("Retired SQLite store references", () => {
  const createStore = async (root: string, sites: string[]) => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "sites.sqlite"));
    db.exec("CREATE TABLE site_projects (id TEXT); CREATE TABLE site_versions (site_id TEXT); CREATE TABLE site_jobs (site_id TEXT);");
    for (const id of sites) db.prepare("INSERT INTO site_projects (id) VALUES (?)").run(id);
    db.close();
  };
  it("sites recorded only in the legacy store are never orphaned; reading it is non-mutating; unreadable fails closed", async () => {
    const f = await fixture();
    await createStore(f.root, ["old"]);
    for (const attempt of ["a1", "a2", "a3", "a4"]) await f.snapshot("old", attempt, site(`Old ${attempt}`), 40);
    // Oldest first: g1 is beyond the two retained diagnostic attempts.
    for (const [attempt, days] of [["g1", 50], ["g2", 41], ["g3", 40]] as const) await f.snapshot("gone", attempt, site(`Gone ${attempt}`), days);
    await f.legacy(env(41), site("Old a4")); await f.legacy(env(42), site("Gone g3"));
    const storeBefore = await readFile(join(f.root, "sites.sqlite"));
    const legacyIds = await loadLegacyStoreSiteIds(f.root);
    expect(legacyIds).toMatchObject({ available: true, stores: 1 }); expect([...legacyIds.siteIds]).toEqual(["old"]);
    expect(await readFile(join(f.root, "sites.sqlite"))).toEqual(storeBefore);
    expect((await readdir(f.root)).filter(name => name.startsWith("sites.sqlite"))).toEqual(["sites.sqlite"]);

    const plan = await planStorageCleanup({ ...f.inputs(), references: withLegacyStoreReferences({ load: async () => refs({}) }, f.root) });
    const paths = plan.candidates.map(candidate => candidate.path);
    expect(paths.some(path => path.includes("/old/"))).toBe(false);
    expect(plan.protected).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "LEGACY_STORE_SITE", count: 4 })]));
    expect(paths).toContain("artifacts/sites/gone/versions/g1");
    const audit = by(plan.legacyWorkspaceAudit?.findings ?? []);
    expect(audit.get(env(41))).toMatchObject({ classification: "RECOVERABLE", reason: "SITE_RECORDED_ONLY_IN_LEGACY_STORE", matches: [{ role: "LEGACY_STORE_ONLY" }] });
    expect(audit.get(env(42))).toMatchObject({ classification: "SAFE_CANDIDATE", reason: "COPY_OF_SNAPSHOT_FOR_SITE_WITHOUT_PROJECT_RECORD" });

    await writeFile(join(f.root, "sites.sqlite"), "this is not a database");
    const failed = await planStorageCleanup({ ...f.inputs(), references: withLegacyStoreReferences({ load: async () => refs({}) }, f.root) });
    expect(failed).toMatchObject({ referencesAvailable: false, referencesReason: "LEGACY_STORE_UNREADABLE" });
    expect(failed.candidates).toEqual([]);
  });
});

describe("Guarded execution of a legacy workspace candidate", () => {
  it("refuses without the explicitly configured local environment, rechecks immediately before acting, and Recents still restores", async () => {
    const f = await fixture();
    const files = site("Shop");
    const current = await f.snapshot("shop", "v1", files);
    await f.legacy(env(51), files);
    f.setReferences(refs({ shop: [current] }));
    const plan = await planStorageCleanup(f.inputs());
    expect(plan.candidates).toEqual([expect.objectContaining({ category: "LEGACY_WORKSPACE", path: `execution/${env(51)}`, fingerprint: expect.any(String) as unknown })]);
    const artifactsBefore = (await f.files()).filter(entry => entry.startsWith("artifacts"));

    // Missing, remote or mismatched configuration refuses everything (and never echoes credentials).
    for (const [databaseUri, environment, reason] of [
      ["mongodb://127.0.0.1:27017/sites", {}, "EXPECTED_DATA_ROOT_NOT_CONFIGURED"],
      ["mongodb+srv://user:hunter2@cluster0.example.mongodb.net/sites", { ...f.configured, [EXPECTED_DATABASE_ENV]: "cluster0.example.mongodb.net/sites" }, "DATABASE_NOT_LOCAL"],
      ["mongodb://127.0.0.1:27017/other", f.configured, "DATABASE_DOES_NOT_MATCH_EXPECTED"],
      ["mongodb://127.0.0.1:27017/sites", { ...f.configured, [EXPECTED_DATA_ROOT_ENV]: tmpdir() }, "DATA_ROOT_DOES_NOT_MATCH_EXPECTED"],
    ] as const) {
      const [outcome] = await executeCleanupPlan(plan, { ...f.inputs({ databaseUri, environment }), approvedPlanId: plan.planId });
      expect(outcome).toMatchObject({ result: "SKIPPED" }); expect(outcome?.reason).toContain(reason); expect(outcome?.reason).not.toContain("hunter2");
    }
    // A process starting from the workspace after planning is caught by the per-candidate re-audit.
    f.listProcesses.mockResolvedValueOnce([]).mockResolvedValueOnce([{ pid: 77, commandLine: `node ${join(f.root, "execution", env(51), "project", "node_modules", "vite", "bin", "vite.js")}` }]);
    expect((await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId }))[0]).toMatchObject({ result: "SKIPPED", reason: "LEGACY_RECHECK_FAILED:PROCESS_USES_WORKSPACE:77" });
    expect(await stat(join(f.root, "execution", env(51))).then(() => true, () => false)).toBe(true);

    // Approved, configured and still eligible: only the workspace is removed.
    expect(await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId })).toEqual([expect.objectContaining({ path: `execution/${env(51)}`, result: "DELETED" })]);
    expect(await stat(join(f.root, "execution", env(51))).then(() => true, () => false)).toBe(false);
    expect((await f.files()).filter(entry => entry.startsWith("artifacts"))).toEqual(artifactsBefore);
    // Reopening from Recents rebuilds the preview from the saved snapshot alone, byte-for-byte.
    const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
    const restored = await new SiteSourceSnapshotService(new LocalArtifactStore(join(f.root, "artifacts"))).restore(execution as never, environment.id, current);
    expect(restored.files).toEqual(files);
    for (const [path, text] of Object.entries(files)) expect(await execution.readFile(environment.id, path)).toBe(text);
  });

  it("a workspace modified after planning is skipped", async () => {
    const f = await fixture();
    const current = await f.snapshot("shop", "v1", site("Shop"));
    await f.legacy(env(52), site("Shop"));
    f.setReferences(refs({ shop: [current] }));
    const plan = await planStorageCleanup(f.inputs());
    await f.write(`execution/${env(52)}/project/src/App.tsx`, "export default 'edited';");
    await age(join(f.root, "execution", env(52)), 10);
    const [outcome] = await executeCleanupPlan(plan, { ...f.inputs(), approvedPlanId: plan.planId });
    expect(outcome).toMatchObject({ result: "SKIPPED" });
    expect(await stat(join(f.root, "execution", env(52), "project", "src", "App.tsx")).then(() => true, () => false)).toBe(true);
  });
});

describe("Local storage environment check", () => {
  it("parses the MongoDB target without credentials and requires an explicit, local, canonical match", async () => {
    expect(describeDatabase("mongodb+srv://user:secret@cluster0.abc.mongodb.net/prod?retryWrites=true")).toEqual({ scheme: "mongodb+srv", hosts: ["cluster0.abc.mongodb.net"], database: "prod", local: false });
    expect(describeDatabase("mongodb://localhost:27017/sites")).toMatchObject({ local: true, database: "sites" });
    expect(describeDatabase("mongodb://127.0.0.1/")).toBeUndefined();
    expect(describeDatabase(undefined)).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), "sites-env-")); roots.push(root);
    const expected = { [EXPECTED_DATA_ROOT_ENV]: root, [EXPECTED_DATABASE_ENV]: "localhost/sites" };
    expect(await verifyStorageEnvironment({ dataRoot: root, databaseUri: "mongodb://localhost:27017/sites", env: expected })).toMatchObject({ ok: true });
    expect(await verifyStorageEnvironment({ dataRoot: root, databaseUri: "mongodb://localhost:27017,127.0.0.1:27018/sites", env: expected })).toMatchObject({ ok: false, reasons: expect.arrayContaining(["DATABASE_TARGET_AMBIGUOUS"]) as unknown });
    expect(await verifyStorageEnvironment({ dataRoot: root, databaseUri: undefined, env: expected })).toMatchObject({ ok: false, reasons: expect.arrayContaining(["DATABASE_NOT_CONFIGURED_OR_UNPARSABLE"]) as unknown });
    expect(await verifyStorageEnvironment({ dataRoot: root, databaseUri: "mongodb://localhost:27017/sites", env: { ...expected, [EXPECTED_DATABASE_ENV]: "user:pw@localhost/sites" } })).toMatchObject({ ok: false });
    // A junction to the expected root is not the canonical root.
    const alias = join(await mkdtemp(join(tmpdir(), "sites-alias-")), "root"); roots.push(join(alias, ".."));
    await symlink(root, alias, "junction");
    expect(await verifyStorageEnvironment({ dataRoot: alias, databaseUri: "mongodb://localhost:27017/sites", env: expected })).toMatchObject({ ok: false, reasons: expect.arrayContaining(["DATA_ROOT_NOT_CANONICAL"]) as unknown });
  });
});
