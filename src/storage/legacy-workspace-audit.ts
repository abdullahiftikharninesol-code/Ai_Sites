import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LocalArtifactStore } from "../persistence/local-artifact-store.js";
import { isSnapshotSourcePath, SiteSourceSnapshotService, type SiteSourceSnapshot } from "../sites/generation/source-snapshot.js";
import { readWorkspaceMarker, WORKSPACE_MARKER } from "../execution/local/workspace-ownership.js";
import { listNodeProcesses, ORPHAN_CANDIDATE_MARKER, type ProcessInfo } from "../execution/local/workspace-reconciliation.js";
import type { StorageReferenceSnapshot } from "./storage-references.js";
import { measure } from "./storage-tree.js";

/**
 * Evidence-based audit of legacy execution workspaces: those created before
 * Phase 3A ownership markers existed. Read-only: it never writes into, marks,
 * stops or deletes a workspace.
 *
 * A legacy workspace carries no site/version id, so it is attributed by
 * content: every snapshot-tracked file (the exact set a source snapshot
 * captures) is hashed and compared with every saved snapshot manifest. Only a
 * byte-identical match proves the workspace is a redundant copy.
 *
 *   SAFE_CANDIDATE  idle, no process/job/server use, byte-identical to a saved
 *                   snapshot that verifies, and every matched website that is
 *                   still recorded can be restored from its own verified
 *                   current/previous snapshots and assets (preview restore
 *                   never reads an old workspace)
 *   ACTIVE          in use: this server, a process running from it, an active
 *                   job for its website, or recent file activity
 *   RECOVERABLE     its content is recoverable from a verified saved snapshot,
 *                   but deletion is not approved: the workspace holds files no
 *                   snapshot contains (unsaved), or its website is recorded only
 *                   in the retired SQLite store (a remaining reference outside Recents)
 *   UNKNOWN         ownership or integrity cannot be established (no matching
 *                   snapshot, integrity failure, links, scan/references unavailable)
 */
export type LegacyWorkspaceClass = "SAFE_CANDIDATE" | "ACTIVE" | "RECOVERABLE" | "UNKNOWN";
export type SnapshotRole = "CURRENT" | "PREVIOUS" | "SUPERSEDED" | "LEGACY_STORE_ONLY" | "NO_PROJECT_RECORD";
export interface SnapshotMatch {
  readonly siteId: string;
  /** Version attempt directory id, or "current" for the legacy current snapshot. */
  readonly attempt: string;
  readonly role: SnapshotRole;
  readonly siteRecorded: boolean;
}
export interface LegacyWorkspaceFinding {
  readonly environmentId: string;
  /** Relative to the data root, forward slashes. */
  readonly path: string;
  readonly classification: LegacyWorkspaceClass;
  readonly reason: string;
  readonly sizeBytes: number;
  readonly files: number;
  readonly newestModifiedMs: number;
  readonly identifiers: { readonly packageName?: string; readonly templateKey?: string; readonly title?: string };
  readonly sourceFiles: number;
  /** Fingerprint of the snapshot-tracked files (revalidated before any deletion). */
  readonly sourceFingerprint: string;
  readonly unsavedFiles: readonly string[];
  readonly matches: readonly SnapshotMatch[];
  readonly matchCount: number;
  readonly bestPartialMatch?: { readonly siteId: string; readonly attempt: string; readonly matchingFiles: number; readonly workspaceFiles: number; readonly snapshotFiles: number };
  readonly evidence: readonly string[];
}
export interface LegacyWorkspaceAudit {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly createdAt: string;
  readonly durationMs: number;
  readonly referencesAvailable: boolean;
  readonly processScan: "OK" | "UNAVAILABLE";
  readonly truncated: boolean;
  readonly markedWorkspacesSkipped: number;
  readonly totals: Readonly<Record<LegacyWorkspaceClass, { readonly count: number; readonly sizeBytes: number }>>;
  readonly findings: readonly LegacyWorkspaceFinding[];
}
export interface LegacyAuditInputs {
  readonly dataRoot: string;
  readonly references: StorageReferenceSnapshot;
  /** Workspaces in use by this server process. */
  readonly activeEnvironmentIds?: ReadonlySet<string>;
  /** Defaults to a bounded scan of every process's command line. */
  readonly listProcesses?: (timeoutMs: number) => Promise<readonly ProcessInfo[]>;
  /** Restrict to these environment ids (revalidation of single candidates). */
  readonly only?: ReadonlySet<string>;
  readonly inactivityMs?: number;
  readonly maxFilesScanned?: number;
  readonly maxDurationMs?: number;
  readonly maxManifestBytes?: number;
  readonly now?: () => number;
}

