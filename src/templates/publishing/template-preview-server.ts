import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Socket } from "node:net";
import { ApplicationError } from "../../app/errors/application-error.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

export interface TemplatePreviewServerSession {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly baseUrl: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface TemplatePreviewServer {
  readonly activeSessionCount: number;
  start(buildOutputDirectory: string): Promise<TemplatePreviewServerSession>;
}

export interface StaticTemplatePreviewServerOptions {
  readonly startupTimeoutMs?: number;
}

export class StaticTemplatePreviewServer implements TemplatePreviewServer {
  readonly #startupTimeoutMs: number;
  #activeSessionCount = 0;

  constructor(options: StaticTemplatePreviewServerOptions = {}) {
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  get activeSessionCount(): number {
    return this.#activeSessionCount;
  }

  async start(buildOutputDirectory: string): Promise<TemplatePreviewServerSession> {
    const root = resolve(buildOutputDirectory);
    try {
      if (!(await stat(resolve(root, "index.html"))).isFile()) throw new Error("index.html is not a file");
    } catch (error) {
      throw serverFailure("Template build output must contain index.html", error);
    }

    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      void serveRequest(root, request.url ?? "/", request.method ?? "GET", response).catch(
        () => send(response, 500, "Internal preview server error", "text/plain; charset=utf-8"),
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      this.#activeSessionCount = Math.max(0, this.#activeSessionCount - 1);
    };

    try {
      await listen(server, this.#startupTimeoutMs);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Dynamic preview port was not assigned");
      const baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
      this.#activeSessionCount++;
      await waitUntilReady(baseUrl, this.#startupTimeoutMs);
      return {
        host: LOOPBACK_HOST,
        port: address.port,
        baseUrl,
        get closed() {
          return closed;
        },
        close,
      };
    } catch (error) {
      await close();
      if (error instanceof ApplicationError) throw error;
      throw serverFailure("Template preview server failed to start", error);
    }
  }
}

async function serveRequest(
  root: string,
  requestUrl: string,
  method: string,
  response: ServerResponse,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    send(response, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://preview.invalid").pathname);
  } catch {
    send(response, 400, "Bad request", "text/plain; charset=utf-8");
    return;
  }
  const relativePath = pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath || "index.html");
  if (!isWithin(root, candidate)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  const directFile = await regularFile(candidate);
  const selected = directFile ?? (extname(pathname) ? undefined : resolve(root, "index.html"));
  if (!selected || !(await regularFile(selected))) {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const bytes = await readFile(selected);
  response.statusCode = 200;
  response.setHeader("Content-Type", CONTENT_TYPES[extname(selected).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("Content-Length", bytes.byteLength);
  response.setHeader("Cache-Control", "no-store");
  response.end(method === "HEAD" ? undefined : bytes);
}

async function regularFile(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function send(response: ServerResponse, status: number, body: string, contentType: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

async function listen(server: Server, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Preview server listen timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolvePromise();
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_HOST);
  });
}

async function waitUntilReady(baseUrl: string, timeoutMs: number): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Readiness returned HTTP ${response.status}`);
    await response.arrayBuffer();
  } catch (error) {
    throw serverFailure("Template preview server did not become ready", error);
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

function serverFailure(message: string, cause: unknown): ApplicationError {
  return new ApplicationError("TEMPLATE_PREVIEW_SERVER_FAILED", message, { cause });
}
