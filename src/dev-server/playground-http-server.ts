import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApplicationError } from "../app/errors/application-error.js";
import { reportTemplateAuthenticationFailure } from "../templates/application/template-instantiation-diagnostics.js";
import {
  PlaygroundService,
  loadPlaygroundConfig,
  type PlaygroundConfig,
} from "./playground-service.js";
import { attachSitesSocketServer } from "../sites/socket/sites-socket.js";
import type { Server as SocketIoServer } from "socket.io";
import {
  createAuthUser,
  type AuthenticatedRequest,
  type AuthUserMiddleware,
} from "../auth/auth-user.js";
import { ownerIdOf } from "../auth/owner-id.js";
import { sendResponse } from "../auth/send-response.js";
import { requireSitesSubscription } from "../auth/sites-subscription.js";
import { parseTemplateReference } from "../templates/application/template-design-context.js";
import {
  parseTemplateCatalogQuery,
  parseTemplateVersion,
  validateTemplateKey,
} from "../templates/http/template-catalog-query.js";

export function normalizePlaygroundPrompt(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 20_000)
    throw Object.assign(new Error("prompt must contain 3 to 20000 characters"), {
      code: "INVALID_REQUEST",
    });
  return value.trim();
}

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 64_000)
      throw Object.assign(new Error("Request is too large"), { code: "REQUEST_TOO_LARGE" });
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object");
    return value as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { code: "INVALID_REQUEST" });
  }
};
const readBytes = async (req: IncomingMessage, maximum = 10 * 1024 * 1024) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximum)
      throw Object.assign(new Error("Image is too large"), { code: "IMAGE_TOO_LARGE" });
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
};
const safeError = (error: unknown) => {
  const value = (error ?? {}) as { code?: unknown; message?: unknown };
  const allowed = new Set([
    "SITE_NOT_FOUND",
    "VERSION_NOT_FOUND",
    "DEPLOYMENT_NOT_FOUND",
    "DEV_JOB_BUSY",
    "INVALID_REQUEST",
    "REQUEST_TOO_LARGE",
    "VALIDATION_FAILED",
    "DEPLOYMENT_BUILD_FAILED",
    "SOURCE_NOT_FOUND",
    "SOURCE_FILE_NOT_FOUND",
    "UNSUPPORTED_IMAGE_TYPE",
    "IMAGE_TOO_LARGE",
    "IMAGE_INGESTION_FAILED",
    "USER_ASSET_NOT_FOUND",
    "USER_ASSET_NOT_REFERENCED",
    "SUBSCRIPTION_REQUIRED",
    "TEMPLATE_NOT_FOUND",
    "TEMPLATE_SOURCE_INTEGRITY_FAILED",
    "TEMPLATE_INSTANTIATION_BUILD_FAILED",
    "TEMPLATE_INSTANTIATION_QA_FAILED",
    "UNSAFE_TEMPLATE_SOURCE",
    "MANIFEST_INVALID",
  ]);
  const code =
    typeof value.code === "string" && allowed.has(value.code) ? value.code : "DEV_REQUEST_FAILED";
  return {
    code,
    message:
      code === "DEV_REQUEST_FAILED"
        ? "Development request failed"
        : typeof value.message === "string"
          ? value.message
          : "Request failed",
  };
};
export class PlaygroundHttpServer {
  readonly service: PlaygroundService;
  readonly config: PlaygroundConfig;
  #server: Server | undefined;
  #socketServer: SocketIoServer | undefined;
  readonly #authUser: AuthUserMiddleware;
  readonly #readsJwtKeyFromEnv: boolean;
  constructor(
    config = loadPlaygroundConfig(),
    service?: PlaygroundService,
    authUser?: AuthUserMiddleware,
  ) {
    if (!["127.0.0.1", "localhost", "::1"].includes(config.host))
      throw new Error("The unauthenticated playground must bind to a loopback address");
    this.config = config;
    this.service = service ?? new PlaygroundService(config);
    this.#authUser = authUser ?? createAuthUser({ identities: this.service.identities });
    this.#readsJwtKeyFromEnv = !authUser;
  }
  async start() {
    if (this.#readsJwtKeyFromEnv && !process.env.JWTKEY)
      console.warn("[sites][auth] JWTKEY is not configured; authenticated routes will fail closed");
    await this.service.start();
    this.#server = createServer((req, res) => void this.#handle(req, res));
    // The Socket.IO playground keeps its development identity until the
    // GetChatly socket integration phase; it never reaches authenticated HTTP owners.
    const socketOwnerId = String(this.service.userId);
    this.#socketServer = attachSitesSocketServer(
      this.#server,
      {
        userId: socketOwnerId,
        jobs: this.service.jobs,
        generate: (prompt) => this.service.generate(socketOwnerId, prompt),
        edit: (siteId, prompt, baseVersionId) =>
          this.service.edit(socketOwnerId, siteId, prompt, baseVersionId),
      },
      { allowedOrigins: this.config.webOrigins },
    );
    try {
      await new Promise<void>((resolve, reject) =>
        this.#server!.once("error", reject).listen(this.config.port, this.config.host, resolve),
      );
    } catch (error) {
      if (this.#socketServer)
        await new Promise<void>((resolve) => {
          void this.#socketServer!.close(() => resolve());
        });
      this.#socketServer = undefined;
      this.#server = undefined;
      await this.service.close();
      throw error;
    }
    const address = this.#server.address() as { port: number };
    return `http://${this.config.host}:${address.port}`;
  }
  async close() {
    const server = this.#server;
    const socketServer = this.#socketServer;
    this.#server = undefined;
    this.#socketServer = undefined;
    if (socketServer)
      await new Promise<void>((resolve) => {
        void socketServer.close(() => resolve());
      });
    else if (server)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    await this.service.close();
  }
  async #handle(req: AuthenticatedRequest, res: ServerResponse) {
    this.#headers(req, res);
    if (req.method === "POST" && /^\/api\/site-templates\/[a-z0-9-]+\/instantiate(?:\?|$)/.test(req.url ?? ""))
      res.once("finish", () => {
        if (res.statusCode === 401 || res.statusCode === 403) reportTemplateAuthenticationFailure(res.statusCode);
      });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") &&
      req.headers.origin &&
      !this.config.webOrigins.includes(req.headers.origin)
    ) {
      this.#json(res, 403, {
        error: { code: "ORIGIN_NOT_ALLOWED", message: "This origin cannot modify the playground" },
      });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://local"),
        path = url.pathname,
        method = req.method ?? "GET";
      if (method === "GET" && path === "/api/dev/health")
        return this.#json(res, 200, {
          status: "ok",
          mode: "local-playground",
          agentProvider: this.service.agentProviderId,
          agentModel: this.service.agentModel,
          executionProvider: "local",
          database: this.service.databaseStatus(),
        });
      // Every route below is user-scoped. Ownership is derived only from the
      // authenticated req.user; ownerId/userId/user/createdBy and similar
      // fields in the body, query or headers are never read.
      const ownerId = await this.#authenticate(req, res);
      if (!ownerId) return;
      if (method === "GET" && path === "/api/site-templates")
        return this.#json(
          res,
          200,
          await this.service.listActiveTemplates(parseTemplateCatalogQuery(url.searchParams)),
        );
      if (method === "GET" && path === "/api/site-categories")
        return this.#json(res, 200, await this.service.listActiveTemplateCategories());
      const templateMatch = /^\/api\/site-templates\/([^/]+)$/.exec(path);
      if (method === "GET" && templateMatch)
        return this.#json(
          res,
          200,
          await this.service.getActiveTemplate(
            validateTemplateKey(decodeRouteParam(templateMatch[1]!)),
            parseTemplateVersion(url.searchParams),
          ),
        );
      const templateInstantiationMatch =
        /^\/api\/site-templates\/([^/]+)\/instantiate$/.exec(path);
      if (method === "POST" && templateInstantiationMatch) {
        const body = await readJson(req);
        const version = body.version;
        if (
          version !== undefined &&
          (!Number.isSafeInteger(version) || Number(version) < 1)
        )
          throw Object.assign(new Error("version must be a positive integer"), {
            code: "INVALID_REQUEST",
          });
        if (
          body.projectName !== undefined &&
          (typeof body.projectName !== "string" ||
            !body.projectName.trim() ||
            body.projectName.length > 60)
        )
          throw Object.assign(new Error("projectName must contain 1 to 60 characters"), {
            code: "INVALID_REQUEST",
          });
        return this.#json(
          res,
          201,
          await this.service.instantiateTemplate(
            ownerId,
            validateTemplateKey(decodeRouteParam(templateInstantiationMatch[1]!)),
            version as number | undefined,
            body.projectName,
          ),
        );
      }
      if (method === "POST" && path === "/api/dev/persistence/sites") {
        const body = await readJson(req);
        if (typeof body.name !== "string")
          throw Object.assign(new Error("name is required"), { code: "INVALID_REQUEST" });
        return this.#json(
          res,
          201,
          await this.service.createPersistenceTestSite(ownerId, body.name),
        );
      }
      if (method === "POST" && path === "/api/dev/assets") {
        const originalName = url.searchParams.get("name") ?? req.headers["x-sites-file-name"];
        const mimeType = url.searchParams.get("mime") ?? req.headers["content-type"];
        if (typeof originalName !== "string" || typeof mimeType !== "string")
          throw Object.assign(new Error("Image filename and type are required"), {
            code: "INVALID_REQUEST",
          });
        return this.#json(
          res,
          201,
          await this.service.ingestImage(ownerId, {
            originalName,
            mimeType,
            bytes: await readBytes(req),
          }),
        );
      }
      if (method === "POST" && path === "/api/dev/sites") {
        requireSitesSubscription(req.user);
        const body = await readJson(req),
          prompt = this.#prompt(body.prompt);
        const job = this.service.generate(
          ownerId,
          prompt,
          this.#attachmentIds(body.attachments),
          this.#attachmentIds(body.referenceAttachments) ?? [],
          parseTemplateReference(body.templateReference),
          typeof body.generationRequestId === "string" ? body.generationRequestId : undefined,
        );
        return this.#json(res, 202, { jobId: job.id });
      }
      if (method === "GET" && path === "/api/dev/sites")
        return this.#json(res, 200, { sites: await this.service.listSites(ownerId) });
      let match = /^\/api\/dev\/jobs\/([^/]+)$/.exec(path);
      if (method === "GET" && match) {
        const job = this.service.getJob(ownerId, match[1]!);
        if (!job)
          return this.#json(res, 404, { error: { code: "NOT_FOUND", message: "Job not found" } });
        return this.#json(res, 200, { ...job, events: undefined });
      }
      match = /^\/api\/dev\/jobs\/([^/]+)\/events$/.exec(path);
      if (method === "GET" && match) return this.#sse(res, ownerId, match[1]!);
      match = /^\/api\/dev\/sites\/([^/]+)\/edit$/.exec(path);
      if (method === "POST" && match) {
        requireSitesSubscription(req.user);
        const body = await readJson(req),
          job = await this.service.edit(
            ownerId,
            match[1]!,
            this.#prompt(body.prompt),
            typeof body.baseVersionId === "string" ? body.baseVersionId : undefined,
            this.#attachmentIds(body.attachments),
            this.#attachmentIds(body.referenceAttachments) ?? [],
          );
        return this.#json(res, 202, { jobId: job.id, projectId: match[1] });
      }
      match = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/preview$/.exec(path);
      if (method === "POST" && match)
        return this.#json(
          res,
          201,
          await this.service.startPreview(
            ownerId,
            decodeRouteParam(match[1]!),
            decodeRouteParam(match[2]!),
          ),
        );
      match = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/files$/.exec(path);
      if (method === "GET" && match)
        return this.#json(
          res,
          200,
          await this.service.sourceFiles(
            ownerId,
            decodeRouteParam(match[1]!),
            decodeRouteParam(match[2]!),
            url.searchParams.get("path") ?? undefined,
          ),
        );
      match = /^\/api\/dev\/previews\/([^/]+)$/.exec(path);
      if (method === "GET" && match)
        return this.#json(res, 200, await this.service.previewInspector(ownerId, match[1]!));
      if (method === "DELETE" && match)
        return this.#json(res, 200, {
          stopped: await this.service.stopPreview(ownerId, match[1]!),
        });
      match = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/publish$/.exec(path);
      if (method === "POST" && match)
        return this.#json(
          res,
          201,
          await this.service.publish(
            ownerId,
            decodeRouteParam(match[1]!),
            decodeRouteParam(match[2]!),
          ),
        );
      match = /^\/api\/dev\/sites\/([^/]+)\/unpublish$/.exec(path);
      if (method === "POST" && match)
        return this.#json(res, 200, await this.service.unpublish(ownerId, match[1]!));
      match = /^\/api\/dev\/sites\/([^/]+)\/runtime$/.exec(path);
      if (method === "GET" && match)
        return this.#json(res, 200, await this.service.runtimeInspector(ownerId, match[1]!));
      match = /^\/api\/dev\/sites\/([^/]+)$/.exec(path);
      if (method === "PATCH" && match) {
        const body = await readJson(req);
        if (typeof body.name !== "string")
          throw Object.assign(new Error("name is required"), { code: "INVALID_REQUEST" });
        return this.#json(res, 200, await this.service.renameSite(ownerId, match[1]!, body.name));
      }
      if (method === "DELETE" && match)
        return this.#json(res, 200, await this.service.deleteSite(ownerId, match[1]!));
      if (method === "GET" && match)
        return this.#json(res, 200, await this.service.siteDetail(ownerId, match[1]!));
      this.#json(res, 404, {
        error: { code: "NOT_FOUND", message: "Development endpoint not found" },
      });
    } catch (error) {
      const normalized = safeError(error);
      if (!(error instanceof ApplicationError) && process.env.SITES_DEV_LOG_ERRORS === "1")
        console.error(error);
      this.#json(
        res,
        normalized.code === "SITE_NOT_FOUND" ||
          normalized.code === "VERSION_NOT_FOUND" ||
          normalized.code === "DEPLOYMENT_NOT_FOUND" ||
          normalized.code === "SOURCE_NOT_FOUND" ||
          normalized.code === "SOURCE_FILE_NOT_FOUND" ||
          normalized.code === "TEMPLATE_NOT_FOUND"
          ? 404
          : normalized.code === "SUBSCRIPTION_REQUIRED"
            ? 402
            : normalized.code === "DEV_JOB_BUSY"
              ? 409
              : normalized.code === "REQUEST_TOO_LARGE"
                ? 413
                : normalized.code === "DEV_REQUEST_FAILED"
                  ? 500
                  : 400,
        { error: normalized },
      );
    }
  }
  /** Runs GetChatly authUser; resolves the owner only when it called next(). */
  async #authenticate(req: AuthenticatedRequest, res: ServerResponse): Promise<string | null> {
    const result: { ownerId: string | null } = { ownerId: null };
    await this.#authUser(req, res, () => {
      result.ownerId = ownerIdOf(req);
    });
    if (res.writableEnded || res.headersSent) return null;
    if (!result.ownerId) {
      sendResponse(res, 401, "Authentication Failed!", false);
      return null;
    }
    return result.ownerId;
  }
  #prompt(value: unknown) {
    return normalizePlaygroundPrompt(value);
  }
  #attachmentIds(value: unknown): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.some((id) => typeof id !== "string" || !/^user-[a-f0-9-]{36}$/.test(id))
    )
      throw Object.assign(new Error("attachments must be managed image IDs"), {
        code: "INVALID_REQUEST",
      });
    if (new Set(value).size !== value.length)
      throw Object.assign(new Error("attachments must not contain duplicates"), {
        code: "INVALID_REQUEST",
      });
    return value.map(String);
  }
  #headers(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && this.config.webOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "authorization, content-type, x-sites-file-name",
      );
    }
  }
  #json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  #sse(res: ServerResponse, ownerId: string, id: string) {
    const job = this.service.getJob(ownerId, id);
    if (!job) {
      this.#json(res, 404, { error: { code: "NOT_FOUND", message: "Job not found" } });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of job.events) this.#writeSse(res, event);
    if (job.status === "SUCCEEDED" || job.status === "FAILED") {
      res.end();
      return;
    }
    const unsubscribe = this.service.jobs.subscribe(id, (event) => {
      this.#writeSse(res, event);
      if (event.type === "JOB_COMPLETED" || event.type === "JOB_FAILED") {
        unsubscribe();
        res.end();
      }
    });
    res.on("close", unsubscribe);
  }
  #writeSse(res: ServerResponse, event: { type: string; intelligence?: unknown }) {
    const name = event.type === "INTELLIGENCE_TASK_UPDATED" ? "intelligence" : "progress";
    res.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("Invalid URL path parameter"), { code: "INVALID_REQUEST" });
  }
}
