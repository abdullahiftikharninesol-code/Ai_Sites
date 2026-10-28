import { describe, expect, it } from "vitest";
import type { AgentProvider } from "../src/agents/agent-provider.js";
import type { AgentRequest, AgentResponse } from "../src/agents/agent-types.js";
import { AgentCodingLoop } from "../src/agents/agent-loop.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { SitesToolExecutor } from "../src/agents/tool-executor.js";
import { getInferenceContextPolicy } from "../src/agents/budget/inference-context-policy.js";
import {
  PROMPT_REGISTRY,
  type PromptDefinition,
  type PromptRegistry,
} from "../src/agents/prompts/prompt-registry.js";
import {
  resolveAgentPrompt,
} from "../src/agents/prompts/agent-prompt-resolution.js";
import { SITES_BUILD_REPAIR_PROMPT_V2 } from "../src/agents/prompts/sites-build-repair-v2.prompt.js";
import { AGENT_CONTRACT_REGISTRY } from "../src/agents/contracts/agent-contract.js";

const response = (request: AgentRequest): AgentResponse => ({
  id: "phase-3a-6-response",
  model: request.model,
  message: { role: "assistant", content: "repair complete" },
  toolCalls: [],
  usage: { inputTokens: 3, outputTokens: 2 },
  latencyMs: 1,
  finishReason: "stop",
});

describe("Layer 3A.6 Build Repair Agent migration", () => {
  it("resolves sites.build-repair contract v1 to the exact active prompt v1", () => {
    const resolved = resolveAgentPrompt("sites.build-repair", {
      expectedStage: "BUILD_REPAIR",
    });
    expect(resolved.agentContract.agentId).toBe("sites.build-repair");
    expect(resolved.agentContract.contractVersion).toBe(1);
    expect(resolved.agentContract.stage).toBe("BUILD_REPAIR");
    expect(resolved.agentContract.prompt).toEqual({
      promptId: "sites.build-repair",
      promptVersion: 2,
    });
    expect(resolved.prompt.promptId).toBe("sites.build-repair");
    expect(resolved.prompt.promptVersion).toBe(2);
    expect(resolved.prompt.lifecycle.status).toBe("ACTIVE");
    expect(resolved.prompt.stage).toBe("BUILD_REPAIR");
    expect(resolved.prompt.systemPrompt).toBe(SITES_BUILD_REPAIR_PROMPT_V2);
    expect(resolved.prompt.promptHash).toBe(
      PROMPT_REGISTRY.getPrompt("sites.build-repair", 2).promptHash,
    );
  });

  it("uses the shared registered prompt in BUILD_REPAIR before provider dispatch", async () => {
    const requests: AgentRequest[] = [];
    const provider: AgentProvider = {
      id: "phase-3a-6-provider",
      getCapabilities: () => ({
        models: ["phase-3a-6-model"],
        toolCalling: true,
        streaming: false,
        cachedInput: false,
      }),
      createResponse: async (request) => {
        requests.push(request);
        return response(request);
      },
    };
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    const policy = getInferenceContextPolicy("BUILD_REPAIR");

    await new AgentCodingLoop(provider, new SitesToolExecutor(execution), {
      stage: "BUILD_REPAIR",
      maxTurns: 1,
      maxToolCalls: 12,
      maxOutputTokens: policy.outputPolicy.defaultMaxOutputTokens,
      reasoningPolicy: policy.reasoningPolicy,
      tools: policy.tools,
      finalizeOnMaxTurns: true,
    }).run(environment.id, "Build output: TypeScript error in src/App.tsx");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.systemInstructions).toBe(
      resolveAgentPrompt("sites.build-repair", { expectedStage: "BUILD_REPAIR" }).prompt.systemPrompt,
    );
    expect(requests[0]?.messages[0]?.content).toContain("TypeScript error");
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "apply_patch",
      "search_files",
    ]);
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain("finalize_generation");
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain("run_command");
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain("start_preview");
  });

  it("keeps the shared prompt text, hash, repair policy, and authority unchanged", () => {
    const resolved = resolveAgentPrompt("sites.build-repair", {
      expectedStage: "BUILD_REPAIR",
    });
    const policy = getInferenceContextPolicy("BUILD_REPAIR");
    const contract = AGENT_CONTRACT_REGISTRY.getAgentContract("sites.build-repair", 1);
    expect(resolved.prompt.systemPrompt).toBe(SITES_BUILD_REPAIR_PROMPT_V2);
    expect(resolved.prompt.promptHash).toBe(
      PROMPT_REGISTRY.getPrompt("sites.build-repair", 2).promptHash,
    );
    // The active production contract is one structured response without tools.
    // The legacy tool-loop policy remains available to its isolated migration
    // fixture above; it must not re-enable tools in the production contract.
    expect(contract.tools).toEqual([]);
    expect(policy.tools.map((tool) => tool.name)).toEqual(["read_file", "write_file", "apply_patch", "search_files"]);
    expect(contract.reasoningPolicy.id).toBe("BUILD_REPAIR_DEFAULT");
    expect(contract.contextPolicy.id).toBe("BUILD_REPAIR_CONTEXT");
    expect(policy.reasoningPolicy).toBe("LOW");
    expect(policy.contextStrategy).toBe("TARGETED_FILES");
    expect(policy.outputPolicy.defaultMaxOutputTokens).toBe(4_096);
  });

  it("fails closed for missing, wrong-stage, and incompatible prompt references", () => {
    const agentContracts = {
      getCurrentAgentContract: (agentId: string) =>
        AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(agentId),
    };
    const missing: Pick<PromptRegistry, "getCurrentPrompt" | "getPrompt"> = {
      getCurrentPrompt: () => {
        throw new Error("build repair prompt missing");
      },
      getPrompt: () => {
        throw new Error("build repair prompt missing");
      },
    };
    expect(() =>
      resolveAgentPrompt("sites.build-repair", {
        expectedStage: "BUILD_REPAIR",
        agentContracts,
        prompts: missing,
      }),
    ).toThrow("build repair prompt missing");

    const valid = PROMPT_REGISTRY.getPrompt("sites.build-repair", 1);
    const wrongStage: PromptDefinition = { ...valid, stage: "GENERATE_SITE" };
    const wrongStageRegistry: Pick<PromptRegistry, "getCurrentPrompt" | "getPrompt"> = {
      getCurrentPrompt: () => wrongStage,
      getPrompt: () => wrongStage,
    };
    expect(() =>
      resolveAgentPrompt("sites.build-repair", {
        expectedStage: "BUILD_REPAIR",
        agentContracts,
        prompts: wrongStageRegistry,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROMPT_STAGE_MISMATCH" }) as Error);

    const incompatible: PromptDefinition = {
      ...valid,
      compatibleAgentContracts: [{ agentId: "sites.build-repair", contractVersion: 99 }],
    };
    const incompatibleRegistry: Pick<PromptRegistry, "getCurrentPrompt" | "getPrompt"> = {
      getCurrentPrompt: () => incompatible,
      getPrompt: () => incompatible,
    };
    expect(() =>
      resolveAgentPrompt("sites.build-repair", {
        expectedStage: "BUILD_REPAIR",
        agentContracts,
        prompts: incompatibleRegistry,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROMPT_AGENT_CONTRACT_MISMATCH" }) as Error);
  });
});
