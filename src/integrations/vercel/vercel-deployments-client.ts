import { VERCEL_API_BASE_URL } from "./vercel-oauth-client.js";
import { VercelApiError, type VercelAuth } from "./vercel-projects-client.js";

/**
 * Server-side Vercel deployment calls (official contracts):
 *   POST /v2/files                     upload one file (x-vercel-digest = SHA-1)
 *   POST /v13/deployments              create a deployment from uploaded files
 *   GET  /v13/deployments/{idOrUrl}    deployment state, aliases, errors
 *   GET  /v7/deployments               list a project's deployments (reconciliation)
 *   GET  /v9/projects/{id}             the project's current production deployment (targets.production)
 *   GET  /v4/aliases/{host}            the deployment a hostname actually serves
 *   POST /v10/projects/{p}/promote/{d} point production domains at a staged deployment
 *   POST /v1/projects/{p}/rollback/{d} point production domains back at a previous production deployment
 *   PATCH /v12/deployments/{id}/cancel stop an in-progress (stale) deployment; never deletes
 * Team installations pass `teamId`. Nothing here retries; the publisher bounds
 * retries itself and never assumes success without a 2xx from Vercel.
 */
const API_TIMEOUT_MS = 15_000;
/** Deployments requested per list page (Vercel's default page size). */
export const LIST_PAGE_SIZE = 20;
const UPLOAD_TIMEOUT_MS = 60_000;

export type VercelReadyState = "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "BLOCKED" | "DELETED";

export interface VercelDeploymentPage {
  readonly deployments: readonly VercelDeploymentInfo[];
  /** Cursor for the next page (as `until`); null: no more pages; undefined: completeness unknown. */
  readonly next: number | null | undefined;
}

export interface VercelDeploymentInfo {
  readonly id: string;
  /** Unique deployment hostname (often behind Deployment Protection). */
  readonly url: string | null;
  readonly readyState: VercelReadyState | "UNKNOWN";
  readonly projectId?: string;
  readonly target?: string | null;
  /** Hostnames assigned on creation, including the production domain. */
  readonly alias: readonly string[];
  readonly aliasAssigned?: boolean;
  /** READY substate: STAGED never served production traffic; PROMOTED has. */
  readonly readySubstate?: "STAGED" | "ROLLING" | "PROMOTED";
  readonly aliasError?: { readonly code: string; readonly message: string };
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly createdAt?: number;
}

export interface CreateDeploymentInput {
  readonly name: string;
  readonly projectId: string;
  readonly files: readonly { readonly file: string; readonly sha: string; readonly size: number }[];
  readonly meta: Readonly<Record<string, string>>;
}

export interface VercelDeploymentsClient {
  uploadFile(auth: VercelAuth, file: { readonly sha1: string; readonly content: Uint8Array }): Promise<void>;
  /** Missing uploads are reported (400 missing_files) instead of thrown. */
  createDeployment(auth: VercelAuth, input: CreateDeploymentInput): Promise<VercelDeploymentInfo | { readonly missing: readonly string[] }>;
  getDeployment(auth: VercelAuth, id: string): Promise<VercelDeploymentInfo | undefined>;
  /**
   * One page (newest first) of a project's deployments created after `since`
   * and, when given, before `until`. `next` is Vercel's pagination cursor for
   * the following page (pass it as `until`): null when Vercel reports no more
   * pages, undefined when completeness can't be told from the response.
   */
  listProjectDeployments(auth: VercelAuth, projectId: string, since: number, until?: number): Promise<VercelDeploymentPage>;
  /** The deployment the project's production environment currently serves (null when none). */
  getProductionDeploymentId(auth: VercelAuth, projectId: string): Promise<string | null>;
  /** The deployment a hostname is aliased to within the project; undefined when Vercel has no such alias. */
  getAliasDeploymentId(auth: VercelAuth, host: string, projectId: string): Promise<string | null | undefined>;
  /** Requests promotion (201/202). "CONFLICT" (409) when another promote/rollback job is still running. */
  promoteDeployment(auth: VercelAuth, projectId: string, deploymentId: string): Promise<"ACCEPTED" | "CONFLICT">;
  /** Requests an Instant Rollback to a deployment that served production before. */
  rollbackDeployment(auth: VercelAuth, projectId: string, deploymentId: string): Promise<"ACCEPTED" | "CONFLICT">;
  /**
   * Stops an in-progress deployment (PATCH /v12/deployments/{id}/cancel) so it can never be
   * assigned to production later. "NOT_CANCELABLE" (400) when it already finished.
   * Never deletes anything.
   */
  cancelDeployment(auth: VercelAuth, deploymentId: string): Promise<"CANCELED" | "NOT_CANCELABLE">;
}

