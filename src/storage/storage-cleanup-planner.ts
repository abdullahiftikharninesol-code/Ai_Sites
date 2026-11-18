import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LocalArtifactStore } from "../persistence/local-artifact-store.js";
import { SiteSourceSnapshotService } from "../sites/generation/source-snapshot.js";
import { FAILED_CANDIDATE_LIMITS } from "../sites/generation/failed-candidate-evidence.js";
import {
  isProcessAlive,
  listNodeProcesses,
  processOwnershipVerifiable,
  reconcileExecutionWorkspaces,
  workspaceProcessIds,
  type ProcessInfo,
  type ReconciliationReport,
} from "../execution/local/workspace-reconciliation.js";
import { readWorkspaceMarker } from "../execution/local/workspace-ownership.js";
import type { StorageReferenceSnapshot, StorageReferenceSource } from "./storage-references.js";
import { measure, type Measured } from "./storage-tree.js";
import { auditLegacyWorkspaces, type LegacyWorkspaceAudit } from "./legacy-workspace-audit.js";
import { verifyStorageEnvironment } from "./storage-environment.js";
import {
  cleanupIntegrity, createCleanupJournal, recoverCleanupJournals, removeCompletedCleanupRun,
  saveCleanupJournal, syncCleanupDirectory, validCleanupPath, withCleanupLock, type CleanupJournalEntry,
} from "./storage-cleanup-journal.js";

/**
 * Reference-aware storage planning for a Sites data root:
 *
 *   artifacts/sites/<site>/versions/<id>/   one generation/edit attempt (source, build, QA, asset manifest)
 *   artifacts/sites/<site>/current/         legacy current-state snapshot
 *   artifacts/assets/content/<hash>.<ext>   content-addressed uploaded/generated media
 *   execution/<env>/                        local build/preview workspaces (Phase 3A markers;
 *                                           legacy ones without markers are attributed by content)
 *   diagnostics/failed-candidates/          already bounded by FAILED_CANDIDATE_LIMITS
 *
 * Planning never deletes, never stops a process and never trusts an uncertain
 * case: unknown ownership, unavailable references, links/junctions, recent or
 * active data are protected. Execution (not enabled unattended) replans,
 * revalidates each candidate immediately before acting and moves it into a
 * journaled trash so an interruption can be restored.
 */
export type CleanupCategory = "SUPERSEDED_VERSION_ARTIFACTS" | "ORPHANED_SITE_ARTIFACTS" | "UNREFERENCED_ASSET" | "ORPHANED_WORKSPACE" | "RECOVERABLE_WORKSPACE" | "LEGACY_WORKSPACE";
export interface CleanupCandidate {
  readonly id: string;
  readonly category: CleanupCategory;
  /** Relative to the data root, forward slashes. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly newestModifiedMs: number;
  readonly reason: string;
  readonly checks: readonly string[];
  /** LEGACY_WORKSPACE: fingerprint of the snapshot-tracked files, revalidated before acting. */
  readonly fingerprint?: string;
}
export interface ProtectedGroup { readonly reason: string; readonly count: number; readonly sizeBytes: number }
export interface CleanupPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly createdAt: string;
  readonly mode: "DRY_RUN";
  readonly referencesAvailable: boolean;
  readonly referencesReason?: string;
  readonly candidates: readonly CleanupCandidate[];
  readonly protected: readonly ProtectedGroup[];
  readonly totals: { readonly candidates: number; readonly reclaimableBytes: number; readonly protectedBytes: number };
  readonly retention: Readonly<Record<string, string>>;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  /** Evidence for every workspace without an ownership marker. */
  readonly legacyWorkspaceAudit?: LegacyWorkspaceAudit;
}
export interface StoragePolicy {
  /** Anything modified more recently is treated as possibly in use. */
  readonly graceMs: number;
  /** Newest unreferenced attempts kept per site as failure evidence (screenshots, QA, build logs). */
  readonly diagnosticAttemptsPerSite: number;
  readonly workspaceInactivityMs: number;
  readonly maxFilesScanned: number;
  readonly maxReferenceBytes: number;
  readonly maxDurationMs: number;
}
export const DEFAULT_STORAGE_POLICY: StoragePolicy = Object.freeze({
  graceMs: 7 * 24 * 60 * 60 * 1000,
  diagnosticAttemptsPerSite: 2,
  workspaceInactivityMs: 6 * 60 * 60 * 1000,
  maxFilesScanned: 200_000,
  maxReferenceBytes: 512 * 1024 * 1024,
  maxDurationMs: 120_000,
});
export interface PlanInputs {
  readonly dataRoot: string;
  readonly references: StorageReferenceSource;
  /** Workspaces in use by this process (execution provider / preview sessions). */
  readonly activeEnvironmentIds?: ReadonlySet<string>;
  /** Storage keys of uploads not yet referenced by a version (e.g. pending attachments). */
  readonly protectedAssetKeys?: ReadonlySet<string>;
  /** Defaults to the Phase 3A reconciler with process stopping disabled. */
  readonly reconcile?: (root: string) => Promise<ReconciliationReport>;
  /** Process command lines for the legacy workspace audit (defaults to a bounded scan of every process). */
  readonly listProcesses?: (timeoutMs: number) => Promise<readonly ProcessInfo[]>;
  readonly policy?: Partial<StoragePolicy>;
  readonly now?: () => number;
}

