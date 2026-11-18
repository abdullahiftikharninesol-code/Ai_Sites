import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isProcessAlive, listNodeProcesses, processOwnershipVerifiable, workspaceProcessIds, type ProcessInfo } from "../execution/local/workspace-reconciliation.js";
import { readWorkspaceMarker, WORKSPACE_MARKER } from "../execution/local/workspace-ownership.js";
import { DEFAULT_STORAGE_POLICY, planStorageCleanup, type PlanInputs } from "./storage-cleanup-planner.js";
import { validCleanupPath } from "./storage-cleanup-journal.js";
import { inventoryLegacyReferences } from "./storage-inventory-references.js";
import { unavailableReferences } from "./storage-references.js";

export type InventoryCategory = "SAVED_VERSIONS" | "SHARED_MEDIA" | "WORKSPACES" | "PREPARED_PUBLISHING" | "RUNTIME_DATA" | "OTHER";
export type InventoryState = "PROTECTED" | "POTENTIALLY_ELIGIBLE" | "UNCERTAIN";
const CATEGORIES: readonly InventoryCategory[] = ["SAVED_VERSIONS", "SHARED_MEDIA", "WORKSPACES", "PREPARED_PUBLISHING", "RUNTIME_DATA", "OTHER"];
interface Unit { path: string; category: InventoryCategory; files: number; bytes: number; complete: boolean }
export interface InventoryGroup {
  readonly category: InventoryCategory;
  /** Unit counts: version directories, media files, workspaces, preparations, or other top-level trees/files. */
  readonly items: number;
  readonly files: number;
  readonly measuredBytes: number;
  /** Null means measuredBytes is only a lower bound, never an exact zero. */
  readonly totalBytes: number | null;
  readonly complete: boolean;
  readonly retention: Readonly<Record<InventoryState, { readonly items: number; readonly measuredBytes: number }>>;
  readonly reasons: Readonly<Record<string, number>>;
}
export interface StorageInventory {
  readonly schemaVersion: 1;
  readonly mode: "READ_ONLY_INVENTORY";
  readonly cleanupApproved: false;
  readonly usageComplete: boolean;
  readonly referencesAvailable: boolean;
  readonly referencesReason?: string;
  readonly totalBytes: number | null;
  readonly measuredBytes: number;
  readonly categories: readonly InventoryGroup[];
  readonly warnings: readonly string[];
  readonly recommendations: readonly string[];
}
export interface InventoryInputs extends Omit<PlanInputs, "reconcile"> {
  /** Counts directories too, unlike the cleanup planner's file budget. */
  readonly maxEntries?: number;
}

function location(path: string): { category: InventoryCategory; unit: string } {
  const parts = path.split("/");
  if (parts[0] === "artifacts" && parts[1] === "sites" && parts.length >= 4) {
    if (parts[3] === "versions" && parts.length >= 5) return { category: "SAVED_VERSIONS", unit: parts.slice(0, 5).join("/") };
    if (parts[3] === "current") return { category: "SAVED_VERSIONS", unit: parts.slice(0, 4).join("/") };
    if (parts[3] === "publishing") return { category: "PREPARED_PUBLISHING", unit: parts.slice(0, Math.min(5, parts.length)).join("/") };
  }
  if (parts.slice(0, 3).join("/") === "artifacts/assets/content" && parts.length >= 4)
    return { category: "SHARED_MEDIA", unit: parts.slice(0, 4).join("/") };
  if (parts[0] === "execution" && parts.length >= 2)
    return parts[1]!.startsWith(".") ? { category: "RUNTIME_DATA", unit: parts.slice(0, 2).join("/") } : { category: "WORKSPACES", unit: parts.slice(0, 2).join("/") };
  if (["diagnostics", ".cleanup-trash", ".cleanup-plans"].includes(parts[0]!) || /^(sites|runtime)\.sqlite(?:-(wal|shm|journal))?$/.test(parts[0]!))
    return { category: "RUNTIME_DATA", unit: parts[0]! };
  return { category: "OTHER", unit: parts.slice(0, parts[0] === "artifacts" ? 3 : 1).join("/") };
}
const container = (path: string) => path === "" || path === "artifacts" || path === "artifacts/sites" || path === "artifacts/assets" ||
  path === "artifacts/assets/content" || path === "execution" || /^artifacts\/sites\/[^/]+(?:\/(?:versions|publishing))?$/.test(path);

/**
 * Metadata-only, no reconciliation/recovery, source reads, report writes, SQLite opens or process signals except signal 0.
 * Injected reference/process sources must also honor their read-only contracts. Output contains aggregates, never tenant paths/content.
 */
