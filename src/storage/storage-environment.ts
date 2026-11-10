import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Cleanup execution precondition for the single-database, local-disk setup.
 *
 * Both the MongoDB target and the data root must equal an explicitly
 * configured expectation, the database must be local (loopback) and the data
 * root must be a canonical local path (no junction/symlink indirection, no
 * network share). Missing, ambiguous or unexpected configuration refuses.
 *
 * This only proves the process is pointed at the intended environment. It does
 * not prove ownership of individual files: the planner's per-item reference,
 * job, process and integrity checks still decide eligibility.
 */
export const EXPECTED_DATA_ROOT_ENV = "SITES_STORAGE_CLEANUP_EXPECTED_DATA_ROOT";
/** `<host>/<database>` (or `<host>:<port>/<database>`), never credentials. */
export const EXPECTED_DATABASE_ENV = "SITES_STORAGE_CLEANUP_EXPECTED_DATABASE";

export interface DatabaseIdentity { readonly scheme: string; readonly hosts: readonly string[]; readonly database: string; readonly local: boolean }
export type StorageEnvironmentCheck =
  | { readonly ok: true; readonly dataRoot: string; readonly database: DatabaseIdentity }
  | { readonly ok: false; readonly reasons: readonly string[]; readonly database?: DatabaseIdentity };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Host list and database name of a MongoDB URI, without credentials or options. */
export function describeDatabase(uri: string | undefined): DatabaseIdentity | undefined {
  const match = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?#]+)\/([^/?#]*)/i.exec(uri?.trim() ?? "");
  if (!match) return undefined;
  const hosts = match[2]!.split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  const database = decodeURIComponent(match[3]!);
  if (!hosts.length || !database) return undefined;
  const scheme = match[1]!.toLowerCase();
  const local = scheme === "mongodb" && hosts.every(host => LOOPBACK.has(host.replace(/:\d+$/, "")));
  return { scheme, hosts, database, local };
}

const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const stripPort = (host: string) => host.replace(/:\d+$/, "");

export async function verifyStorageEnvironment(input: {
  readonly dataRoot: string;
  readonly databaseUri: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<StorageEnvironmentCheck> {
  const env = input.env ?? process.env;
  const reasons: string[] = [];
  const expectedRoot = env[EXPECTED_DATA_ROOT_ENV]?.trim();
  const expectedDatabase = env[EXPECTED_DATABASE_ENV]?.trim();
  if (!expectedRoot) reasons.push("EXPECTED_DATA_ROOT_NOT_CONFIGURED");
  if (!expectedDatabase) reasons.push("EXPECTED_DATABASE_NOT_CONFIGURED");

  const database = describeDatabase(input.databaseUri);
  if (!database) reasons.push("DATABASE_NOT_CONFIGURED_OR_UNPARSABLE");
  else {
    if (!database.local) reasons.push("DATABASE_NOT_LOCAL");
    if (database.hosts.length !== 1) reasons.push("DATABASE_TARGET_AMBIGUOUS");
    if (expectedDatabase) {
      const at = expectedDatabase.indexOf("/");
      const host = at > 0 ? expectedDatabase.slice(0, at).toLowerCase() : "", name = at > 0 ? expectedDatabase.slice(at + 1) : "";
      const hostMatches = database.hosts.length === 1 && (host.includes(":") ? database.hosts[0] === host : stripPort(database.hosts[0]!) === host);
      if (!host || !name || expectedDatabase.includes("@")) reasons.push("EXPECTED_DATABASE_INVALID");
      else if (!hostMatches || database.database !== name) reasons.push("DATABASE_DOES_NOT_MATCH_EXPECTED");
    }
  }

  let canonical: string | undefined;
  if (!isAbsolute(input.dataRoot)) reasons.push("DATA_ROOT_NOT_ABSOLUTE");
  const root = resolve(input.dataRoot);
  if (/^[\\/]{2}/.test(input.dataRoot) || /^[\\/]{2}/.test(root)) reasons.push("DATA_ROOT_IS_NETWORK_PATH");
  try { canonical = await realpath(root); } catch { reasons.push("DATA_ROOT_MISSING"); }
  if (canonical && !samePath(canonical, root)) reasons.push("DATA_ROOT_NOT_CANONICAL");
  if (expectedRoot) {
    if (!isAbsolute(expectedRoot)) reasons.push("EXPECTED_DATA_ROOT_INVALID");
    else {
      const expected = await realpath(resolve(expectedRoot)).catch(() => undefined);
      if (!expected || !canonical || !samePath(expected, canonical)) reasons.push("DATA_ROOT_DOES_NOT_MATCH_EXPECTED");
    }
  }
  if (reasons.length || !canonical || !database) return { ok: false, reasons, ...(database ? { database } : {}) };
  return { ok: true, dataRoot: canonical, database };
}