const ASSET_NAME = /[0-9a-f]{64}\.[a-z0-9]{2,5}/g;
const slash = (value: string) => value.split(sep).join("/");
const candidateId = (category: string, path: string) => createHash("sha256").update(`${category}\0${path}`).digest("hex").slice(0, 16);

/** A missing directory has no entries; any other listing failure is reported through `unreadable` when given. */
const directories = async (path: string, unreadable?: (path: string) => void) => {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")).map(entry => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable?.(path); return []; }
};

/** Every process (not only node): npm, shells, esbuild and other build tools must be visible. */
const listAllProcesses = (timeoutMs: number) => listNodeProcesses(timeoutMs, { allProcesses: true });

/**
 * `artifactsOnly` (execution-time revalidation of a version/asset candidate)
 * skips the workspace section; everything about artifacts is planned as usual.
 * `metadataOnly` implies artifactsOnly and never reads source/manifest contents;
 * shared-media eligibility cannot be established in that mode.
 */
export async function planStorageCleanup(inputs: PlanInputs, scope: { readonly artifactsOnly?: boolean; readonly metadataOnly?: boolean } = {}): Promise<CleanupPlan> {
  const policy = { ...DEFAULT_STORAGE_POLICY, ...inputs.policy };
  const now = inputs.now ?? Date.now;
  const started = now(), root = resolve(inputs.dataRoot);
  const budget = { files: policy.maxFilesScanned };
  const candidates: CleanupCandidate[] = [];
  const protectedGroups = new Map<string, { count: number; sizeBytes: number }>();
  const warnings: string[] = [];
  let truncated = false;
  const protect = (reason: string, sizeBytes: number) => {
    const group = protectedGroups.get(reason) ?? { count: 0, sizeBytes: 0 };
    group.count++; group.sizeBytes += sizeBytes; protectedGroups.set(reason, group);
  };
  const expired = () => { if (now() - started > policy.maxDurationMs || budget.files <= 0) { truncated = true; return true; } return false; };
  const references: StorageReferenceSnapshot = await inputs.references.load();
  if (!references.available) warnings.push("References unavailable: snapshots, version artifacts and assets are all protected (fail closed)");
  const artifactsRoot = join(root, "artifacts");
  // A ref like sites/<s>/versions/<v>/source/source.json protects sites/<s>/versions/<v>.
  const retainedVersionDir = (ref: string) => ref.split("/").slice(0, 4).join("/");
  const retainedVersionDirs = new Set([...references.retainedSourceRefs.values()].flat().map(ref => ref.startsWith("sites/") && ref.split("/")[2] === "versions" ? retainedVersionDir(ref) : slash(dirname(ref))));
  const referenceTexts: string[] = [];
  let referenceBytes = 0, referencesComplete = references.available && !scope.metadataOnly;
  if (scope.metadataOnly) warnings.push("Metadata-only scan: shared media eligibility requires a content-reference scan");
  // Anything that could name an asset but cannot be read: no asset can be proven unreferenced (fail closed).
  const scanIncomplete = (path: string) => {
    if (scope.metadataOnly) { truncated = true; warnings.push("Metadata retention scan incomplete"); return; }
    if (!referencesComplete) return;
    referencesComplete = false;
    warnings.push(`Reference scan incomplete (${slash(relative(root, path)) || "."} unreadable): all assets protected`);
  };
  const readReferences = async (dir: string) => {
    // Only small JSON documents that can name assets (snapshots, manifests); bounded in total.
    const stack = [dir];
    while (stack.length && referencesComplete) {
      const current = stack.pop()!;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined);
      if (!entries) { scanIncomplete(current); return; }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".json")) {
          const text = await readFile(full, "utf8").catch(() => undefined);
          if (text === undefined) { scanIncomplete(full); return; }
          referenceBytes += text.length;
          if (referenceBytes > policy.maxReferenceBytes) { referencesComplete = false; warnings.push("Reference scan budget exceeded: all assets protected"); return; }
          referenceTexts.push(text);
        }
      }
    }
  };

  // Publishing obligations: version directories a preparation was built from (recovery re-verifies that source)
  // or, defensively, that hold a prepared artifact. The strongest reason wins.
  const publishingVersionDirs = new Map<string, string>();
  const RANK: Record<string, number> = { UNRESOLVED_DEPLOYMENT: 3, PUBLISHED_VERSION: 2, PUBLISHING_PREPARATION: 1 };
  for (const [ref, reason] of [...references.publishing.sourceRefs, ...references.publishing.artifactRefs]) {
    if (!(ref.startsWith("sites/") && ref.split("/")[2] === "versions")) continue;
    const key = retainedVersionDir(ref), existing = publishingVersionDirs.get(key);
    if (!existing || RANK[reason]! > RANK[existing]!) publishingVersionDirs.set(key, reason);
  }

  // --- Version artifacts -----------------------------------------------------
  for (const site of await directories(join(artifactsRoot, "sites"), scanIncomplete)) {
    if (expired()) break;
    const siteRel = `artifacts/sites/${site}`;
    // Prepared production builds (sites/<site>/publishing/...) are never candidates; they may name assets.
    const publishingDir = join(artifactsRoot, "sites", site, "publishing");
    const prepared = await measure(publishingDir, budget);
    if (prepared.files || prepared.partial || prepared.hasLink) { protect("PUBLISHING_ARTIFACTS", prepared.sizeBytes); await readReferences(publishingDir); }
    const versions = await directories(join(artifactsRoot, "sites", site, "versions"), scanIncomplete);
    const attempts: { rel: string; key: string; measured: Measured }[] = [];
    for (const version of versions) {
      if (expired()) break;
      const key = `sites/${site}/versions/${version}`;
      attempts.push({ rel: `${siteRel}/versions/${version}`, key, measured: await measure(join(artifactsRoot, "sites", site, "versions", version), budget) });
    }
    const legacyCurrent = join(artifactsRoot, "sites", site, "current");
    const current = await measure(legacyCurrent, budget);
    if (current.files) { protect("LEGACY_CURRENT_SNAPSHOT", current.sizeBytes); await readReferences(legacyCurrent); }
    const keepAll = (reason: string) => { for (const attempt of attempts) protect(reason, attempt.measured.sizeBytes); };
    if (!references.available) { keepAll("REFERENCES_UNAVAILABLE"); continue; }
    if (references.activeSiteIds.has(site)) { keepAll("ACTIVE_JOB"); for (const attempt of attempts) await readReferences(join(root, attempt.rel)); continue; }
    const known = references.knownSiteIds.has(site);
    // Recorded by the retired SQLite store but not MongoDB: still referenced, never orphaned.
    if (!known && references.legacySiteIds?.has(site)) { keepAll("LEGACY_STORE_SITE"); for (const attempt of attempts) await readReferences(join(root, attempt.rel)); continue; }
    // A publishing record names something that cannot be resolved to files: nothing of this site is provably unneeded.
    if (references.publishing.unresolvedSiteIds.has(site)) { keepAll("PUBLISHING_REFERENCE_UNRESOLVED"); for (const attempt of attempts) await readReferences(join(root, attempt.rel)); continue; }
    const unreferenced: typeof attempts = [];
    for (const attempt of attempts) {
      const dir = join(root, attempt.rel);
      if (retainedVersionDirs.has(attempt.key)) {
        const refs = references.retainedSourceRefs.get(site) ?? [];
        protect(refs[0] && retainedVersionDir(refs[0]) === attempt.key ? "CURRENT_VERSION" : "PREVIOUS_VERSION", attempt.measured.sizeBytes);
        await readReferences(dir);
      } else if (publishingVersionDirs.has(attempt.key)) { protect(publishingVersionDirs.get(attempt.key)!, attempt.measured.sizeBytes); await readReferences(dir); }
      else if (attempt.measured.hasLink || attempt.measured.partial) { protect("UNCERTAIN_TREE", attempt.measured.sizeBytes); await readReferences(dir); }
      else if (started - attempt.measured.newestModifiedMs < policy.graceMs) { protect("RECENT_OR_IN_PROGRESS", attempt.measured.sizeBytes); await readReferences(dir); }
      else unreferenced.push(attempt);
    }
    // Keep the newest failed/superseded attempts as bounded diagnostic evidence.
    unreferenced.sort((a, b) => b.measured.newestModifiedMs - a.measured.newestModifiedMs);
    for (const [index, attempt] of unreferenced.entries()) {
      if (index < policy.diagnosticAttemptsPerSite) { protect("RETAINED_DIAGNOSTIC_ATTEMPT", attempt.measured.sizeBytes); await readReferences(join(root, attempt.rel)); continue; }
      const category: CleanupCategory = known ? "SUPERSEDED_VERSION_ARTIFACTS" : "ORPHANED_SITE_ARTIFACTS";
      candidates.push({ id: candidateId(category, attempt.rel), category, path: attempt.rel, sizeBytes: attempt.measured.sizeBytes, newestModifiedMs: attempt.measured.newestModifiedMs,
        reason: known ? "Not the current or previous version, older than the grace period, beyond the retained diagnostic attempts"
          : "Site has no project record; older than the grace period, beyond the retained diagnostic attempts",
        checks: ["NOT_CURRENT_OR_PREVIOUS", "NO_ACTIVE_JOB", "OUTSIDE_GRACE_PERIOD", "NO_LINKS", `KEPT_NEWEST_${policy.diagnosticAttemptsPerSite}_ATTEMPTS`] });
    }
  }

  // --- Content-addressed assets ------------------------------------------------
  const assetsDir = join(artifactsRoot, "assets", "content");
  const referencedAssets = new Set<string>();
  for (const text of referenceTexts) for (const match of text.matchAll(ASSET_NAME)) referencedAssets.add(match[0]);
  for (const key of inputs.protectedAssetKeys ?? []) referencedAssets.add(key.split("/").at(-1)!);
  for (const entry of await readdir(assetsDir, { withFileTypes: true }).catch(() => [])) {
    if (expired()) break;
    const measured = await measure(join(assetsDir, entry.name), budget);
    if (!references.available || !referencesComplete) protect("REFERENCES_UNAVAILABLE", measured.sizeBytes);
    else if (entry.isSymbolicLink() || measured.hasLink || measured.partial || !entry.isFile()) protect("UNCERTAIN_TREE", measured.sizeBytes);
    else if (referencedAssets.has(entry.name)) protect("REFERENCED_ASSET", measured.sizeBytes);
    else if (started - measured.newestModifiedMs < policy.graceMs) protect("RECENT_OR_PENDING_UPLOAD", measured.sizeBytes);
    else {
      const rel = `artifacts/assets/content/${entry.name}`;
      candidates.push({ id: candidateId("UNREFERENCED_ASSET", rel), category: "UNREFERENCED_ASSET", path: rel, sizeBytes: measured.sizeBytes, newestModifiedMs: measured.newestModifiedMs,
        reason: "Not referenced by any retained, recent, active or diagnostic version, nor pending; older than the grace period",
        checks: ["NOT_IN_RETAINED_SNAPSHOTS", "NOT_IN_ASSET_MANIFESTS", "NOT_PENDING_UPLOAD", "OUTSIDE_GRACE_PERIOD"] });
    }
  }

  // --- Execution workspaces (Phase 3A reconciler, never stopping processes here) ---
  let legacyAudit: LegacyWorkspaceAudit | undefined;
  if (!scope.artifactsOnly && !scope.metadataOnly) {
  const executionRoot = join(root, "execution");
  const report = await (inputs.reconcile ?? (path => reconcileExecutionWorkspaces({ root: path, stopOrphanPreviews: false,
    listProcesses: inputs.listProcesses ?? listAllProcesses,
    isVersionRecoverable: (siteId) => Promise.resolve((references.retainedSourceRefs.get(siteId)?.length ?? 0) > 0) })))(executionRoot);
  const snapshots = new SiteSourceSnapshotService(new LocalArtifactStore(artifactsRoot));
  const restorable = new Map<string, boolean>();
  // Workspaces without markers: attributed by byte-identical snapshot content (read-only).
  legacyAudit = report.entries.some(entry => entry.state === "UNKNOWN")
    ? await auditLegacyWorkspaces({ dataRoot: root, references, inactivityMs: policy.workspaceInactivityMs, now,
      maxDurationMs: Math.max(1_000, policy.maxDurationMs - (now() - started)), maxFilesScanned: Math.max(1, budget.files),
      ...(inputs.activeEnvironmentIds ? { activeEnvironmentIds: inputs.activeEnvironmentIds } : {}),
      ...(inputs.listProcesses ? { listProcesses: inputs.listProcesses } : {}) })
    : undefined;
  if (legacyAudit?.truncated) truncated = true;
  const legacy = new Map(legacyAudit?.findings.map(finding => [finding.environmentId, finding]));
  for (const entry of report.entries) {
    if (expired()) break;
    const rel = `execution/${entry.environmentId}`;
    const measured = await measure(join(executionRoot, entry.environmentId), budget);
    // Activity is judged from the project tree: reconciliation/ownership markers
    // beside it must not make an idle workspace look recently used.
    const activity = await measure(join(executionRoot, entry.environmentId, "project"), { files: budget.files });
    const inUse = inputs.activeEnvironmentIds?.has(entry.environmentId) || entry.previewProcesses > 0;
    if (entry.state === "ACTIVE" || inUse) { protect(inUse ? "WORKSPACE_IN_USE" : "ACTIVE_WORKSPACE", measured.sizeBytes); continue; }
    // npm, build tools, their descendants, or children the dead owner left running.
    if ((entry.workspaceProcesses ?? 0) > 0) { protect("WORKSPACE_PROCESS_RUNNING", measured.sizeBytes); continue; }
    if (entry.state === "UNKNOWN") {
      const finding = legacy.get(entry.environmentId);
      if (finding?.classification === "SAFE_CANDIDATE" && !measured.hasLink && !measured.partial) {
        candidates.push({ id: candidateId("LEGACY_WORKSPACE", rel), category: "LEGACY_WORKSPACE", path: rel, sizeBytes: measured.sizeBytes, newestModifiedMs: finding.newestModifiedMs,
          reason: `Legacy workspace without ownership marker: ${finding.reason}`, checks: ["NO_OWNERSHIP_MARKER", ...finding.evidence], fingerprint: finding.sourceFingerprint });
      } else protect(finding?.classification === "ACTIVE" ? "LEGACY_WORKSPACE_ACTIVE" : finding?.classification === "RECOVERABLE" ? "LEGACY_WORKSPACE_RECOVERABLE" : "UNKNOWN_WORKSPACE_OWNERSHIP", measured.sizeBytes);
      continue;
    }
    if (report.processScan !== "OK") { protect("PROCESS_SCAN_UNAVAILABLE", measured.sizeBytes); continue; }
    // Without parent PIDs a dead owner's running children cannot be ruled out (absent: an older report, also unverified).
    if (report.processOwnership !== "OK") { protect("PROCESS_OWNERSHIP_UNVERIFIED", measured.sizeBytes); continue; }
    if (measured.hasLink || measured.partial) { protect("UNCERTAIN_TREE", measured.sizeBytes); continue; }
    if (started - activity.newestModifiedMs < policy.workspaceInactivityMs) { protect("RECENTLY_ACTIVE_WORKSPACE", measured.sizeBytes); continue; }
    if (entry.state === "RECOVERABLE") {
      // Only a cache of a saved version whose snapshot verifies byte-for-byte.
      const site = entry.siteId ?? "";
      if (!restorable.has(site)) {
        const refs = references.retainedSourceRefs.get(site) ?? [];
        restorable.set(site, references.available && refs.length > 0 &&
          (await Promise.all(refs.map(ref => snapshots.verify(ref).then(() => true, () => false)))).every(Boolean));
      }
      if (!restorable.get(site)) { protect("RECOVERABLE_SOURCE_NOT_VERIFIED", measured.sizeBytes); continue; }
    }
    const category: CleanupCategory = entry.state === "RECOVERABLE" ? "RECOVERABLE_WORKSPACE" : "ORPHANED_WORKSPACE";
    candidates.push({ id: candidateId(category, rel), category, path: rel, sizeBytes: measured.sizeBytes, newestModifiedMs: activity.newestModifiedMs,
      reason: entry.state === "RECOVERABLE" ? "Preview cache of a saved version whose snapshot verifies; owner exited; no process; inactive"
        : "Owner server exited; no process in the workspace; not used by this server; inactive",
      checks: ["OWNERSHIP_MARKER_VALID", "OWNER_PROCESS_EXITED", "NO_WORKSPACE_PROCESS", "NOT_ACTIVE_IN_THIS_SERVER", "NO_LINKS", "INACTIVE",
        ...(entry.state === "RECOVERABLE" ? ["SOURCE_SNAPSHOT_VERIFIED"] : [])] });
  }
  if (report.truncated) truncated = true;
  }

  const protectedList = [...protectedGroups].map(([reason, group]) => ({ reason, ...group })).sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    schemaVersion: 1, planId: randomUUID(), createdAt: new Date(started).toISOString(), mode: "DRY_RUN",
    referencesAvailable: references.available, ...(references.reason ? { referencesReason: references.reason } : {}),
    candidates, protected: protectedList,
    totals: { candidates: candidates.length, reclaimableBytes: candidates.reduce((sum, item) => sum + item.sizeBytes, 0), protectedBytes: protectedList.reduce((sum, item) => sum + item.sizeBytes, 0) },
    retention: {
      versions: "Current and previous verified versions always; plus the newest attempts per site as diagnostics; anything within the grace period",
      failedCandidateEvidence: `Bounded by existing policy: ${FAILED_CANDIDATE_LIMITS.maxFiles} files, ${FAILED_CANDIDATE_LIMITS.maxBytes} bytes each, ${FAILED_CANDIDATE_LIMITS.maxAgeMs} ms`,
      reconciliationReport: "Single latest report (overwritten)",
      dependencyCaches: "npm and Playwright caches are never planned for cleanup",
    },
    truncated, warnings, ...(legacyAudit ? { legacyWorkspaceAudit: legacyAudit } : {}),
  };
}

