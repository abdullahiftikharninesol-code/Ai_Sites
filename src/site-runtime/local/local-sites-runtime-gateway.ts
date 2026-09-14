import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteAuthService } from "../../site-security/site-auth-service.js";
import type { SiteExternalApiGateway } from "../../site-security/site-external-api-gateway.js";
import type { SiteOriginPolicy } from "../../site-security/site-origin-policy.js";
import type { LocalSecurityTelemetry } from "../../site-security/security-telemetry.js";
import type { SiteUser } from "../../site-security/site-auth-provider.js";
import type { SiteId } from "../../shared/types.js";
import type { LocalRuntimeRateLimiter } from "../runtime-rate-limiter.js";
import type { RuntimeActor, SiteRuntimeService } from "../site-runtime-service.js";

export interface LocalRuntimeGatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly maxRequestBytes: number;
}
export interface LocalRuntimeSecurityConfig {
  readonly auth: SiteAuthService;
  readonly actions: SiteExternalApiGateway;
  readonly origins: SiteOriginPolicy;
  readonly telemetry?: LocalSecurityTelemetry;
  readonly authLimiter?: LocalRuntimeRateLimiter;
  readonly actionLimiter?: LocalRuntimeRateLimiter;
}
export class LocalSitesRuntimeGateway {
  #server?: Server;
  constructor(
    private readonly service: SiteRuntimeService,
    private readonly config: LocalRuntimeGatewayConfig,
    private readonly security?: LocalRuntimeSecurityConfig,
  ) {}
  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) res.destroy();
        else
          this.#send(
            res,
            400,
            undefined,
            new ApplicationError("VALIDATION_FAILED", "Invalid runtime request"),
          );
      });
    });
    await new Promise<void>((resolve, reject) =>
      this.#server?.listen(this.config.port, this.config.host, resolve).once("error", reject),
    );
    const address = this.#server.address() as AddressInfo;
    return `http://${this.config.host}:${address.port}`;
  }
  async close(): Promise<void> {
    if (this.#server)
      await new Promise<void>((resolve, reject) =>
        this.#server?.close((error) => (error ? reject(error) : resolve())),
      );
  }
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://runtime.local"),
      route =
        /^\/runtime\/v1\/sites\/([^/]+)\/(auth\/(signup|login|logout|me)|actions\/([^/]+)|data\/([a-z][a-z0-9_]{0,62})(?:\/([^/]+))?)$/.exec(
          url.pathname,
        );
    if (!route?.[1]) {
      this.#send(
        res,
        404,
        undefined,
        new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Runtime route was not found"),
      );
      return;
    }
    const siteId = decodeURIComponent(route[1]) as SiteId,
      origin = req.headers.origin;
    try {
      await this.#cors(siteId, origin, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (this.security && !["GET", "HEAD"].includes(req.method ?? ""))
        await this.#assertMutationOrigin(siteId, origin);
      if (route[3]) {
        await this.#auth(req, res, siteId, route[3]);
        return;
      }
      const { actor, user } = await this.#actor(req, siteId);
      if (route[4]) {
        await this.#action(req, res, siteId, decodeURIComponent(route[4]), actor, user);
        return;
      }
      await this.#data(
        req,
        res,
        url,
        siteId,
        route[5] ?? "",
        route[6] ? decodeURIComponent(route[6]) : undefined,
        actor,
      );
    } catch (error) {
      const app =
        error instanceof ApplicationError
          ? error
          : new ApplicationError("RUNTIME_PROVIDER_FAILED", "Runtime request failed");
      this.#send(res, this.#status(app), undefined, this.#browserError(app));
    }
  }
  async #cors(siteId: SiteId, origin: string | undefined, res: ServerResponse): Promise<void> {
    if (!origin) return;
    const allowed = this.security
      ? await this.security.origins.isAllowed(siteId, origin)
      : this.config.allowedOrigins.includes(origin);
    if (!allowed) {
      this.security?.telemetry?.increment(siteId, "originRejected");
      throw new ApplicationError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  async #assertMutationOrigin(siteId: SiteId, origin?: string): Promise<void> {
    if (!origin || !this.security || !(await this.security.origins.isAllowed(siteId, origin))) {
      this.security?.telemetry?.increment(siteId, "csrfRejected");
      throw new ApplicationError("CSRF_VALIDATION_FAILED", "Mutation origin validation failed");
    }
  }
  async #auth(
    req: IncomingMessage,
    res: ServerResponse,
    siteId: SiteId,
    operation: string,
  ): Promise<void> {
    if (!this.security)
      throw new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Site authentication is not enabled");
    await this.service.listCollections(siteId, { kind: "INTERNAL" });
    const key = `${siteId}:${req.socket.remoteAddress ?? "unknown"}:${operation}`;
    try {
      if (operation === "signup" || operation === "login") this.security.authLimiter?.consume(key);
    } catch {
      this.security.telemetry?.increment(siteId, "authRateLimited");
      throw new ApplicationError("AUTH_RATE_LIMITED", "Authentication rate limit exceeded");
    }
    const token = this.#token(req);
    try {
      if (operation === "me" && req.method === "GET") {
        this.security.telemetry?.increment(siteId, "sessionValidations");
        this.#send(res, 200, await this.security.auth.me(siteId, token));
        return;
      }
      if (operation === "logout" && req.method === "POST") {
        await this.security.auth.logout(siteId, token);
        this.security.telemetry?.increment(siteId, "logoutCount");
        res.setHeader("Set-Cookie", this.security.auth.clearCookie());
        this.#send(res, 200, { loggedOut: true });
        return;
      }
      if ((operation === "signup" || operation === "login") && req.method === "POST") {
        this.security.telemetry?.increment(
          siteId,
          operation === "signup" ? "signupAttempts" : "loginAttempts",
        );
        const body = (await this.#body(req)) as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || typeof body.password !== "string")
          throw new ApplicationError("AUTH_INVALID_CREDENTIALS", "Invalid email or password");
        const result =
          operation === "signup"
            ? await this.security.auth.signup(siteId, body.email, body.password)
            : await this.security.auth.login(siteId, body.email, body.password);
        this.security.telemetry?.increment(
          siteId,
          operation === "signup" ? "signupSuccesses" : "loginSuccesses",
        );
        res.setHeader("Set-Cookie", result.cookie);
        this.#send(res, operation === "signup" ? 201 : 200, result.user);
        return;
      }
      throw new ApplicationError("RUNTIME_OPERATION_FORBIDDEN", "Auth method is not allowed");
    } catch (error) {
      if (operation === "signup") this.security.telemetry?.increment(siteId, "signupFailures");
      if (operation === "login") this.security.telemetry?.increment(siteId, "loginFailures");
      throw error;
    }
  }
  async #actor(
    req: IncomingMessage,
    siteId: SiteId,
  ): Promise<{ actor: RuntimeActor; user?: SiteUser }> {
    const clientId = req.socket.remoteAddress ?? "unknown",
      token = this.#token(req);
    if (!this.security || !token) return { actor: { kind: "PUBLIC", clientId } };
    try {
      const user = await this.security.auth.me(siteId, token);
      this.security.telemetry?.increment(siteId, "sessionValidations");
      return { actor: { kind: "AUTHENTICATED", clientId, userId: user.id }, user };
    } catch {
      return { actor: { kind: "PUBLIC", clientId } };
    }
  }
  async #action(
    req: IncomingMessage,
    res: ServerResponse,
    siteId: SiteId,
    name: string,
    actor: RuntimeActor,
    user?: SiteUser,
  ): Promise<void> {
    if (req.method !== "POST" || !this.security)
      throw new ApplicationError("RUNTIME_OPERATION_FORBIDDEN", "Action method is not allowed");
    this.security.telemetry?.increment(siteId, "actionAttempts");
    try {
      this.security.actionLimiter?.consume(
        `${siteId}:${name}:${actor.kind === "AUTHENTICATED" ? actor.userId : actor.kind === "PUBLIC" ? actor.clientId : "internal"}`,
      );
    } catch {
      this.security.telemetry?.increment(siteId, "actionRateLimited");
      throw new ApplicationError(
        "EXTERNAL_ACTION_RATE_LIMITED",
        "External action rate limit exceeded",
      );
    }
    try {
      const result = await this.security.actions.execute(
        siteId,
        name,
        (await this.#body(req)) as Record<string, unknown>,
        user,
      );
      this.security.telemetry?.increment(siteId, "actionSuccesses");
      this.#send(res, 200, result);
    } catch (error) {
      this.security.telemetry?.increment(siteId, "actionFailures");
      throw error;
    }
  }
  async #data(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    siteId: SiteId,
    collection: string,
    recordId: string | undefined,
    actor: RuntimeActor,
  ): Promise<void> {
    if (req.method === "POST" && !recordId)
      this.#send(
        res,
        201,
        await this.service.create(siteId, collection, await this.#body(req), actor),
      );
    else if (req.method === "GET" && recordId)
      this.#send(res, 200, await this.service.get(siteId, collection, recordId, actor));
    else if (req.method === "GET") {
      const limit = this.#number(url, "limit"),
        offset = this.#number(url, "offset");
      this.#send(
        res,
        200,
        await this.service.list(
          siteId,
          collection,
          {
            ...(limit !== undefined ? { limit } : {}),
            ...(offset !== undefined ? { offset } : {}),
          },
          actor,
        ),
      );
    } else if (req.method === "PATCH" && recordId)
      this.#send(
        res,
        200,
        await this.service.update(siteId, collection, recordId, await this.#body(req), actor),
      );
    else if (req.method === "DELETE" && recordId) {
      await this.service.delete(siteId, collection, recordId, actor);
      this.#send(res, 200, { deleted: true });
    } else
      throw new ApplicationError("RUNTIME_OPERATION_FORBIDDEN", "Runtime method is not allowed");
  }
  #token(req: IncomingMessage): string | undefined {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("sites_session="));
    return cookie ? decodeURIComponent(cookie.slice("sites_session=".length)) : undefined;
  }
  async #body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of req) {
      const value: unknown = raw;
      const chunk =
        typeof value === "string"
          ? Buffer.from(value)
          : value instanceof Uint8Array
            ? Buffer.from(value)
            : Buffer.alloc(0);
      size += chunk.length;
      if (size > this.config.maxRequestBytes)
        throw new ApplicationError(
          "RUNTIME_VALIDATION_FAILED",
          "Runtime request body is too large",
        );
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ApplicationError(
        "RUNTIME_VALIDATION_FAILED",
        "Runtime request body must be valid JSON",
      );
    }
  }
  #number(url: URL, key: string): number | undefined {
    const raw = url.searchParams.get(key);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0)
      throw new ApplicationError("RUNTIME_VALIDATION_FAILED", `Invalid ${key}`);
    return value;
  }
  #status(error: ApplicationError): number {
    return error.code.includes("RATE_LIMITED")
      ? 429
      : error.code === "AUTH_UNAUTHENTICATED" ||
          error.code === "AUTH_REQUIRED" ||
          error.code === "SESSION_EXPIRED"
        ? 401
        : error.code.includes("FORBIDDEN") ||
            error.code.includes("ORIGIN") ||
            error.code.includes("CSRF")
          ? 403
          : error.code.includes("NOT_FOUND")
            ? 404
            : error.code === "AUTH_EMAIL_TAKEN"
              ? 409
              : 400;
  }
  #browserError(error: ApplicationError): ApplicationError {
    const code =
      error.code === "AUTH_UNAUTHENTICATED"
        ? "AUTH_REQUIRED"
        : error.code === "AUTH_INVALID_CREDENTIALS"
          ? "INVALID_CREDENTIALS"
          : error.code;
    return new ApplicationError(code, error.message);
  }
  #send(res: ServerResponse, status: number, data?: unknown, error?: ApplicationError): void {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res
      .writeHead(status)
      .end(
        JSON.stringify(
          error
            ? { ok: false, error: { code: error.code, message: error.message } }
            : { ok: true, data },
        ),
      );
  }
}
