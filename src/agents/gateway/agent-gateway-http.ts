import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentGateway, AgentGatewayRequest, AgentGatewayResponse } from "./agent-gateway.js";
import type { SitesJobTokenService } from "./sites-job-token.js";

export class AgentGatewayHttpServer {
  #server?: Server;
  constructor(
    private readonly gateway: AgentGateway,
    private readonly tokens: SitesJobTokenService,
  ) {}
  async start(host = "127.0.0.1", port = 0): Promise<string> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) =>
      this.#server?.listen(port, host, resolve).once("error", reject),
    );
    const address = this.#server.address() as AddressInfo;
    return `http://${host}:${address.port}`;
  }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/agent/responses") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk: unknown = raw;
        if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
        else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
        else throw new Error("Invalid request body chunk");
      }
      if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 1_000_000)
        throw new Error("Request too large");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentGatewayRequest;
      const authorization = request.headers.authorization;
      this.tokens.verify(
        authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
        body.jobId,
        body.siteId,
      );
      const result = await this.gateway.createResponse(body);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : "Unauthorized" }));
    }
  }
  async close(): Promise<void> {
    if (this.#server)
      await new Promise<void>((resolve, reject) =>
        this.#server?.close((error) => (error ? reject(error) : resolve())),
      );
  }
}

export class RemoteAgentGatewayClient implements AgentGateway {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}
  async createResponse(request: AgentGatewayRequest): Promise<AgentGatewayResponse> {
    const response = await fetch(`${this.url}/v1/agent/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Agent Gateway HTTP request failed (${response.status})`);
    return response.json() as Promise<AgentGatewayResponse>;
  }
}
