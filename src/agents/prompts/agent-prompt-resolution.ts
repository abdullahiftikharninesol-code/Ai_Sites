import { ApplicationError } from "../../app/errors/application-error.js";
import {
  AGENT_CONTRACT_REGISTRY,
  type AgentContract,
  type AgentContractRegistry,
  type AgentContractStage,
  type AgentId,
} from "../contracts/agent-contract.js";
import {
  PROMPT_REGISTRY,
  type PromptDefinition,
  type PromptRegistry,
} from "./prompt-registry.js";

export interface ResolvedAgentPrompt {
  readonly agentContract: AgentContract;
  readonly prompt: PromptDefinition;
}

/**
 * Resolve the immutable prompt selected by an active AgentContract.
 *
 * This boundary is deliberately provider-free: a missing or incompatible
 * prompt fails before an AgentProvider can dispatch a request.
 */
export function resolveAgentPrompt(
  agentId: AgentId,
  options: {
    readonly expectedStage?: AgentContractStage;
    readonly agentContracts?: Pick<AgentContractRegistry, "getCurrentAgentContract">;
    readonly prompts?: Pick<PromptRegistry, "getCurrentPrompt" | "getPrompt">;
  } = {},
): ResolvedAgentPrompt {
  const agentContracts = options.agentContracts ?? AGENT_CONTRACT_REGISTRY;
  const prompts = options.prompts ?? PROMPT_REGISTRY;
  const agentContract = agentContracts.getCurrentAgentContract(agentId);

  if (agentContract.lifecycle.status !== "ACTIVE") {
    throw new ApplicationError(
      "INVALID_AGENT_CONTRACT",
      `Agent '${agentContract.agentId}' is not ACTIVE for a new run`,
    );
  }
  if (options.expectedStage !== undefined && agentContract.stage !== options.expectedStage) {
    throw new ApplicationError(
      "PROMPT_STAGE_MISMATCH",
      `Agent '${agentContract.agentId}' stage '${agentContract.stage}' does not match expected stage '${options.expectedStage}'`,
    );
  }

  // The registry's explicit release pointer is authoritative. The contract's
  // version is retained as compatibility metadata, so exact-version rollback
  // does not require mutating an immutable contract definition.
  const prompt = prompts.getCurrentPrompt(agentContract.prompt.promptId);

  if (prompt.promptId !== agentContract.prompt.promptId) {
    throw new ApplicationError(
      "PROMPT_AGENT_CONTRACT_MISMATCH",
      `Prompt '${prompt.promptId}' does not match agent prompt reference '${agentContract.prompt.promptId}'`,
    );
  }
  if (prompt.stage !== agentContract.stage) {
    throw new ApplicationError(
      "PROMPT_STAGE_MISMATCH",
      `Prompt '${prompt.promptId}' stage '${prompt.stage}' does not match agent stage '${agentContract.stage}'`,
    );
  }
  if (
    !prompt.compatibleAgentContracts.some(
      (compatible) =>
        compatible.agentId === agentContract.agentId &&
        compatible.contractVersion === agentContract.contractVersion,
    )
  ) {
    throw new ApplicationError(
      "PROMPT_AGENT_CONTRACT_MISMATCH",
      `Prompt '${prompt.promptId}' is not compatible with agent '${agentContract.agentId}' contract v${agentContract.contractVersion}`,
    );
  }
  if (
    prompt.responseContract &&
    (prompt.responseContract.id !== agentContract.responseContract.id ||
      prompt.responseContract.kind !== agentContract.responseContract.kind ||
      prompt.responseContract.schemaId !== agentContract.responseContract.schemaId)
  ) {
    throw new ApplicationError(
      "PROMPT_AGENT_CONTRACT_MISMATCH",
      `Prompt '${prompt.promptId}' response contract is incompatible with agent '${agentContract.agentId}'`,
    );
  }
  if (prompt.lifecycle.status !== "ACTIVE") {
    throw new ApplicationError(
      "INVALID_PROMPT_DEFINITION",
      `Prompt '${prompt.promptId}' is not ACTIVE for a new run`,
    );
  }

  return { agentContract, prompt };
}

export function resolveSiteCoderPrompt(
  options: Parameters<typeof resolveAgentPrompt>[1] = {},
): ResolvedAgentPrompt {
  return resolveAgentPrompt("sites.site-coder", {
    ...options,
    expectedStage: "GENERATE_SITE",
  });
}