// ---------------------------------------------------------------------------
// Guarded execution (explicit approval only; not wired to any unattended path)
// ---------------------------------------------------------------------------

export interface ExecutionOutcome { readonly id: string; readonly path: string; readonly result: "DELETED" | "SKIPPED"; readonly reason: string }
export interface ExecuteOptions extends PlanInputs {
  /** Must equal plan.planId: deletion is never implied by a plan. */
  readonly approvedPlanId: string;
  /** MongoDB URI in use; must match the explicitly configured local environment. */
  readonly databaseUri: string | undefined;
  /** Source of the expected-environment configuration (defaults to process.env). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test hook: simulate a crash after a candidate was moved to the trash. */
  readonly afterMove?: (candidate: CleanupCandidate) => Promise<void> | void;
  /** Uploads not yet referenced by a version, read fresh before each asset (a failure refuses the asset). */
  readonly pendingAssetKeys?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  /**
   * How long a version-candidate replan may be reused. Default 0: replan every
   * candidate. Assets always require a fresh reference scan, regardless of this setting.
   */
  readonly revalidationMaxAgeMs?: number;
}

const ARTIFACT_CATEGORIES: ReadonlySet<CleanupCategory> = new Set(["SUPERSEDED_VERSION_ARTIFACTS", "ORPHANED_SITE_ARTIFACTS", "UNREFERENCED_ASSET"]);
const assetName = (key: string) => key.split("/").at(-1)!;
/** Bind an asset scan to the reference graph it actually inspected, independent of query ordering. */
const referenceSignature = (references: StorageReferenceSnapshot) => JSON.stringify([
  references.available,
  [...references.retainedSourceRefs].sort(([a], [b]) => a.localeCompare(b)),
  [...references.knownSiteIds].sort(), [...references.activeSiteIds].sort(), [...(references.legacySiteIds ?? [])].sort(),
  [...references.publishing.sourceRefs].sort(([a], [b]) => a.localeCompare(b)),
  [...references.publishing.artifactRefs].sort(([a], [b]) => a.localeCompare(b)),
  [...references.publishing.unresolvedSiteIds].sort(),
]);

