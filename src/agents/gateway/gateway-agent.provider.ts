import type { AgentProvider } from "../agent-provider.js";
import type { AgentCapabilities, AgentRequest } from "../agent-types.js";
import type { AgentGateway } from "./agent-gateway.js";
export interface GatewayAgentMetadata {
  readonly jobId: string;
  readonly siteId: string;
  readonly provider: string;
  readonly operation: "GENERATE_SITE" | "EDIT_SITE" | "REPAIR";
  readonly userRequest: string;
}
export class GatewayAgentProvider implements AgentProvider {
  readonly id: string;
  constructor(
    private readonly gateway: AgentGateway,
    private readonly metadata: GatewayAgentMetadata,
    private readonly capabilities: AgentCapabilities,
  ) {
    this.id = metadata.provider;
  }
  getCapabilities(): AgentCapabilities {
    return this.capabilities;
  }
  async createResponse(request: AgentRequest) {
    return (await this.gateway.createResponse({ ...this.metadata, agentRequest: request }))
      .response;
  }
}
