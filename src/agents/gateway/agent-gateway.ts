import type { AgentRequest, AgentResponse } from "../agent-types.js";
import type { SiteSpec } from "../../sites/domain/site-spec.js";
export interface AgentGatewayRequest {
  readonly jobId: string;
  readonly siteId: string;
  readonly provider: string;
  readonly model?: string;
  readonly operation: "GENERATE_SITE" | "EDIT_SITE" | "REPAIR";
  readonly siteSpec?: SiteSpec;
  readonly userRequest: string;
  readonly workspaceContext?: string;
  readonly limits?: { readonly maxAgentTurns?: number; readonly maxToolCalls?: number };
  readonly agentRequest: AgentRequest;
}
export interface AgentGatewayResponse {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly response: AgentResponse;
  readonly toolCalls: AgentResponse["toolCalls"];
  readonly usage: AgentResponse["usage"];
  readonly finishReason: AgentResponse["finishReason"];
}
export interface AgentGateway {
  createResponse(request: AgentGatewayRequest): Promise<AgentGatewayResponse>;
}
