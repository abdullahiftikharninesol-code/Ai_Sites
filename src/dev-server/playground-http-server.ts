import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApplicationError } from "../app/errors/application-error.js";
import {
  PlaygroundService,
  loadPlaygroundConfig,
  type PlaygroundConfig,
} from "./playground-service.js";

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
  constructor(config = loadPlaygroundConfig(), service?: PlaygroundService) {
    if (!["127.0.0.1", "localhost", "::1"].includes(config.host))
      throw new Error("The unauthenticated playground must bind to a loopback address");
    this.config = config;
    this.service = service ?? new PlaygroundService(config);
  }
  async start() {
    await this.service.start();
    this.#server = createServer((req, res) => void this.#handle(req, res));
    try {
      await new Promise<void>((resolve, reject) =>
        this.#server!.once("error", reject).listen(this.config.port, this.config.host, resolve),
      );
    } catch (error) {
      this.#server = undefined;
      await this.service.close();
      throw error;
    }
    const address = this.#server.address() as { port: number };
    return `http://${this.config.host}:${address.port}`;
  }
  async close() {
    const server = this.#server;
    this.#server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    await this.service.close();
  }
  async #handle(req: IncomingMessage, res: ServerResponse) {
    this.#headers(req, res);
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
        });
      if (method === "POST" && path === "/api/dev/sites") {
        const body = await readJson(req),
          prompt = this.#prompt(body.prompt);
        const job = this.service.generate(prompt);
        return this.#json(res, 202, { jobId: job.id });
      }
      if (method === "GET" && path === "/api/dev/sites")
        return this.#json(res, 200, { sites: await this.service.listSites() });
      let match = /^\/api\/dev\/jobs\/([^/]+)$/.exec(path);
      if (method === "GET" && match) {
        const job = this.service.jobs.get(match[1]!);
        if (!job) throw Object.assign(new Error("Job not found"), { code: "INVALID_REQUEST" });
        return this.#json(res, 200, { ...job, events: undefined });
      }
      match = /^\/api\/dev\/jobs\/([^/]+)\/events$/.exec(path);
      if (method === "GET" && match) return this.#sse(res, match[1]!);
      match = /^\/api\/dev\/sites\/([^/]+)\/edit$/.exec(path);
      if (method === "POST" && match) {
        const body = await readJson(req),
          job = await this.service.edit(
            match[1]!,
            this.#prompt(body.prompt),
            typeof body.baseVersionId === "string" ? body.baseVersionId : undefined,
          );
        return this.#json(res, 202, { jobId: job.id, projectId: match[1] });
      }
      match = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/preview$/.exec(path);
      if (method === "POST" && match)
        return this.#json(res, 201, await this.service.startPreview(match[1]!, match[2]!));
      match = /^\/api\/dev\/previews\/([^/]+)$/.exec(path);
      if (method === "GET" && match)
        return this.#json(res, 200, await this.service.previewInspector(match[1]!));
      if (method === "DELETE" && match)
        return this.#json(res, 200, { stopped: await this.service.stopPreview(match[1]!) });
      match = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/publish$/.exec(path);
      if (method === "POST" && match)
        return this.#json(res, 201, await this.service.publish(match[1]!, match[2]!));
      match = /^\/api\/dev\/sites\/([^/]+)\/rollback$/.exec(path);
      if (method === "POST" && match) {
        const body = await readJson(req);
        if (typeof body.deploymentId !== "string")
          throw Object.assign(new Error("deploymentId is required"), { code: "INVALID_REQUEST" });
        return this.#json(res, 200, await this.service.rollback(match[1]!, body.deploymentId));
      }
      match = /^\/api\/dev\/sites\/([^/]+)\/unpublish$/.exec(path);
      if (method === "POST" && match)
        return this.#json(res, 200, await this.service.unpublish(match[1]!));
      match = /^\/api\/dev\/sites\/([^/]+)\/runtime$/.exec(path);
      if (method === "GET" && match)
        return this.#json(res, 200, await this.service.runtimeInspector(match[1]!));
      match = /^\/api\/dev\/sites\/([^/]+)\/versions$/.exec(path);
      if (method === "GET" && match)
        return this.#json(res, 200, { versions: await this.service.versions(match[1]!) });
      match = /^\/api\/dev\/sites\/([^/]+)$/.exec(path);
      if (method === "DELETE" && match)
        return this.#json(res, 200, await this.service.deleteSite(match[1]!));
      if (method === "GET" && match)
        return this.#json(res, 200, await this.service.siteDetail(match[1]!));
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
          normalized.code === "DEPLOYMENT_NOT_FOUND"
          ? 404
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
  #prompt(value: unknown) {
    if (typeof value !== "string" || value.trim().length < 3 || value.length > 20_000)
      throw Object.assign(new Error("prompt must contain 3 to 20000 characters"), {
        code: "INVALID_REQUEST",
      });
    return value.trim();
  }
  #headers(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && this.config.webOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
    }
  }
  #json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  #sse(res: ServerResponse, id: string) {
    const job = this.service.jobs.get(id);
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
