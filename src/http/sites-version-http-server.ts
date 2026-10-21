import { createServer, type Server, type ServerResponse } from "node:http";
import { createAuthUser, type AuthenticatedRequest } from "../auth/auth-user.js";
import type { IdentityRepository } from "../auth/identity-repository.js";
import { ownerIdOf } from "../auth/owner-id.js";
import { sendResponse } from "../auth/send-response.js";
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
}

/** Authenticated production HTTP boundary; history/restore routes are not mounted. */
export class SitesVersionHttpServer {
  readonly #authUser;
  #server: Server | undefined;

  constructor(private readonly options: SitesVersionHttpOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
      throw new Error("Invalid Sites HTTP port");
    for (const origin of options.allowedOrigins) {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin)
        throw new Error("Sites HTTP CORS requires explicit HTTP origins");
    }
    this.#authUser = createAuthUser({
      identities: options.identities,
      ...(options.jwtKey ? { jwtKey: options.jwtKey } : {}),
    });
  }

  async start(): Promise<string> {
    if (this.#server) throw new Error("Sites HTTP server is already started");
    const server = createServer((req, res) => void this.#handle(req, res));
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, resolve);
    });
    this.#server = server;
    const address = server.address() as { port: number };
    const host = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
    return `http://${host}:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }

  async #handle(req: AuthenticatedRequest, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && this.options.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
    } else if (origin && !["GET", "HEAD"].includes(req.method ?? "GET")) {
      jsonResponse(res, 403, {
        error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" },
      });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    try {
      await this.#authUser(req, res, () => {
        const ownerId = ownerIdOf(req);
        if (!ownerId) {
          sendResponse(res, 401, "Authentication Failed!", false);
          return;
        }
        jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "Endpoint not found" } });
      });
    } catch (error) {
      // Only fixed public messages leave this boundary.
      const code = (error as { code?: unknown } | null)?.code;
      const errors: Record<string, { status: number; message: string }> = {
        SITE_NOT_FOUND: { status: 404, message: "Site not found" },
        INVALID_REQUEST: { status: 400, message: "Invalid request" },
        DEV_JOB_BUSY: { status: 409, message: "Project operation in progress" },
      };
      const publicCode =
        typeof code === "string" && Object.hasOwn(errors, code) ? code : "REQUEST_FAILED";
      const failure = errors[publicCode] ?? { status: 500, message: "Request failed" };
      if (!res.headersSent)
        jsonResponse(res, failure.status, {
          error: { code: publicCode, message: failure.message },
        });
      else res.destroy();
    }
  }
}