export async function inventoryStorage(inputs: InventoryInputs): Promise<StorageInventory> {
  const root = resolve(inputs.dataRoot), clock = inputs.now ?? Date.now, policy = { ...DEFAULT_STORAGE_POLICY, ...inputs.policy };
  const deadline = clock() + policy.maxDurationMs, limit = inputs.maxEntries ?? policy.maxFilesScanned;
  const units = new Map<string, Unit>(), incomplete = new Set<InventoryCategory>(), warnings = new Set<string>();
  const stack = [""];
  let entries = 0, globalIncomplete = false;
  const uncertain = (path: string, reason: string) => {
    warnings.add(reason);
    if (container(path)) globalIncomplete = true;
    else {
      const { category, unit } = location(path);
      incomplete.add(category);
      const data = units.get(unit) ?? { path: unit, category, bytes: 0, files: 0, complete: false };
      data.complete = false; units.set(unit, data);
    }
  };
  try {
    const canonical = await realpath(root);
    if ((process.platform === "win32" ? canonical.toLowerCase() !== root.toLowerCase() : canonical !== root)) throw new Error("ROOT_UNCERTAIN");
  } catch { uncertain("", "ROOT_UNAVAILABLE_OR_NONCANONICAL"); stack.length = 0; }
  while (stack.length) {
    if (++entries > limit || clock() > deadline) { globalIncomplete = true; warnings.add("SCAN_BUDGET_EXCEEDED"); break; }
    const path = stack.pop()!, absolute = join(root, ...path.split("/"));
    try {
      const info = await lstat(absolute);
      if (!path && !info.isDirectory()) { uncertain("", "ROOT_NOT_DIRECTORY"); continue; }
      if (info.isSymbolicLink()) { uncertain(path, "LINK_NOT_FOLLOWED"); continue; }
      if (!info.isFile() && !info.isDirectory()) { uncertain(path, "UNSUPPORTED_ENTRY"); continue; }
      if (!container(path) || !info.isDirectory()) {
        const { category, unit } = location(path);
        const data = units.get(unit) ?? { path: unit, category, files: 0, bytes: 0, complete: true };
        if (info.isFile()) { data.files++; data.bytes += info.size; }
        units.set(unit, data);
      }
      if (info.isDirectory()) {
        const children = await readdir(absolute);
        for (const child of children.sort().reverse()) stack.push(path ? `${path}/${child}` : child);
      }
    } catch { uncertain(path, "METADATA_SCAN_INCOMPLETE"); }
  }
  if (globalIncomplete) for (const category of CATEGORIES) incomplete.add(category);
  const usageComplete = !incomplete.size;
  const references = await inventoryLegacyReferences(inputs.references, root).load().catch(() => unavailableReferences("INVENTORY_REFERENCES_UNVERIFIED"));
  if (!references.available) warnings.add("REFERENCES_UNAVAILABLE");
  // Use existing retention rules only for version directories. Never inspect source/manifest contents or reconcile workspaces.
  const plan = usageComplete && references.available && clock() <= deadline
    ? await planStorageCleanup({ dataRoot: root, references: { load: () => Promise.resolve(references) },
      policy: { ...policy, maxDurationMs: Math.max(0, deadline - clock()) },
      ...(inputs.protectedAssetKeys ? { protectedAssetKeys: inputs.protectedAssetKeys } : {}),
      ...(inputs.now ? { now: inputs.now } : {}),
    }, { artifactsOnly: true, metadataOnly: true }).catch(() => undefined) : undefined;
  const retentionComplete = !!plan && !plan.truncated && !plan.protected.some(group => group.reason === "UNCERTAIN_TREE");
  const versionCandidates = new Set(retentionComplete ? plan.candidates.filter(candidate =>
    candidate.category !== "UNREFERENCED_ASSET" && validCleanupPath(candidate)).map(candidate => candidate.path) : []);
  if (!retentionComplete) warnings.add("RETENTION_SCAN_INCOMPLETE");
  let processes: readonly ProcessInfo[] | undefined;
  if ([...units.values()].some(unit => unit.category === "WORKSPACES")) {
    try { processes = await (inputs.listProcesses ?? (timeout => listNodeProcesses(timeout, { allProcesses: true })))(8_000); }
    catch { processes = undefined; }
    if (!processes || !processOwnershipVerifiable(processes)) warnings.add("PROCESS_OWNERSHIP_UNVERIFIED");
  }
  const classify = async (unit: Unit): Promise<[InventoryState, string]> => {
    if (!unit.complete || incomplete.has(unit.category)) return ["UNCERTAIN", "MEASUREMENT_INCOMPLETE"];
    if (unit.category === "PREPARED_PUBLISHING") return ["PROTECTED", "PUBLISHING_ARTIFACTS"];
    if (unit.category === "SAVED_VERSIONS") {
      if (!references.available || !retentionComplete) return ["UNCERTAIN", "REFERENCES_OR_RETENTION_UNVERIFIED"];
      return versionCandidates.has(unit.path) ? ["POTENTIALLY_ELIGIBLE", "EXISTING_VERSION_RETENTION_RULES"] : ["PROTECTED", "VERSION_REFERENCE_OR_RETENTION"];
    }
    if (unit.category === "SHARED_MEDIA") {
      if ([...(inputs.protectedAssetKeys ?? [])].some(key => key.split("/").at(-1) === unit.path.split("/").at(-1))) return ["PROTECTED", "PENDING_UPLOAD"];
      return ["UNCERTAIN", "CONTENT_REFERENCES_NOT_INSPECTED"];
    }
    if (unit.category === "WORKSPACES") {
      const environmentId = unit.path.split("/")[1]!;
      if (inputs.activeEnvironmentIds?.has(environmentId)) return ["PROTECTED", "ACTIVE_WORKSPACE"];
      if (!processes || !processOwnershipVerifiable(processes)) return ["UNCERTAIN", "PROCESS_OWNERSHIP_UNVERIFIED"];
      const markerPath = join(root, ...unit.path.split("/"), WORKSPACE_MARKER);
      const info = await lstat(markerPath).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 16_384) return ["UNCERTAIN", "WORKSPACE_OWNERSHIP_UNVERIFIED"];
      const marker = await readWorkspaceMarker(join(root, ...unit.path.split("/")));
      if (!marker || marker.environmentId !== environmentId) return ["UNCERTAIN", "WORKSPACE_OWNERSHIP_UNVERIFIED"];
      const alive = marker.ownerPid === process.pid || isProcessAlive(marker.ownerPid);
      if (alive || workspaceProcessIds(join(root, "execution"), environmentId, processes, marker.ownerPid).length)
        return ["PROTECTED", "OWNER_OR_WORKSPACE_PROCESS_ACTIVE"];
      return ["UNCERTAIN", "WORKSPACE_RECOVERY_NOT_VERIFIED"];
    }
    if (unit.path === ".cleanup-trash") return ["UNCERTAIN", "RECOVERY_JOURNAL_NOT_INSPECTED"];
    return unit.category === "RUNTIME_DATA" ? ["PROTECTED", "NO_RETENTION_RULE_APPLIED"] : ["UNCERTAIN", "UNRECOGNIZED_DATA"];
  };
  const categories: InventoryGroup[] = [];
  for (const category of CATEGORIES) {
    const items = [...units.values()].filter(unit => unit.category === category);
    const retention: Record<InventoryState, { items: number; measuredBytes: number }> = {
      PROTECTED: { items: 0, measuredBytes: 0 }, POTENTIALLY_ELIGIBLE: { items: 0, measuredBytes: 0 }, UNCERTAIN: { items: 0, measuredBytes: 0 },
    };
    const reasons: Record<string, number> = {};
    for (const unit of items) {
      const [state, reason] = await classify(unit);
      retention[state].items++; retention[state].measuredBytes += unit.bytes;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    const measuredBytes = items.reduce((sum, unit) => sum + unit.bytes, 0);
    categories.push({ category, items: items.length, files: items.reduce((sum, unit) => sum + unit.files, 0), measuredBytes,
      complete: !incomplete.has(category), totalBytes: incomplete.has(category) ? null : measuredBytes, retention, reasons });
  }
  const measuredBytes = categories.reduce((sum, group) => sum + group.measuredBytes, 0);
  return { schemaVersion: 1, mode: "READ_ONLY_INVENTORY", cleanupApproved: false, usageComplete,
    referencesAvailable: references.available, ...(references.reason ? { referencesReason: references.reason } : {}),
    measuredBytes, totalBytes: usageComplete ? measuredBytes : null, categories, warnings: [...warnings],
    recommendations: [
      "Potential eligibility is informational, requires fresh reference/process/integrity validation and explicit cleanup approval.",
      "Keep current/previous sources, publishing obligations, unresolved deployments and active workspaces pinned.",
      "Verify media content references and legacy SQLite state with a separately reviewed read-only reader before retention decisions.",
      "Define retention for preparations, diagnostics and recovery journals only after ownership, recovery and rollback obligations are resolved.",
      "Use shared reference storage and writer/cleanup coordination before multi-instance retention.",
      "Logical file sizes are not allocated disk usage; hard links can be counted more than once. Reads may update OS access times.",
      "Database/cloud usage is outside this local filesystem inventory; no cloud requests are made.",
    ] };
}