/** Rejects traversal, unexpected shapes and any link/junction on the path or inside the tree. */
async function assertSafeTarget(root: string, candidate: CleanupCandidate): Promise<string> {
  const rel = candidate.path;
  if (!validCleanupPath(candidate))
    throw new Error("UNSAFE_PATH_SHAPE");
  const realRoot = await realpath(root);
  const target = resolve(root, ...rel.split("/"));
  const inside = relative(root, target);
  if (!inside || inside.startsWith("..") || resolve(inside) === inside) throw new Error("PATH_ESCAPES_ROOT");
  let cursor = root;
  for (const part of rel.split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("LINK_ON_PATH");
  }
  const realTarget = await realpath(target);
  const realInside = relative(realRoot, realTarget);
  if (!realInside || realInside.startsWith("..") || slash(realInside).toLowerCase() !== rel.toLowerCase()) throw new Error("REALPATH_MISMATCH");
  const measured = await measure(target, { files: DEFAULT_STORAGE_POLICY.maxFilesScanned });
  if (measured.hasLink || measured.partial) throw new Error("UNCERTAIN_TREE");
  return target;
}

/** Puts back anything an interrupted run moved but did not finish deleting. */
export async function recoverInterruptedCleanup(dataRoot: string): Promise<{ readonly restored: readonly string[]; readonly unresolved: readonly string[] }> {
  return withCleanupLock(dataRoot, () => recoverCleanupJournals(dataRoot));
}