/** Workspace content that the restore path regenerates and no snapshot needs. */
const REGENERABLE_DIRS = new Set(["node_modules", "dist", ".vite"]);
/** Template manifest copied from the template archive; deliberately not snapshotted. */
const REGENERABLE_FILES = new Set(["site-template.json"]);
const ENVIRONMENT_METADATA = new Set([WORKSPACE_MARKER, ORPHAN_CANDIDATE_MARKER]);
const ASSET_REFERENCE = /\/__sites\/assets\/([0-9a-f]{64})\.([a-z0-9]{2,5})/g;

interface IndexedManifest { readonly siteId: string; readonly attempt: string; readonly ref: string; readonly files: ReadonlyMap<string, string> }
const fingerprintOf = (files: ReadonlyMap<string, string>) =>
  createHash("sha256").update([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, sha]) => `${path}\0${sha}`).join("\n")).digest("hex");
const normalizePath = (value: string) => {
  const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};
const dirs = async (path: string) => {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")).map(entry => entry.name).sort(); }
  catch { return []; }
};

export async function auditLegacyWorkspaces(inputs: LegacyAuditInputs): Promise<LegacyWorkspaceAudit> {
  const now = inputs.now ?? Date.now;
  const started = now(), root = resolve(inputs.dataRoot);
  const deadline = started + (inputs.maxDurationMs ?? 120_000);
  const budget = { files: inputs.maxFilesScanned ?? 200_000 };
  const inactivityMs = inputs.inactivityMs ?? 6 * 60 * 60 * 1000;
  const references = inputs.references;
  const artifactsRoot = join(root, "artifacts"), executionRoot = join(root, "execution");
  let truncated = false;

  let processScan: LegacyWorkspaceAudit["processScan"] = "OK";
  let processes: readonly ProcessInfo[] = [];
  try { processes = await (inputs.listProcesses ?? ((timeout: number) => listNodeProcesses(timeout, { allProcesses: true })))(8_000); }
  catch { processScan = "UNAVAILABLE"; }

  // --- Index every saved snapshot manifest by exact content fingerprint ----------
  const byFingerprint = new Map<string, IndexedManifest[]>();
  const manifests: IndexedManifest[] = [];
  let manifestBytes = 0;
  const maxManifestBytes = inputs.maxManifestBytes ?? 256 * 1024 * 1024;
  const index = async (siteId: string, attempt: string, sourceDir: string, ref: string) => {
    const text = await readFile(join(sourceDir, "manifest.json"), "utf8").catch(() => undefined);
    if (text === undefined) return;
    manifestBytes += text.length;
    if (manifestBytes > maxManifestBytes) { truncated = true; return; }
    try {
      const manifest = JSON.parse(text) as { files?: { path?: unknown; sha256?: unknown }[] };
      if (!Array.isArray(manifest.files)) return;
      const files = new Map(manifest.files.filter(file => typeof file.path === "string" && typeof file.sha256 === "string").map(file => [file.path as string, file.sha256 as string]));
      const entry = { siteId, attempt, ref, files };
      manifests.push(entry);
      const key = fingerprintOf(files);
      byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), entry]);
    } catch { /* An unreadable manifest proves nothing. */ }
  };
  for (const site of await dirs(join(artifactsRoot, "sites"))) {
    for (const attempt of await dirs(join(artifactsRoot, "sites", site, "versions")))
      await index(site, attempt, join(artifactsRoot, "sites", site, "versions", attempt, "source"), `sites/${site}/versions/${attempt}/source/source.json`);
    await index(site, "current", join(artifactsRoot, "sites", site, "current"), `sites/${site}/current/source.json`);
  }

  // --- Integrity helpers (cached per snapshot / asset / site) --------------------
  const snapshots = new SiteSourceSnapshotService(new LocalArtifactStore(artifactsRoot));
  const verified = new Map<string, Promise<SiteSourceSnapshot | undefined>>();
  const verify = (ref: string) => {
    if (!verified.has(ref)) verified.set(ref, snapshots.verify(ref).catch(() => undefined));
    return verified.get(ref)!;
  };
  const assetOk = new Map<string, Promise<boolean>>();
  const contentAsset = (hash: string, extension: string) => {
    const name = `${hash}.${extension}`;
    if (!assetOk.has(name)) assetOk.set(name, readFile(join(artifactsRoot, "assets", "content", name))
      .then(bytes => createHash("sha256").update(bytes).digest("hex") === hash, () => false));
    return assetOk.get(name)!;
  };
  /** Snapshot verifies and every managed asset it references is available outside any workspace. */
  const restorable = async (ref: string): Promise<string | undefined> => {
    const snapshot = await verify(ref);
    if (!snapshot) return "SNAPSHOT_INTEGRITY_FAILED";
    const bundled = new Set(snapshot.manifest.files.map(file => file.path));
    for (const file of snapshot.manifest.files) {
      if (file.encoding === "base64") continue;
      for (const match of (snapshot.files[file.path] ?? "").matchAll(ASSET_REFERENCE)) {
        if (bundled.has(`public/__sites/assets/${match[1]}.${match[2]}`)) continue; // verified with the snapshot
        if (!(await contentAsset(match[1]!, match[2]!))) return "ASSET_MISSING_OR_CORRUPT";
      }
    }
    return undefined;
  };
  const siteState = new Map<string, Promise<string | undefined>>();
  const siteRestorable = (siteId: string) => {
    if (!siteState.has(siteId)) siteState.set(siteId, (async () => {
      const refs = references.retainedSourceRefs.get(siteId) ?? [];
      if (!refs.length) return "SITE_HAS_NO_SAVED_VERSION";
      for (const ref of refs) { const problem = await restorable(ref); if (problem) return `${ref === refs[0] ? "CURRENT" : "PREVIOUS"}_${problem}`; }
      return undefined;
    })());
    return siteState.get(siteId)!;
  };
  const roleOf = (entry: IndexedManifest): SnapshotRole => {
    if (!references.knownSiteIds.has(entry.siteId)) return references.legacySiteIds?.has(entry.siteId) ? "LEGACY_STORE_ONLY" : "NO_PROJECT_RECORD";
    const refs = references.retainedSourceRefs.get(entry.siteId) ?? [];
    return entry.ref === refs[0] ? "CURRENT" : entry.ref === refs[1] ? "PREVIOUS" : "SUPERSEDED";
  };

  // --- Workspaces -------------------------------------------------------------
  const findings: LegacyWorkspaceFinding[] = [];
  let markedWorkspacesSkipped = 0;
  const environments = (await dirs(executionRoot)).filter(id => !inputs.only || inputs.only.has(id));
  for (const environmentId of environments) {
    if (now() > deadline || budget.files <= 0) { truncated = true; break; }
    const directory = join(executionRoot, environmentId);
    if (await readWorkspaceMarker(directory) || await readFile(join(directory, WORKSPACE_MARKER)).then(() => true, () => false)) {
      markedWorkspacesSkipped++; // Marker-bearing workspaces are classified by Phase 3A/3B.
      continue;
    }
    const project = join(directory, "project");
    const measured = await measure(directory, budget);
    const activity = await measure(project, { files: budget.files });
    const evidence: string[] = [];
    const identifiers: { packageName?: string; templateKey?: string; title?: string } = {};
    try { const name = (JSON.parse(await readFile(join(project, "package.json"), "utf8")) as { name?: unknown }).name; if (typeof name === "string") identifiers.packageName = name; } catch { /* absent */ }
    try { const key = (JSON.parse(await readFile(join(project, "site-template.json"), "utf8")) as { templateKey?: unknown }).templateKey; if (typeof key === "string") identifiers.templateKey = key; } catch { /* absent */ }
    try { const title = /<title>([^<]{0,120})<\/title>/i.exec(await readFile(join(project, "index.html"), "utf8"))?.[1]?.trim(); if (title) identifiers.title = title; } catch { /* absent */ }

    // Snapshot-tracked files and anything not reproducible from a snapshot.
    const source = new Map<string, string>(), unsaved: string[] = [];
    for (const entry of await readdir(directory).catch(() => [] as string[]))
      if (entry !== "project" && !ENVIRONMENT_METADATA.has(entry)) unsaved.push(entry);
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue; // measure() already marks the tree uncertain
        if (entry.isDirectory()) { if (!(prefix === "" && REGENERABLE_DIRS.has(entry.name))) await walk(join(dir, entry.name), rel); continue; }
        if (isSnapshotSourcePath(rel)) source.set(rel, createHash("sha256").update(await readFile(join(dir, entry.name))).digest("hex"));
        else if (!(prefix === "" && REGENERABLE_FILES.has(entry.name))) unsaved.push(rel);
      }
    };
    await walk(project, "");
    const fingerprint = fingerprintOf(source);
    const exact = source.size ? byFingerprint.get(fingerprint) ?? [] : [];
    const matches = exact.map(entry => ({ siteId: entry.siteId, attempt: entry.attempt, role: roleOf(entry), siteRecorded: references.knownSiteIds.has(entry.siteId) }));
    let bestPartialMatch: LegacyWorkspaceFinding["bestPartialMatch"];
    if (!exact.length) for (const entry of manifests) {
      let same = 0; for (const [path, sha] of source) if (entry.files.get(path) === sha) same++;
      if (same && (!bestPartialMatch || same > bestPartialMatch.matchingFiles))
        bestPartialMatch = { siteId: entry.siteId, attempt: entry.attempt, matchingFiles: same, workspaceFiles: source.size, snapshotFiles: entry.files.size };
    }

    const decide = async (): Promise<[LegacyWorkspaceClass, string]> => {
      if (measured.hasLink || measured.partial) return ["UNKNOWN", measured.hasLink ? "LINK_OR_JUNCTION_IN_WORKSPACE" : "SCAN_BUDGET_EXCEEDED"];
      evidence.push("NO_LINKS");
      if (inputs.activeEnvironmentIds?.has(environmentId)) return ["ACTIVE", "IN_USE_BY_THIS_SERVER"];
      if (processScan !== "OK") return ["UNKNOWN", "PROCESS_SCAN_UNAVAILABLE"];
      const workspacePath = normalizePath(directory);
      const users = processes.filter(info => { const line = normalizePath(info.commandLine); return line.includes(`${workspacePath}/`) || line.endsWith(workspacePath) || line.includes(`${workspacePath}"`); });
      if (users.length) return ["ACTIVE", `PROCESS_USES_WORKSPACE:${users.map(info => info.pid).join(",")}`];
      evidence.push("NO_PROCESS_REFERENCES_WORKSPACE", "NOT_IN_USE_BY_THIS_SERVER");
      if (started - activity.newestModifiedMs < inactivityMs) return ["ACTIVE", "RECENT_FILE_ACTIVITY"];
      evidence.push("INACTIVE");
      if (!references.available) return ["UNKNOWN", `REFERENCES_UNAVAILABLE:${references.reason ?? "UNKNOWN"}`];
      if (!source.size) return ["UNKNOWN", "NO_SOURCE_FILES"];
      if (!exact.length) return ["UNKNOWN", "NO_MATCHING_SNAPSHOT"];
      evidence.push("BYTE_IDENTICAL_TO_SAVED_SNAPSHOT");
      const sites = [...new Set(exact.map(entry => entry.siteId))];
      const active = sites.filter(site => references.activeSiteIds.has(site));
      if (active.length) return ["ACTIVE", "ACTIVE_JOB_FOR_MATCHED_SITE"];
      evidence.push("NO_ACTIVE_JOB");
      const intact = (await Promise.all(exact.map(entry => verify(entry.ref)))).some(Boolean);
      if (!intact) return ["UNKNOWN", "MATCHED_SNAPSHOT_INTEGRITY_FAILED"];
      evidence.push("MATCHED_SNAPSHOT_VERIFIED");
      // Every recorded website this content belongs to must reopen without the workspace.
      for (const site of sites.filter(site => references.knownSiteIds.has(site))) {
        const problem = await siteRestorable(site);
        if (problem) return ["UNKNOWN", `SITE_NOT_RESTORABLE:${problem}`];
      }
      if (sites.some(site => references.knownSiteIds.has(site))) evidence.push("RECORDED_SITES_CURRENT_AND_PREVIOUS_VERIFIED", "ASSETS_AVAILABLE_OUTSIDE_WORKSPACE");
      if (sites.some(site => !references.knownSiteIds.has(site) && references.legacySiteIds?.has(site))) return ["RECOVERABLE", "SITE_RECORDED_ONLY_IN_LEGACY_STORE"];
      if (sites.some(site => !references.knownSiteIds.has(site))) evidence.push("UNRECORDED_SITE_HAS_NO_REMAINING_REFERENCE");
      if (unsaved.length) return ["RECOVERABLE", "UNSAVED_FILES_PRESENT"];
      evidence.push("NO_UNSAVED_FILES");
      return ["SAFE_CANDIDATE", sites.every(site => !references.knownSiteIds.has(site)) ? "COPY_OF_SNAPSHOT_FOR_SITE_WITHOUT_PROJECT_RECORD" : "REDUNDANT_COPY_OF_VERIFIED_SAVED_SNAPSHOT"];
    };
    const [classification, reason] = await decide();
    findings.push({
      environmentId, path: `execution/${environmentId}`, classification, reason,
      sizeBytes: measured.sizeBytes, files: measured.files, newestModifiedMs: activity.newestModifiedMs,
      identifiers, sourceFiles: source.size, sourceFingerprint: fingerprint, unsavedFiles: unsaved.slice(0, 20),
      matches: matches.slice(0, 20), matchCount: matches.length, ...(bestPartialMatch ? { bestPartialMatch } : {}), evidence,
    });
  }
  const total = (kind: LegacyWorkspaceClass) => {
    const items = findings.filter(finding => finding.classification === kind);
    return { count: items.length, sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) };
  };
  return {
    schemaVersion: 1, auditId: randomUUID(), createdAt: new Date(started).toISOString(), durationMs: now() - started,
    referencesAvailable: references.available, processScan, truncated, markedWorkspacesSkipped,
    totals: { SAFE_CANDIDATE: total("SAFE_CANDIDATE"), ACTIVE: total("ACTIVE"), RECOVERABLE: total("RECOVERABLE"), UNKNOWN: total("UNKNOWN") },
    findings,
  };
}
