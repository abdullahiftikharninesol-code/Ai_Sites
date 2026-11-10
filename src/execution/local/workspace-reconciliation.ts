import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROCESS_BOOT_ID, readWorkspaceMarker } from "./workspace-ownership.js";

/**
 * Startup reconciliation of local execution workspaces after a crash/restart.
 *
 * Classifies each workspace from its ownership marker:
 *   ACTIVE       owned by this server, or by another server process that is still alive
 *   RECOVERABLE  owner exited; it served a saved version that still exists, so the
 *                preview can be rebuilt from the snapshot (the workspace is a cache)
 *   ORPHANED     owner exited and nothing recoverable references it
 *   UNKNOWN      no valid marker (e.g. created before markers existed): left untouched
 *
 * Phase 3A never deletes a workspace. Confirmed candidates are recorded in a
 * bounded report and marked in place. The only process action is stopping a
 * Vite dev server whose command line runs from this root's workspace AND whose
 * owning server has exited — never an unrelated or uncertain process.
 */
export type WorkspaceState = "ACTIVE" | "RECOVERABLE" | "ORPHANED" | "UNKNOWN";
export interface ReconciliationEntry {
  readonly environmentId: string;
  readonly state: WorkspaceState;
  readonly reason: string;
  readonly purpose?: string;
  readonly siteId?: string;
  readonly versionId?: string;
  readonly previewProcesses: number;
  readonly stoppedProcesses: number;
}
export interface ReconciliationReport {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly scanned: number;
  readonly truncated: boolean;
  readonly processScan: "OK" | "UNAVAILABLE";
  readonly counts: Readonly<Record<WorkspaceState, number>> & { readonly stoppedProcesses: number; readonly untrackedPreviewProcesses: number };
  readonly entries: readonly ReconciliationEntry[];
}
export interface ProcessInfo { readonly pid: number; readonly commandLine: string }
export interface ReconcileOptions {
  readonly root: string;
  /** Whether a saved site version still exists (no source is read or modified). */
  readonly isVersionRecoverable?: (siteId: string, versionId: string) => Promise<boolean>;
  readonly listProcesses?: (timeoutMs: number) => Promise<readonly ProcessInfo[]>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly stopProcess?: (pid: number) => void;
  /** Stop confirmed orphan Vite servers (default true). Workspaces are never deleted. */
  readonly stopOrphanPreviews?: boolean;
  readonly timeoutMs?: number;
  readonly maxWorkspaces?: number;
}
export const RECONCILIATION_REPORT = join(".reconciliation", "latest.json");
export const ORPHAN_CANDIDATE_MARKER = ".sites-orphan-candidate.json";