export async function executeCleanupPlan(plan: CleanupPlan, options: ExecuteOptions): Promise<readonly ExecutionOutcome[]> {
  return withCleanupLock(options.dataRoot, () => executeLockedCleanupPlan(plan, options));
}

async function executeLockedCleanupPlan(plan: CleanupPlan, options: ExecuteOptions): Promise<readonly ExecutionOutcome[]> {
  const root = resolve(options.dataRoot);
  if (options.approvedPlanId !== plan.planId) return plan.candidates.map(candidate => ({ id: candidate.id, path: candidate.path, result: "SKIPPED" as const, reason: "PLAN_NOT_APPROVED" }));
  // The process must be pointed at the explicitly configured local database and data root.
  const environment = await verifyStorageEnvironment({ dataRoot: root, databaseUri: options.databaseUri, ...(options.environment ? { env: options.environment } : {}) });
  if (!environment.ok) return plan.candidates.map(candidate => ({ id: candidate.id, path: candidate.path, result: "SKIPPED" as const, reason: `STORAGE_ENVIRONMENT_REFUSED:${environment.reasons.join(",")}` }));
  const recovery = await recoverCleanupJournals(root);
  if (recovery.unresolved.length) return plan.candidates.map(candidate => ({ id: candidate.id, path: candidate.path, result: "SKIPPED" as const, reason: "RECOVERY_UNRESOLVED" }));
  // Revalidate against fresh references, reconciliation and file times.
  const fresh = await planStorageCleanup(options);
  const eligible = new Map(fresh.candidates.map(candidate => [candidate.id, candidate]));
  const { runDir, journal } = await createCleanupJournal(root, plan.planId);
  const save = () => saveCleanupJournal(runDir, journal);
  const outcomes: ExecutionOutcome[] = [];
  // Version/asset candidates are re-planned (fresh references and filesystem scan) right before each action.
  let artifactPlan: { readonly plan: CleanupPlan; readonly at: number; readonly references: string } | undefined;
  const revalidationMaxAgeMs = Math.max(0, options.revalidationMaxAgeMs ?? 0);
  for (const planned of plan.candidates) {
    const skip = (reason: string) => outcomes.push({ id: planned.id, path: planned.path, result: "SKIPPED", reason });
    const now = eligible.get(planned.id);
    if (!now) { skip("NO_LONGER_ELIGIBLE"); continue; }
    if (now.newestModifiedMs !== planned.newestModifiedMs || now.sizeBytes !== planned.sizeBytes) { skip("CHANGED_SINCE_PLAN"); continue; }
    const artifact = ARTIFACT_CATEGORIES.has(planned.category);
    // Pending uploads, read fresh (a failure to read them refuses any asset).
    let pending: ReadonlySet<string> = new Set();
    if (planned.category === "UNREFERENCED_ASSET" && options.pendingAssetKeys) {
      const read = await Promise.resolve().then(() => options.pendingAssetKeys!()).catch(() => undefined);
      if (!read) { skip("PENDING_UPLOADS_UNVERIFIED"); continue; }
      pending = read;
      if ([...pending].some(key => assetName(key) === assetName(planned.path))) { skip("PENDING_UPLOAD"); continue; }
    }
    if (artifact) {
      if (planned.category === "UNREFERENCED_ASSET" || !artifactPlan || revalidationMaxAgeMs === 0 || Date.now() - artifactPlan.at >= revalidationMaxAgeMs) {
        const protectedAssetKeys = new Set([...(options.protectedAssetKeys ?? []), ...pending]);
        let scannedReferences: string | undefined;
        const replanned = await planStorageCleanup({ ...options, protectedAssetKeys, references: { load: async () => {
          const snapshot = await options.references.load();
          scannedReferences = referenceSignature(snapshot);
          return snapshot;
        } } }, { artifactsOnly: true }).catch(() => undefined);
        if (!replanned || scannedReferences === undefined) { skip("REVALIDATION_FAILED"); artifactPlan = undefined; continue; }
        artifactPlan = { plan: replanned, at: Date.now(), references: scannedReferences };
      }
      const current = artifactPlan.plan;
      if (!current.referencesAvailable) { skip("REFERENCES_UNAVAILABLE"); continue; }
      const again = current.candidates.find(candidate => candidate.id === planned.id);
      if (!again) {
        const incomplete = planned.category === "UNREFERENCED_ASSET" && current.warnings.some(warning => /^Reference scan/.test(warning));
        // A re-upload may have become too recent to appear in the new plan. Keep the existing changed-file outcome.
        if (!incomplete && !current.truncated) {
          const tree = await measure(resolve(root, ...now.path.split("/")), { files: DEFAULT_STORAGE_POLICY.maxFilesScanned });
          if (tree.partial || tree.hasLink || tree.newestModifiedMs !== planned.newestModifiedMs || tree.sizeBytes !== planned.sizeBytes) { skip("CHANGED_SINCE_PLAN"); continue; }
        }
        skip(incomplete ? "REFERENCES_INCOMPLETE" : current.truncated ? "REVALIDATION_INCOMPLETE" : "NO_LONGER_ELIGIBLE"); continue;
      }
      if (again.newestModifiedMs !== planned.newestModifiedMs || again.sizeBytes !== planned.sizeBytes) { skip("CHANGED_SINCE_PLAN"); continue; }
    }
    // Immediately before acting: references and ownership once more.
    const references = await options.references.load().catch(() => undefined);
    if (!references?.available) { skip("REFERENCES_UNAVAILABLE"); continue; }
    const site = planned.path.split("/")[2] ?? "";
    if (artifact) {
      if (planned.category === "UNREFERENCED_ASSET") {
        if (referenceSignature(references) !== artifactPlan!.references) { skip("REFERENCES_CHANGED"); continue; }
        // A pending upload can appear while the filesystem reference scan is in flight.
        if (options.pendingAssetKeys) {
          const read = await Promise.resolve().then(() => options.pendingAssetKeys!()).catch(() => undefined);
          if (!read) { skip("PENDING_UPLOADS_UNVERIFIED"); continue; }
          if ([...read].some(key => assetName(key) === assetName(planned.path))) { skip("PENDING_UPLOAD"); continue; }
        }
      }
      if (planned.category !== "UNREFERENCED_ASSET" && references.activeSiteIds.has(site)) { skip("ACTIVE_JOB"); continue; }
      if (planned.category === "ORPHANED_SITE_ARTIFACTS" && (references.knownSiteIds.has(site) || references.legacySiteIds?.has(site))) { skip("SITE_NOW_RECORDED"); continue; }
      const key = planned.path.replace(/^artifacts\//, "");
      if ([...references.retainedSourceRefs.values()].flat().some(ref => ref.startsWith(`${key}/`) || ref.includes(assetName(planned.path)))) { skip("NOW_REFERENCED"); continue; }
      if (planned.category !== "UNREFERENCED_ASSET") {
        // A publishing operation, preparation or publication that appeared after planning.
        if (references.publishing.unresolvedSiteIds.has(site)) { skip("PUBLISHING_REFERENCE_UNRESOLVED"); continue; }
        if ([...references.publishing.sourceRefs.keys(), ...references.publishing.artifactRefs.keys()].some(ref => ref.startsWith(`${key}/`))) { skip("PUBLISHING_REFERENCED"); continue; }
      }
    } else if (planned.category === "LEGACY_WORKSPACE") {
      // Re-audit this one workspace now: idle, unused, still byte-identical to a verified snapshot.
      const environmentId = planned.path.split("/")[1]!;
      const recheck = await auditLegacyWorkspaces({ dataRoot: root, references, only: new Set([environmentId]), inactivityMs: { ...DEFAULT_STORAGE_POLICY, ...options.policy }.workspaceInactivityMs,
        ...(options.now ? { now: options.now } : {}), ...(options.activeEnvironmentIds ? { activeEnvironmentIds: options.activeEnvironmentIds } : {}),
        ...(options.listProcesses ? { listProcesses: options.listProcesses } : {}) }).catch(() => undefined);
      const finding = recheck?.findings[0];
      if (!finding || finding.classification !== "SAFE_CANDIDATE" || !planned.fingerprint || finding.sourceFingerprint !== planned.fingerprint) { skip(`LEGACY_RECHECK_FAILED:${finding?.reason ?? "NOT_FOUND"}`); continue; }
    } else {
      const environmentId = planned.path.split("/")[1]!;
      const marker = await readWorkspaceMarker(resolve(root, ...planned.path.split("/")));
      if (!marker || marker.environmentId !== environmentId || (marker.ownerPid !== process.pid && isProcessAlive(marker.ownerPid)) || marker.ownerPid === process.pid || options.activeEnvironmentIds?.has(marker.environmentId)) { skip("OWNERSHIP_NOT_CONFIRMED"); continue; }
      // A fresh scan of every process: npm, Vite, build tools, their descendants or the dead owner's children.
      const processes = await (options.listProcesses ?? listAllProcesses)(8_000).catch(() => undefined);
      if (!processes) { skip("PROCESS_SCAN_UNAVAILABLE"); continue; }
      if (!processOwnershipVerifiable(processes)) { skip("PROCESS_OWNERSHIP_UNVERIFIED"); continue; }
      if (workspaceProcessIds(join(root, "execution"), environmentId, processes, marker.ownerPid).length) { skip("WORKSPACE_PROCESS_RUNNING"); continue; }
    }
    let target: string;
    try { target = await assertSafeTarget(root, planned); } catch (error) { skip(error instanceof Error ? error.message : "UNSAFE_TARGET"); continue; }
    // Last look, just before the move: unchanged since it was planned (catches late writes, e.g. a re-upload of the same asset).
    const finalTree = await measure(target, { files: DEFAULT_STORAGE_POLICY.maxFilesScanned });
    const finalNewest = planned.category === "ORPHANED_WORKSPACE" || planned.category === "RECOVERABLE_WORKSPACE"
      ? (await measure(join(target, "project"), { files: DEFAULT_STORAGE_POLICY.maxFilesScanned })).newestModifiedMs : finalTree.newestModifiedMs;
    if (finalTree.partial || finalTree.hasLink || finalTree.sizeBytes !== planned.sizeBytes || (planned.category !== "LEGACY_WORKSPACE" && finalNewest !== planned.newestModifiedMs)) { skip("CHANGED_SINCE_PLAN"); continue; }
    const trash = `${journal.entries.length}`;
    const entry: CleanupJournalEntry = { candidate: planned, trash, integrity: await cleanupIntegrity(target), state: "PREPARED" };
    journal.entries.push(entry);
    await save(); // Durable write-ahead intent, before the first filesystem move.
    const destination = join(runDir, trash);
    const destinationExists = await lstat(destination).then(() => true, (error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    });
    if (destinationExists) throw new Error("QUARANTINE_DESTINATION_EXISTS");
    await rename(target, join(runDir, trash));
    await syncCleanupDirectory(dirname(target));
    await syncCleanupDirectory(runDir);
    entry.state = "MOVED";
    await save();
    await options.afterMove?.(planned);
    entry.state = "DELETING"; await save();
    await rm(join(runDir, trash), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    await syncCleanupDirectory(runDir);
    entry.state = "DELETED"; await save();
    outcomes.push({ id: planned.id, path: planned.path, result: "DELETED", reason: now.category });
  }
  await removeCompletedCleanupRun(root, runDir);
  return outcomes;
}
