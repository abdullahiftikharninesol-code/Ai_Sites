import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isProcessAlive } from "../execution/local/workspace-reconciliation.js";
import { PROCESS_BOOT_ID } from "../execution/local/workspace-ownership.js";
import type { CleanupCandidate, CleanupCategory } from "./storage-cleanup-planner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ALLOWED: Readonly<Record<CleanupCategory, RegExp>> = {
  SUPERSEDED_VERSION_ARTIFACTS: /^artifacts\/sites\/[^/]+\/versions\/[^/]+$/,
  ORPHANED_SITE_ARTIFACTS: /^artifacts\/sites\/[^/]+\/versions\/[^/]+$/,
  UNREFERENCED_ASSET: /^artifacts\/assets\/content\/[0-9a-f]{64}\.[a-z0-9]{2,5}$/,
  ORPHANED_WORKSPACE: /^execution\/[^/]+$/,
  RECOVERABLE_WORKSPACE: /^execution\/[^/]+$/,
  LEGACY_WORKSPACE: /^execution\/env_[0-9a-f]{12}$/,
};
export function validCleanupPath(candidate: Pick<CleanupCandidate, "path" | "category">): boolean {
  const path = candidate.path;
  // Colons/Win32 aliases, trailing dots/spaces and traversal have no unambiguous local meaning.
  return typeof path === "string" && !/[\\:]/.test(path) && ![...path].some(char => char.charCodeAt(0) < 32) &&
    path.split("/").every(part => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part)) &&
    Object.hasOwn(ALLOWED, candidate.category) && ALLOWED[candidate.category].test(path);
}

type State = "PREPARED" | "MOVED" | "RESTORING" | "RESTORED" | "NOT_MOVED" | "DELETING" | "DELETED";
export interface CleanupJournalEntry {
  readonly candidate: CleanupCandidate;
  readonly trash: string;
  readonly integrity: string;
  state: State;
}
export interface CleanupJournal {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly planId: string;
  readonly root: string;
  readonly rootIdentity: string;
  readonly ownerPid: number;
  readonly ownerBootId: string;
  readonly entries: CleanupJournalEntry[];
}
export const cleanupTrashRoot = (root: string) => join(root, ".cleanup-trash");
const identity = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inspect = async (path: string) => lstat(path).catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Serialize callers in this process. Foreign live owners in journals are also refused; this is not a distributed lease. */
const activeRoots = new Set<string>();
export async function withCleanupLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  if (activeRoots.has(key)) throw new Error("CLEANUP_BUSY");
  activeRoots.add(key);
  try { return await action(); } finally { activeRoots.delete(key); }
}

/** POSIX directory entries must be flushed too. Node cannot open directory handles on Windows. */
export async function syncCleanupDirectory(path: string): Promise<void> {
  const unsupported = (error: unknown) => process.platform === "win32" &&
    ["EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) {
    if (unsupported(error)) return;
    throw error;
  }
  try { await handle.sync(); } catch (error) { if (!unsupported(error)) throw error; }
  finally { await handle.close(); }
}

/** Existing ancestors must be real directories; a missing final path is allowed. No links/junctions. */
async function safePath(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) throw new Error("JOURNAL_PATH_ESCAPE");
  let cursor = root;
  const parts = rel.split(/[\\/]/);
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    const info = await inspect(cursor);
    if (!info) {
      if (index !== parts.length - 1) throw new Error("JOURNAL_PARENT_MISSING");
      return;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error("JOURNAL_PATH_UNCERTAIN");
  }
}

/** Bounded content + inode/ownership/mode/mtime fingerprint; rename preserves these fields. */
export async function cleanupIntegrity(path: string): Promise<string> {
  const hash = createHash("sha256"), stack = [path];
  let entries = 0, bytes = 0;
  while (stack.length) {
    if (++entries > 200_000) throw new Error("JOURNAL_INTEGRITY_BUDGET");
    const current = stack.pop()!, info = await lstat(current);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("JOURNAL_INTEGRITY_UNCERTAIN");
    hash.update(JSON.stringify([relative(path, current).replace(/\\/g, "/"), identity(info), info.mode, info.uid, info.gid, info.mtimeMs,
      info.isDirectory() ? "directory" : info.size]));
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort().reverse()) stack.push(join(current, name));
    } else {
      if ((bytes += info.size) > 512 * 1024 * 1024) throw new Error("JOURNAL_INTEGRITY_BUDGET");
      const file = await open(current, "r");
      try {
        if (identity(await file.stat()) !== identity(info)) throw new Error("JOURNAL_INTEGRITY_CHANGED");
        const buffer = Buffer.alloc(64 * 1024);
        let read = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          read += bytesRead;
          if (read > info.size) throw new Error("JOURNAL_INTEGRITY_CHANGED");
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        if (read !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("JOURNAL_INTEGRITY_CHANGED");
      } finally { await file.close(); }
    }
  }
  return hash.digest("hex");
}

