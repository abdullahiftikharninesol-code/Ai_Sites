import { randomUUID } from "node:crypto";
import type { AgentProviderRegistry } from "../registry/agent-provider-registry.js";
import type { AgentGateway, AgentGatewayRequest, AgentGatewayResponse } from "./agent-gateway.js";
export class InProcessAgentGateway implements AgentGateway {
  constructor(private readonly providers: AgentProviderRegistry) {}
  async createResponse(request: AgentGatewayRequest): Promise<AgentGatewayResponse> {
    const providerId = request.provider === "mock" ? "mock-agent" : request.provider;
    const provider = this.providers.get(providerId);
    const model = request.model ?? provider.getCapabilities().models[0];
    if (!model) throw new Error(`Agent provider '${request.provider}' has no configured model`);
    const response = await provider.createResponse({ ...request.agentRequest, model });
    return {
      requestId: randomUUID(),
      provider: request.provider,
      model: response.model,
      response,
      toolCalls: response.toolCalls,
      usage: response.usage,
      finishReason: response.finishReason,
    };
  }
}
