import type { AgentProvider } from "./agent-provider.js";
import type { AgentRequest } from "./agent-types.js";
import { ApplicationError, type ErrorCode } from "../app/errors/application-error.js";

/** One instance per job, shared by generation and all repair loops. */
export class BudgetedAgentProvider implements AgentProvider {
  readonly id: string;
  requests = 0;
  tokens = 0;
  constructor(
    private readonly provider: AgentProvider,
    private readonly limits: {
      maxRequests: number;
      maxTokens: number;
      maxContextBytes: number;
      errorCode?: ErrorCode;
    },
  ) {
    this.id = provider.id;
  }
  getCapabilities() {
    return this.provider.getCapabilities();
  }
  async createResponse(request: AgentRequest) {
    const contextBytes = Buffer.byteLength(
      JSON.stringify({
        messages: request.messages,
        system: request.systemInstructions,
        tools: request.tools,
      }),
    );
    if (
      this.requests >= this.limits.maxRequests ||
      this.tokens >= this.limits.maxTokens ||
      contextBytes > this.limits.maxContextBytes
    ) {
      const code = this.limits.errorCode ?? "QUOTA_EXCEEDED";
      throw new ApplicationError(
        code,
        `This job reached its request, token, or conversation-size budget (${this.requests} requests, ${this.tokens} reported tokens). Try a smaller change.`,
        {
          metadata: { requests: this.requests, tokens: this.tokens, contextBytes, budgetExceeded: true },
        },
      );
    }
    this.requests++;
    const response = await this.provider.createResponse({
      ...request,
      maxOutputTokens: Math.max(
        1,
        Math.min(request.maxOutputTokens ?? 8192, this.limits.maxTokens - this.tokens),
      ),
    });
    this.tokens +=
      response.usage.inputTokens +
      response.usage.outputTokens +
      (response.usage.reasoningTokens ?? 0);
    return response;
  }
}
