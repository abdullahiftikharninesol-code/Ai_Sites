import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type {
  SiteDeploymentRepository,
  SiteProjectRepository,
} from "../persistence/repositories.js";
import type { SiteDeploymentManifest } from "../deployment/deployment-service.js";
import type { CustomDomainRepository } from "../domains/custom-domain-repository.js";
import { normalizeHostname } from "../domains/custom-domain.js";
import type { IncomingMessage } from "node:http";
export class LocalHostingProvider {
  readonly id = "local-hosting";
  readonly capabilities = {
    staticHosting: true,
    spaFallback: true,
    customDomains: true,
    cdn: false,
    tls: false,
    edgeCaching: false,
  };
  #server?: Server;
  #port = 0;
  constructor(
    private readonly projects: SiteProjectRepository,
    private readonly deployments: SiteDeploymentRepository,
    private readonly artifacts: ArtifactStore,
    private readonly host = "127.0.0.1",
    private readonly port = 8088,
    private readonly domains?: CustomDomainRepository,
  ) {}
  async start() {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) res.destroy();
        else res.writeHead(503).end("Deployment unavailable");
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.port, this.host, () => resolve());
    });
    this.#port = (this.#server.address() as { port: number }).port;
  }
  url(slug: string) {
    return `http://${this.host}:${this.#port}/sites/${slug}/`;
  }
  async close() {
    if (this.#server)
      await new Promise<void>((resolve, reject) =>
        this.#server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
  async #handle(req: IncomingMessage, res: ServerResponse) {
    const raw = req.url ?? "/",
      method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!["GET", "HEAD"].includes(method)) {
      res.writeHead(405).end();
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(new URL(raw, "http://local").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const match = /^\/sites\/([^/]+)\/(.*)$/.exec(decoded);
    if (decoded.includes("..") || decoded.includes("\\")) {
      res.writeHead(404).end("Not found");
      return;
    }
    let project, requestedPath: string;
    if (match) {
      project = await this.projects.getBySlug(match[1]!);
      requestedPath = match[2] || "index.html";
    } else {
      let hostname: string;
      try {
        hostname = hostHeaderHostname(req.headers.host);
      } catch {
        res.writeHead(400).end("Invalid host");
        return;
      }
      const domain = await this.domains?.findByHostname(hostname);
      if (!domain || domain.status !== "ACTIVE") {
        res.writeHead(404).end("Not found");
        return;
      }
      project = await this.projects.getById(domain.siteId);
      requestedPath = decoded.replace(/^\//, "") || "index.html";
    }
    if (!project?.publishedDeploymentId) {
      res.writeHead(404).end("Site not published");
      return;
    }
    const deployment = await this.deployments.getById(project.publishedDeploymentId);
    if (!deployment?.deploymentArtifactRef) {
      res.writeHead(503).end("Deployment unavailable");
      return;
    }
    const bytes = await this.artifacts.get(deployment.deploymentArtifactRef);
    if (!bytes) {
      res.writeHead(503).end("Deployment unavailable");
      return;
    }
    let manifest: SiteDeploymentManifest;
    try {
      manifest = JSON.parse(Buffer.from(bytes).toString()) as SiteDeploymentManifest;
    } catch {
      res.writeHead(503).end("Deployment invalid");
      return;
    }
    const path = requestedPath;
    let file = manifest.files.find((item) => item.path === path);
    if (!file && !/\.[a-z0-9]+$/i.test(path))
      file = manifest.files.find((item) => item.path === "index.html");
    if (!file) {
      res.writeHead(404).end("Not found");
      return;
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) {
      res.writeHead(503).end("Deployment invalid");
      return;
    }
    res.setHeader("Content-Type", mime(file.path));
    res.setHeader(
      "Cache-Control",
      file.path === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    );
    res.writeHead(200);
    res.end(method === "HEAD" ? undefined : content);
  }
}
export function hostHeaderHostname(value: string | undefined): string {
  if (
    !value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    throw new Error("Invalid Host");
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match?.[1] || (match[2] && Number(match[2]) > 65535)) throw new Error("Invalid Host");
  return normalizeHostname(match[1]);
}
const mime = (path: string) =>
  path.endsWith(".html")
    ? "text/html; charset=utf-8"
    : path.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : path.endsWith(".css")
        ? "text/css; charset=utf-8"
        : path.endsWith(".svg")
          ? "image/svg+xml"
          : path.endsWith(".png")
            ? "image/png"
            : path.endsWith(".jpg") || path.endsWith(".jpeg")
              ? "image/jpeg"
              : path.endsWith(".gif")
                ? "image/gif"
                : path.endsWith(".webp")
                  ? "image/webp"
                  : path.endsWith(".avif")
                    ? "image/avif"
          : "application/octet-stream";