const text = (value: unknown, max = 300) => (typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").slice(0, max) : undefined);

/** Retry-After as delay-seconds or an HTTP date; bounded to one hour. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 3_600_000) : undefined;
}
const READY_STATES = new Set(["QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED", "BLOCKED", "DELETED"]);

export function parseDeployment(body: unknown): VercelDeploymentInfo {
  const value = (body ?? {}) as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : typeof value.uid === "string" ? value.uid : undefined;
  if (!id) throw new VercelApiError(200, "invalid_response", "Vercel returned an unexpected deployment response");
  const state = typeof value.readyState === "string" ? value.readyState : typeof value.state === "string" ? value.state : "";
  const aliasError = value.aliasError as Record<string, unknown> | null | undefined;
  const meta: Record<string, string> = {};
  if (value.meta && typeof value.meta === "object")
    for (const [key, entry] of Object.entries(value.meta as Record<string, unknown>)) if (typeof entry === "string") meta[key] = entry.slice(0, 200);
  return {
    id,
    url: typeof value.url === "string" && value.url ? value.url : null,
    readyState: READY_STATES.has(state) ? (state as VercelReadyState) : "UNKNOWN",
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(value.target === null || typeof value.target === "string" ? { target: value.target } : {}),
    alias: Array.isArray(value.alias) ? value.alias.filter((a): a is string => typeof a === "string").slice(0, 50) : [],
    // Vercel reports either a boolean or the assignment timestamp.
    ...(typeof value.aliasAssigned === "boolean" ? { aliasAssigned: value.aliasAssigned } : typeof value.aliasAssigned === "number" ? { aliasAssigned: true } : {}),
    ...(value.readySubstate === "STAGED" || value.readySubstate === "ROLLING" || value.readySubstate === "PROMOTED" ? { readySubstate: value.readySubstate } : {}),
    ...(aliasError && typeof aliasError === "object" ? { aliasError: { code: text(aliasError.code, 64) ?? "unknown", message: text(aliasError.message) ?? "" } } : {}),
    ...(text(value.errorCode, 64) ? { errorCode: text(value.errorCode, 64)! } : {}),
    ...(text(value.errorMessage) ? { errorMessage: text(value.errorMessage)! } : {}),
    meta,
    ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : typeof value.created === "number" ? { createdAt: value.created } : {}),
  };
}

export function createVercelDeploymentsClient(
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl = VERCEL_API_BASE_URL,
  shutdownSignal?: AbortSignal,
): VercelDeploymentsClient {
  const request = async (auth: VercelAuth, method: "GET" | "POST" | "PATCH", path: string, init: { query?: Record<string, string>; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number } = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    if (auth.teamId) url.searchParams.set("teamId", auth.teamId);
    let response: Response;
    try {
      shutdownSignal?.throwIfAborted();
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          accept: "application/json",
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        ...(init.json !== undefined
          ? { body: JSON.stringify(init.json) }
          : init.bytes
            ? { body: new Blob([Uint8Array.from(init.bytes)], { type: "application/octet-stream" }) }
            : {}),
        redirect: "error",
        signal: shutdownSignal ? AbortSignal.any([shutdownSignal, AbortSignal.timeout(init.timeoutMs ?? API_TIMEOUT_MS)]) : AbortSignal.timeout(init.timeoutMs ?? API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new VercelApiError(undefined, undefined, undefined, undefined, (error as Error)?.name === "TimeoutError" || undefined);
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    return { status: response.status, ok: response.ok, body, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
  };
  const failure = (status: number, body: Record<string, unknown> | undefined, retryAfter?: number) => {
    const error = body?.error as Record<string, unknown> | undefined;
    const code = text(error?.code, 64);
    return new VercelApiError(status, code && /^[A-Za-z0-9_.-]+$/.test(code) ? code : undefined, text(error?.message, 200), retryAfter);
  };

  return {
    async uploadFile(auth, file) {
      const result = await request(auth, "POST", "/v2/files", {
        bytes: file.content,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.content.byteLength),
          "x-vercel-digest": file.sha1,
        },
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      // Only Vercel's 200 confirms the upload (or that it already had this SHA).
      if (result.status !== 200) throw failure(result.status, result.body, result.retryAfterMs);
    },
    async createDeployment(auth, input) {
      const result = await request(auth, "POST", "/v13/deployments", {
        // Prebuilt static files: never let Vercel detect a framework and build.
        query: { skipAutoDetectionConfirmation: "1" },
        json: {
          name: input.name,
          project: input.projectId,
          target: "production",
          files: input.files,
          projectSettings: { framework: null },
          meta: input.meta,
        },
      });
      if (result.status === 400) {
        const error = result.body?.error as Record<string, unknown> | undefined;
        if (error?.code === "missing_files")
          return { missing: Array.isArray(error.missing) ? error.missing.filter((s): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)) : [] };
      }
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      return parseDeployment(result.body);
    },
    async getDeployment(auth, id) {
      const result = await request(auth, "GET", `/v13/deployments/${encodeURIComponent(id)}`);
      if (result.status === 404) return undefined;
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      return parseDeployment(result.body);
    },
    async listProjectDeployments(auth, projectId, since, until) {
      const result = await request(auth, "GET", "/v7/deployments", {
        query: {
          projectId,
          since: String(Math.max(0, Math.floor(since))),
          ...(until !== undefined ? { until: String(Math.max(0, Math.floor(until))) } : {}),
          limit: String(LIST_PAGE_SIZE),
        },
      });
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      const list = Array.isArray(result.body?.deployments) ? (result.body.deployments as unknown[]) : undefined;
      const pagination = result.body?.pagination as Record<string, unknown> | null | undefined;
      const cursor = pagination?.next;
      // Only an explicit null (with a readable list) says the search is complete; anything unexpected is not.
      const next = !list || list.length > LIST_PAGE_SIZE ? undefined : cursor === null ? null : typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0 ? cursor : undefined;
      return { deployments: (list ?? []).slice(0, LIST_PAGE_SIZE).map(parseDeployment), next };
    },
    async getProductionDeploymentId(auth, projectId) {
      const result = await request(auth, "GET", `/v9/projects/${encodeURIComponent(projectId)}`);
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      const targets = result.body?.targets as Record<string, unknown> | null | undefined;
      const production = targets?.production as Record<string, unknown> | null | undefined;
      return typeof production?.id === "string" && production.id ? production.id : null;
    },
    async getAliasDeploymentId(auth, host, projectId) {
      const result = await request(auth, "GET", `/v4/aliases/${encodeURIComponent(host)}`, { query: { projectId } });
      if (result.status === 404) return undefined;
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      if (result.body?.projectId !== projectId || !(result.body.deploymentId === null || (typeof result.body.deploymentId === "string" && result.body.deploymentId)))
        throw new VercelApiError(result.status, "invalid_response", "Vercel returned an unexpected alias response");
      const deploymentId = result.body?.deploymentId;
      return typeof deploymentId === "string" && deploymentId ? deploymentId : null;
    },
    async promoteDeployment(auth, projectId, deploymentId) {
      const result = await request(auth, "POST", `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`);
      if (result.status === 409) return "CONFLICT";
      if (result.status !== 201 && result.status !== 202) throw failure(result.status, result.body, result.retryAfterMs);
      return "ACCEPTED";
    },
    async rollbackDeployment(auth, projectId, deploymentId) {
      const result = await request(auth, "POST", `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`);
      if (result.status === 409) return "CONFLICT";
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      return "ACCEPTED";
    },
    async cancelDeployment(auth, deploymentId) {
      const result = await request(auth, "PATCH", `/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`);
      if (result.status === 400) return "NOT_CANCELABLE";
      if (!result.ok) throw failure(result.status, result.body, result.retryAfterMs);
      return "CANCELED";
    },
  };
}
