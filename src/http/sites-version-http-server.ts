import { createServer, type Server, type ServerResponse } from "node:http";
import { createAuthUser, type AuthenticatedRequest } from "../auth/auth-user.js";
import type { IdentityRepository } from "../auth/identity-repository.js";
import { ownerIdOf } from "../auth/owner-id.js";
import { sendResponse } from "../auth/send-response.js";
import { PRODUCTION_HEADERS, PRODUCTION_METHODS, matchProductionRoute, productionRoutes, readProductionBody, type ProductionRoute } from "./production-http-routes.js";
const jsonResponse = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};

export interface SitesVersionHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly identities: IdentityRepository;
  readonly jwtKey?: () => string | undefined;
  readonly routes?: readonly ProductionRoute[];
  /** Fast local state check. Missing/throwing checks fail closed; no dependency details are exposed. */
  readonly isReady?: () => boolean | Promise<boolean>;
  readonly shutdownTimeoutMs?: number;
}

/** Authenticated production HTTP boundary; history/restore routes are not mounted. */
export class SitesVersionHttpServer {
  readonly #authUser;
  readonly #routes;
  readonly #jwtKey;
  readonly #origins;
  #server: Server | undefined;
  #starting: Promise<void> | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;
  readonly #requests = new Set<Promise<void>>();

  constructor(private readonly options: SitesVersionHttpOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
      throw new Error("Invalid Sites HTTP port");
    for (const origin of options.allowedOrigins) {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin)
        throw new Error("Sites HTTP CORS requires explicit HTTP origins");
    }
    if (options.shutdownTimeoutMs !== undefined && (!Number.isInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 1 || options.shutdownTimeoutMs > 30_000))
      throw new Error("Invalid Sites HTTP shutdown timeout");
    this.#origins = new Set(options.allowedOrigins);
    this.#routes = productionRoutes(options.routes);
    this.#jwtKey = options.jwtKey ?? (() => process.env.JWTKEY);
    this.#authUser = createAuthUser({
      identities: options.identities,
      jwtKey: this.#jwtKey,
    });
  }

  async start(): Promise<string> {
    if (this.#server || this.#starting || this.#closing) throw new Error("Sites HTTP server cannot be restarted");
    const server = createServer((req, res) => {
      const task = this.#handle(req, res); this.#requests.add(task);
      void task.finally(() => this.#requests.delete(task)).catch(() => undefined);
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    this.#server = server;
    this.#starting = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, resolve);
    });
    await this.#starting;
    const address = server.address() as { port: number };
    const host = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
    return `http://${host}:${address.port}`;
  }

  close(): Promise<void> {
    this.#closing = true;
    return this.#closed ??= (async () => {
      await this.#starting?.catch(() => undefined);
      const server = this.#server;
      this.#server = undefined;
      if (!server?.listening) { server?.closeAllConnections(); return; }
      const timer = setTimeout(() => server.closeAllConnections(), this.options.shutdownTimeoutMs ?? 5_000);
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      } finally { clearTimeout(timer); }
    })();
  }

  /** Production composition drains handlers separately from bounded transport shutdown. */
  async drainRequests(): Promise<void> {
    await Promise.allSettled([...this.#requests]);
  }

  async #handle(req: AuthenticatedRequest, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && this.#origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", PRODUCTION_METHODS.join(","));
      res.setHeader("Access-Control-Allow-Headers", PRODUCTION_HEADERS.join(","));
    } else if (origin && !["GET", "HEAD"].includes(req.method ?? "GET")) {
      jsonResponse(res, 403, {
        error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" },
      });
      return;
    }
    if (req.method === "OPTIONS") {
      const method = req.headers["access-control-request-method"], headers = req.headers["access-control-request-headers"];
      if ((method && !PRODUCTION_METHODS.some(value => value === method)) ||
        (typeof headers === "string" && headers.split(",").some(header => !PRODUCTION_HEADERS.some(value => value === header.trim().toLowerCase())))) {
        jsonResponse(res, 403, { error: { code: "PREFLIGHT_NOT_ALLOWED", message: "Preflight not allowed" } }); return;
      }
      res.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://local"), method = req.method ?? "GET";
      if (["GET", "HEAD"].includes(method) && ["/healthz", "/readyz"].includes(url.pathname)) {
        let ready = false;
        if (url.pathname === "/readyz") {
          try { ready = !this.#closing && !!this.#jwtKey()?.trim() && await this.options.isReady?.() === true && !this.#closing; } catch { /* fail closed */ }
        }
        const ok = url.pathname === "/healthz" || ready;
        jsonResponse(res, ok ? 200 : 503, { status: url.pathname === "/healthz" ? "ok" : ready ? "ready" : "not_ready" }); return;
      }
      let params: Readonly<Record<string, string>> = {};
      const route = this.#routes.find(route => {
        const match = matchProductionRoute(route, method, url.pathname);
        if (!match) return false;
        params = match; return true;
      });
      if (this.#closing) { jsonResponse(res, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" } }); return; }
      if (route?.access === "oauth-callback") {
        await route.handle({ request: req, response: res, url }); return;
      }
      await this.#authUser(req, res, async () => {
        if (this.#closing) { jsonResponse(res, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" } }); return; }
        const ownerId = ownerIdOf(req);
        if (!ownerId) {
          sendResponse(res, 401, "Authentication Failed!", false);
          return;
        }
        if (res.writableEnded || res.headersSent) return;
        if (!route || route.access !== "authenticated") {
          jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "Endpoint not found" } }); return;
        }
        const body = route.body ? await readProductionBody(req, route.body) : undefined;
        if (this.#closing) { jsonResponse(res, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" } }); return; }
        await route.handle({ request: req, response: res, url, ownerId, params, body });
      });
    } catch (error) {
      // Only fixed public messages leave this boundary.
      const code = (error as { code?: unknown } | null)?.code;
      const errors: Record<string, { status: number; message: string }> = {
        SITE_NOT_FOUND: { status: 404, message: "Site not found" },
        VERSION_NOT_FOUND: { status: 404, message: "Version not found" },
        SOURCE_NOT_FOUND: { status: 404, message: "Source not found" },
        SOURCE_FILE_NOT_FOUND: { status: 404, message: "Source file not found" },
        SOURCE_UNAVAILABLE: { status: 422, message: "Saved source is unavailable" },
        SOURCE_TOO_LARGE: { status: 413, message: "Saved source exceeds read limits" },
        SERVICE_UNAVAILABLE: { status: 503, message: "Service unavailable" },
        PRODUCTION_CONFIGURATION_INVALID: { status: 503, message: "Saved artifact or publishing configuration is unavailable. Contact the service administrator." },
        PUBLISH_STATUS_UNAVAILABLE: { status: 503, message: "Publishing status is unavailable" },
        INVALID_REQUEST: { status: 400, message: "Invalid request" },
        DEV_JOB_BUSY: { status: 409, message: "Project operation in progress" },
        REQUEST_TOO_LARGE: { status: 413, message: "Request is too large" },
      };
      const publicCode =
        typeof code === "string" && Object.hasOwn(errors, code) ? code : "REQUEST_FAILED";
      const failure = errors[publicCode] ?? { status: 500, message: "Request failed" };
      if (publicCode === "REQUEST_TOO_LARGE" && !res.headersSent) res.setHeader("Connection", "close");
      if (!res.headersSent)
        jsonResponse(res, failure.status, {
          error: { code: publicCode, message: failure.message },
        });
      else res.destroy();
    }
  }
}
