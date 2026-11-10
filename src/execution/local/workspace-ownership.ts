import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Identifies this server process across PID reuse; never persisted outside workspace markers. */
export const PROCESS_BOOT_ID = randomUUID();
/** Stored beside (never inside) the project directory, so it can never enter a source snapshot. */
export const WORKSPACE_MARKER = ".sites-workspace.json";

export interface WorkspaceOwnershipMarker {
  readonly schemaVersion: 1;
  readonly environmentId: string;
  readonly ownerPid: number;
  readonly ownerBootId: string;
  readonly createdAt: string;
  readonly purpose?: "PREVIEW";
  readonly siteId?: string;
  readonly versionId?: string;
}

export async function writeWorkspaceMarker(environmentDirectory: string, environmentId: string, annotation: Pick<WorkspaceOwnershipMarker, "purpose" | "siteId" | "versionId"> = {}): Promise<void> {
  const existing = await readWorkspaceMarker(environmentDirectory);
  const marker: WorkspaceOwnershipMarker = {
    schemaVersion: 1, environmentId, ownerPid: process.pid, ownerBootId: PROCESS_BOOT_ID,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(annotation.purpose ? { purpose: annotation.purpose } : {}),
    ...(annotation.siteId ? { siteId: annotation.siteId } : {}),
    ...(annotation.versionId ? { versionId: annotation.versionId } : {}),
  };
  await writeFile(join(environmentDirectory, WORKSPACE_MARKER), JSON.stringify(marker), "utf8");
}

export async function readWorkspaceMarker(environmentDirectory: string): Promise<WorkspaceOwnershipMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(join(environmentDirectory, WORKSPACE_MARKER), "utf8")) as Partial<WorkspaceOwnershipMarker>;
    return value.schemaVersion === 1 && typeof value.environmentId === "string" && Number.isInteger(value.ownerPid) &&
      typeof value.ownerBootId === "string" && typeof value.createdAt === "string" ? value as WorkspaceOwnershipMarker : undefined;
  } catch { return undefined; }
}