export async function reconcileExecutionWorkspaces(options: ReconcileOptions): Promise<ReconciliationReport> {
  const started = Date.now(), deadline = started + (options.timeoutMs ?? 15_000);
  const maxWorkspaces = options.maxWorkspaces ?? 500;
  const root = resolve(options.root);
  const alive = options.isProcessAlive ?? isProcessAlive;
  const stop = options.stopProcess ?? ((pid: number) => { process.kill(pid); });
  let directories: string[] = [];
  try {
    directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name).sort();
  } catch { /* No execution root yet: nothing to reconcile. */ }
  let processScan: ReconciliationReport["processScan"] = "OK";
  let processes: readonly ProcessInfo[] = [];
  try { processes = await (options.listProcesses ?? listNodeProcesses)(Math.max(1_000, Math.min(8_000, deadline - Date.now()))); }
  catch { processScan = "UNAVAILABLE"; }
  const previewsByEnvironment = new Map<string, number[]>();
  for (const info of processes) {
    const environmentId = viteEnvironment(root, info.commandLine);
    if (environmentId) previewsByEnvironment.set(environmentId, [...(previewsByEnvironment.get(environmentId) ?? []), info.pid]);
  }
  const entries: ReconciliationEntry[] = [];
  let truncated = directories.length > maxWorkspaces;
  for (const environmentId of directories.slice(0, maxWorkspaces)) {
    if (Date.now() > deadline) { truncated = true; break; }
    const directory = join(root, environmentId);
    const marker = await readWorkspaceMarker(directory);
    const pids = previewsByEnvironment.get(environmentId) ?? [];
    previewsByEnvironment.delete(environmentId);
    let state: WorkspaceState, reason: string;
    if (!marker || marker.environmentId !== environmentId) { state = "UNKNOWN"; reason = "NO_OWNERSHIP_MARKER"; }
    else if (marker.ownerPid === process.pid && marker.ownerBootId === PROCESS_BOOT_ID) { state = "ACTIVE"; reason = "OWNED_BY_THIS_SERVER"; }
    // A live PID may be a reused one; treating it as active is the safe direction.
    else if (marker.ownerPid !== process.pid && alive(marker.ownerPid)) { state = "ACTIVE"; reason = "OWNER_PROCESS_ALIVE"; }
    else if (marker.purpose === "PREVIEW" && marker.siteId && marker.versionId && Date.now() <= deadline &&
      await (options.isVersionRecoverable?.(marker.siteId, marker.versionId) ?? Promise.resolve(false)).catch(() => false)) {
      state = "RECOVERABLE"; reason = "PREVIEW_REBUILDABLE_FROM_SNAPSHOT";
    } else { state = "ORPHANED"; reason = "OWNER_EXITED"; }
    let stopped = 0;
    if ((state === "RECOVERABLE" || state === "ORPHANED") && options.stopOrphanPreviews !== false)
      for (const pid of pids) { try { stop(pid); stopped++; } catch { /* already gone */ } }
    if (state === "RECOVERABLE" || state === "ORPHANED")
      await writeFile(join(directory, ORPHAN_CANDIDATE_MARKER), JSON.stringify({ detectedAt: new Date().toISOString(), state, reason }), "utf8").catch(() => undefined);
    entries.push({ environmentId, state, reason, ...(marker?.purpose ? { purpose: marker.purpose } : {}),
      ...(marker?.siteId ? { siteId: marker.siteId } : {}), ...(marker?.versionId ? { versionId: marker.versionId } : {}),
      previewProcesses: pids.length, stoppedProcesses: stopped });
  }
  const count = (state: WorkspaceState) => entries.filter(entry => entry.state === state).length;
  const report: ReconciliationReport = {
    schemaVersion: 1, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, scanned: entries.length, truncated, processScan,
    // Vite processes whose workspace no longer exists have no provable owner: recorded only.
    counts: { ACTIVE: count("ACTIVE"), RECOVERABLE: count("RECOVERABLE"), ORPHANED: count("ORPHANED"), UNKNOWN: count("UNKNOWN"),
      stoppedProcesses: entries.reduce((sum, entry) => sum + entry.stoppedProcesses, 0),
      untrackedPreviewProcesses: [...previewsByEnvironment.values()].reduce((sum, pids) => sum + pids.length, 0) },
    entries,
  };
  try {
    await mkdir(join(root, ".reconciliation"), { recursive: true });
    await writeFile(join(root, RECONCILIATION_REPORT), JSON.stringify(report, null, 2), "utf8");
  } catch { /* Reporting must never fail startup. */ }
  return report;
}

/** Environment id when the command line runs this root's workspace Vite binary. */
function viteEnvironment(root: string, commandLine: string): string | undefined {
  const normalize = (value: string) => {
    const slashed = value.replace(/\\/g, "/");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const base = normalize(root).replace(/\/+$/, "");
  const line = normalize(commandLine);
  const at = line.indexOf(`${base}/`);
  if (at < 0) return undefined;
  const match = /^([^/"\s]+)\/project\/node_modules\/vite\/bin\/vite\.js/.exec(line.slice(at + base.length + 1));
  if (!match) return undefined;
  // Recover the original-case directory name from the command line.
  const original = commandLine.replace(/\\/g, "/").slice(at + base.length + 1).split("/")[0];
  return original && original.toLowerCase() === match[1]!.toLowerCase() ? original : match[1];
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Node processes (or, with `allProcesses`, every process) and their command
 * lines, bounded by a timeout.
 */
export function listNodeProcesses(timeoutMs: number, options: { readonly allProcesses?: boolean } = {}): Promise<readonly ProcessInfo[]> {
  return new Promise((resolvePromise, reject) => {
    const windows = process.platform === "win32";
    const filter = options.allProcesses ? "" : " -Filter \"Name='node.exe'\"";
    const [command, args] = windows
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`]] as const
      : ["ps", ["-axo", "pid=,args="]] as const;
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error instanceof Error ? error : new Error("Process listing failed")); return; }
      try {
        if (windows) {
          const parsed = stdout.trim() ? JSON.parse(stdout) as { ProcessId: number; CommandLine: string | null } | { ProcessId: number; CommandLine: string | null }[] : [];
          resolvePromise((Array.isArray(parsed) ? parsed : [parsed]).filter(item => item.CommandLine).map(item => ({ pid: item.ProcessId, commandLine: item.CommandLine! })));
        } else {
          resolvePromise(stdout.split("\n").map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match): match is RegExpExecArray => !!match && (options.allProcesses || /node/.test(match[2]!)))
            .map(match => ({ pid: Number(match[1]), commandLine: match[2]! })));
        }
      } catch (cause) { reject(cause instanceof Error ? cause : new Error(String(cause))); }
    });
  });
}
