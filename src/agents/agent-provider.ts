import type { AgentCapabilities, AgentRequest, AgentResponse } from "./agent-types.js";
export interface AgentProvider {
  readonly id: string;
  getCapabilities(): AgentCapabilities;
  createResponse(request: AgentRequest): Promise<AgentResponse>;
}