/** A synced temporary file + atomic replacement never truncates the last durable journal. */
export async function saveCleanupJournal(runDir: string, journal: CleanupJournal): Promise<void> {
  const envelope = { journal, checksum: checksum(journal) };
  validateJournal(envelope, journal.root, journal.runId, journal.rootIdentity);
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("JOURNAL_SIZE_LIMIT");
  const temp = join(runDir, `.journal-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(serialized, "utf8");
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, join(runDir, "journal.json"));
  await syncCleanupDirectory(runDir);
}

export async function createCleanupJournal(root: string, planId: string): Promise<{ runDir: string; journal: CleanupJournal }> {
  const trash = cleanupTrashRoot(root);
  if (!await inspect(trash)) { await mkdir(trash, { mode: 0o700 }); await syncCleanupDirectory(root); }
  await safePath(root, trash);
  const runId = randomUUID(), runDir = join(trash, runId);
  await mkdir(runDir, { mode: 0o700 });
  await syncCleanupDirectory(trash);
  const journal: CleanupJournal = { schemaVersion: 1, runId, planId, root: await realpath(root), rootIdentity: identity(await lstat(root)),
    ownerPid: process.pid, ownerBootId: PROCESS_BOOT_ID, entries: [] };
  await saveCleanupJournal(runDir, journal);
  return { runDir, journal };
}

function validateJournal(value: unknown, root: string, runId: string, rootIdentity: string): CleanupJournal {
  const envelope = value as { journal?: CleanupJournal; checksum?: string } | null;
  const journal = envelope?.journal;
  if (!journal || envelope?.checksum !== checksum(journal) || journal.schemaVersion !== 1 || typeof journal.root !== "string" || !samePath(journal.root, root) ||
    journal.rootIdentity !== rootIdentity || journal.runId !== runId || !UUID.test(journal.planId) ||
    !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid <= 0 || !UUID.test(journal.ownerBootId) ||
    !Array.isArray(journal.entries) || journal.entries.length > 200_000) throw new Error("JOURNAL_INVALID");
  const paths = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    const candidate = entry?.candidate;
    if (!candidate || !validCleanupPath(candidate) || entry.trash !== String(index) || !HASH.test(entry.integrity) ||
      !["PREPARED", "MOVED", "RESTORING", "RESTORED", "NOT_MOVED", "DELETING", "DELETED"].includes(entry.state) ||
      !Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes < 0 || !Number.isFinite(candidate.newestModifiedMs) || candidate.newestModifiedMs < 0 ||
      !Array.isArray(candidate.checks) || !candidate.checks.every(check => typeof check === "string") || typeof candidate.reason !== "string" ||
      candidate.id !== createHash("sha256").update(`${candidate.category}\0${candidate.path}`).digest("hex").slice(0, 16)) throw new Error("JOURNAL_ENTRY_INVALID");
    const key = process.platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (paths.has(key)) throw new Error("JOURNAL_PATH_AMBIGUOUS");
    paths.add(key);
  }
  return journal;
}

/** Internal: callers must hold withCleanupLock. Old/incomplete journals require manual investigation. */
export async function recoverCleanupJournals(dataRoot: string): Promise<{ restored: string[]; unresolved: string[] }> {
  const root = resolve(dataRoot), restored: string[] = [], unresolved: string[] = [], trash = cleanupTrashRoot(root);
  let runs: string[];
  try {
    if (!samePath(await realpath(root), root)) throw new Error("ROOT_NOT_CANONICAL");
    if (!await inspect(trash)) return { restored, unresolved };
    await safePath(root, trash);
    runs = await readdir(trash);
  } catch { return { restored, unresolved: ["TRASH_UNVERIFIED"] }; }
  for (const runId of runs.sort()) {
    const runDir = join(trash, runId);
    try {
      if (!UUID.test(runId)) throw new Error("JOURNAL_RUN_INVALID");
      await safePath(root, runDir);
      const journalPath = join(runDir, "journal.json");
      await safePath(root, journalPath);
      const info = await lstat(journalPath);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("JOURNAL_FILE_INVALID");
      const journal = validateJournal(JSON.parse(await readFile(journalPath, "utf8")), root, runId, identity(await lstat(root)));
      if ((journal.ownerPid !== process.pid && isProcessAlive(journal.ownerPid)) ||
        (journal.ownerPid === process.pid && journal.ownerBootId !== PROCESS_BOOT_ID)) throw new Error("JOURNAL_OWNER_UNCERTAIN");
      const allowed = new Set(["journal.json", ...journal.entries.map(entry => entry.trash)]);
      if ((await readdir(runDir)).some(name => !allowed.has(name) && !/^\.journal-[0-9a-f-]{36}\.tmp$/.test(name))) throw new Error("JOURNAL_UNRECORDED_DATA");
      // Validate every entry before restoring any entry in this run.
      for (const entry of journal.entries) {
        await safePath(root, join(root, ...entry.candidate.path.split("/")));
        await safePath(root, join(runDir, entry.trash));
      }
      for (const entry of journal.entries) {
        const original = join(root, ...entry.candidate.path.split("/")), quarantined = join(runDir, entry.trash);
        try {
          const from = await inspect(quarantined), to = await inspect(original);
          if (["RESTORED", "NOT_MOVED", "DELETED"].includes(entry.state)) {
            if (from) throw new Error("TERMINAL_TRASH_CONFLICT");
            continue; // Finalized originals may legitimately have changed since recovery.
          }
          if (entry.state === "PREPARED" && to && !from && await cleanupIntegrity(original) === entry.integrity) {
            entry.state = "NOT_MOVED"; await saveCleanupJournal(runDir, journal); continue;
          }
          if (entry.state === "DELETING" && !from) {
            await syncCleanupDirectory(runDir);
            entry.state = "DELETED"; await saveCleanupJournal(runDir, journal); continue;
          }
          if (entry.state === "RESTORING" && to && await cleanupIntegrity(original) === entry.integrity) {
            // The previous restore may have crashed before its destination-directory flush.
            await syncCleanupDirectory(dirname(original));
            // A file restore uses an exclusive hard link. A crash can leave both names for the same inode.
            if (from) {
              if (!from.isFile() || identity(from) !== identity(to) || await cleanupIntegrity(quarantined) !== entry.integrity) throw new Error("RESTORE_CONFLICT");
              await unlink(quarantined);
            }
            await syncCleanupDirectory(runDir);
            entry.state = "RESTORED"; await saveCleanupJournal(runDir, journal); continue;
          }
          if (to || !from || await cleanupIntegrity(quarantined) !== entry.integrity) throw new Error("RESTORE_UNCERTAIN");
          entry.state = "RESTORING"; await saveCleanupJournal(runDir, journal);
          await safePath(root, original);
          if (await inspect(original)) throw new Error("RESTORE_DESTINATION_EXISTS");
          if (from.isFile()) {
            await link(quarantined, original); // Atomic no-clobber, including a destination created after the check.
            await syncCleanupDirectory(dirname(original));
            await unlink(quarantined);
          } else {
            // Directory rename never replaces an existing file or a non-empty directory.
            await rename(quarantined, original);
            await syncCleanupDirectory(dirname(original));
          }
          await syncCleanupDirectory(runDir);
          entry.state = "RESTORED"; await saveCleanupJournal(runDir, journal);
          restored.push(entry.candidate.path);
        } catch { unresolved.push(`${runId}:${entry.candidate.path}`); }
      }
    } catch { unresolved.push(runId); }
  }
  return { restored, unresolved };
}

export async function removeCompletedCleanupRun(root: string, runDir: string): Promise<void> {
  await rm(runDir, { recursive: true });
  await syncCleanupDirectory(cleanupTrashRoot(root));
}
