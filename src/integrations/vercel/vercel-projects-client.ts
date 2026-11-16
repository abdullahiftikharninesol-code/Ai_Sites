import { VERCEL_API_BASE_URL } from "./vercel-oauth-client.js";

/**
 * Server-side Vercel REST calls for project linkage (official contracts):
 *   GET  /v1/integrations/configuration/{id}  installation scope and project access
 *   GET  /v9/projects/{idOrName}              look up an existing project
 *   POST /v11/projects                        create a project
 * Team installations pass `teamId` on every request. No call is retried here;
 * callers decide (and never retry automatically on permission errors).
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface VercelAuth {
  readonly accessToken: string;
  readonly teamId: string | null;
}

export interface VercelConfigurationInfo {
  readonly id: string;
  readonly ownerId?: string;
  readonly teamId: string | null;
  readonly projectSelection?: "all" | "selected";
  /** Project IDs the installation may access when projectSelection is "selected". */
  readonly projects?: readonly string[];
  readonly scopes: readonly string[];
  readonly disabled: boolean;
}

export interface VercelProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly accountId: string;
}

const VERCEL_API_ERROR = Symbol.for("ai-sites.VercelApiError");

/** A non-2xx Vercel response or a transport failure (status undefined). */
export class VercelApiError extends Error {
  readonly [VERCEL_API_ERROR] = true;
  /** Brand check: classification must not depend on module identity. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== VercelApiError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[VERCEL_API_ERROR] === true;
  }
  constructor(
    readonly status: number | undefined,
    readonly vercelCode?: string,
    readonly vercelMessage?: string,
    /** From a 429/503 Retry-After header, when Vercel sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(`Vercel API request failed${status ? ` (${status})` : ""}`);
    this.name = "VercelApiError";
  }
}

export interface VercelProjectsClient {
  getConfiguration(auth: VercelAuth, configurationId: string): Promise<VercelConfigurationInfo>;
  /** Undefined when Vercel reports 404. */
  findProject(auth: VercelAuth, idOrName: string): Promise<VercelProjectInfo | undefined>;
  /** "CONFLICT" when a project with that name already exists (409). */
  createProject(auth: VercelAuth, input: { readonly name: string }): Promise<VercelProjectInfo | "CONFLICT">;
  /** Display name of the authorized team (GET /v2/teams/{id}) or user (GET /v2/user); undefined when Vercel doesn't say. */
  getAccountName(auth: VercelAuth): Promise<string | undefined>;
}

const text = (value: unknown, max = 200) =>
  typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").slice(0, max) : undefined;

const parseProject = (body: unknown): VercelProjectInfo => {
  const value = body as Record<string, unknown> | undefined;
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.accountId !== "string" ||
    !value.id ||
    !value.accountId
  )
    throw new VercelApiError(200, "invalid_response", "Vercel returned an unexpected project response");
  return { id: value.id, name: value.name, accountId: value.accountId };
};

export function createVercelProjectsClient(
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl = VERCEL_API_BASE_URL,
): VercelProjectsClient {
  const call = async (auth: VercelAuth, method: "GET" | "POST", path: string, body?: unknown) => {
    const url = new URL(`${baseUrl}${path}`);
    if (auth.teamId) url.searchParams.set("teamId", auth.teamId);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VercelApiError(undefined);
    }
    const parsed = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    return { status: response.status, ok: response.ok, body: parsed };
  };
  const failure = (status: number, body: Record<string, unknown> | undefined) => {
    const error = body?.error as Record<string, unknown> | undefined;
    const code = text(error?.code, 64);
    return new VercelApiError(status, code && /^[A-Za-z0-9_.-]+$/.test(code) ? code : undefined, text(error?.message));
  };

  return {
    async getConfiguration(auth, configurationId) {
      const result = await call(auth, "GET", `/v1/integrations/configuration/${encodeURIComponent(configurationId)}`);
      if (!result.ok) throw failure(result.status, result.body);
      const body = result.body ?? {};
      if (typeof body.id !== "string") throw new VercelApiError(result.status, "invalid_response");
      const selection = body.projectSelection;
      return {
        id: body.id,
        ...(typeof body.ownerId === "string" ? { ownerId: body.ownerId } : {}),
        teamId: typeof body.teamId === "string" && body.teamId ? body.teamId : null,
        ...(selection === "all" || selection === "selected" ? { projectSelection: selection } : {}),
        ...(Array.isArray(body.projects)
          ? { projects: body.projects.filter((id): id is string => typeof id === "string") }
          : {}),
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [],
        disabled: body.disabledAt !== undefined && body.disabledAt !== null,
      };
    },
    async findProject(auth, idOrName) {
      const result = await call(auth, "GET", `/v9/projects/${encodeURIComponent(idOrName)}`);
      if (result.status === 404) return undefined;
      if (!result.ok) throw failure(result.status, result.body);
      return parseProject(result.body);
    },
    async createProject(auth, input) {
      // A static, prebuilt upload: no framework detection, no build on Vercel.
      const result = await call(auth, "POST", "/v11/projects", { name: input.name, framework: null });
      if (result.status === 409) return "CONFLICT";
      if (!result.ok) throw failure(result.status, result.body);
      return parseProject(result.body);
    },
    async getAccountName(auth) {
      const result = auth.teamId
        ? await call({ ...auth, teamId: null }, "GET", `/v2/teams/${encodeURIComponent(auth.teamId)}`)
        : await call(auth, "GET", "/v2/user");
      if (!result.ok) throw failure(result.status, result.body);
      const body = (auth.teamId ? result.body : (result.body?.user as Record<string, unknown> | undefined)) ?? {};
      // Only a short, printable name is ever shown; never an email address.
      const name = text(body.name, 80) ?? text(auth.teamId ? body.slug : body.username, 80);
      return name && !name.includes("@") && /\S/.test(name) ? name.trim() : undefined;
    },
  };
}
