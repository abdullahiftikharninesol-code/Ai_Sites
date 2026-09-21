import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import {
  AGENT_CONTRACT_REGISTRY,
  type AgentContractStage,
  type AgentId,
  type AgentResponseContractKind,
  type AgentContractRegistry,
} from "../contracts/agent-contract.js";
import { SITES_BUILD_REPAIR_PROMPT_V2 } from "./sites-build-repair-v2.prompt.js";
import { SITES_SITE_PLANNER_PROMPT_V2 } from "./sites-site-planner-v2.prompt.js";
import { SITES_TARGETED_EDIT_PROMPT_V2 } from "./sites-targeted-edit-v2.prompt.js";
import { SITES_CODING_AGENT_PROMPT } from "./sites-coding-agent.prompt.js";
import { SITES_SITE_PLANNER_PROMPT } from "./sites-site-planner.prompt.js";
import { SITES_SITE_CODER_PROMPT_V2 } from "./sites-site-coder-v2.prompt.js";
import { SITES_SITE_CODER_PROMPT_V3 } from "./sites-site-coder-v3.prompt.js";
import { SITES_EDIT_PLANNER_PROMPT } from "./sites-edit-planner.prompt.js";
import { SITES_EDIT_PLANNER_PROMPT_V2 } from "./sites-edit-planner-v2.prompt.js";
import { SITES_SITE_CODER_PROMPT_V4 } from "./sites-site-coder-v4.prompt.js";

export type PromptId = AgentId;
export type PromptLifecycleStatus = "ACTIVE" | "DORMANT" | "DEPRECATED";

export interface PromptAgentContractCompatibility {
  readonly agentId: AgentId;
  readonly contractVersion: number;
}

export interface PromptResponseContractCompatibility {
  readonly id: string;
  readonly kind: AgentResponseContractKind;
  readonly schemaId?: string;
}

export interface PromptProviderCompatibility {
  readonly requiresStructuredOutput?: boolean;
  readonly requiresToolCalling?: boolean;
  readonly requiresVision?: boolean;
}

export interface PromptModelCompatibility {
  readonly allowedModels?: readonly string[];
}

export interface PromptDefinition {
  readonly promptId: PromptId;
  readonly promptVersion: number;
  readonly stage: AgentContractStage;
  readonly systemPrompt: string;
  readonly compatibleAgentContracts: readonly PromptAgentContractCompatibility[];
  readonly responseContract?: PromptResponseContractCompatibility;
  readonly providerCompatibility?: PromptProviderCompatibility;
  readonly modelCompatibility?: PromptModelCompatibility;
  readonly lifecycle: {
    readonly status: PromptLifecycleStatus;
  };
  readonly promptHash: string;
}

export interface PromptReleaseRecord {
  readonly agentId: PromptId;
  readonly fromVersion?: number;
  readonly toVersion: number;
  readonly fromHash?: string;
  readonly toHash: string;
  readonly reason: string;
  readonly timestamp: string;
}

export type PromptDefinitionInput = Omit<PromptDefinition, "promptHash" | "systemPrompt"> & {
  readonly systemPrompt: string;
};

const PROMPT_IDS: readonly PromptId[] = [
  "sites.site-planner",
  "sites.site-coder",
  "sites.build-repair",
  "sites.motion-repair",
  "sites.edit-planner",
  "sites.targeted-edit",
  "sites.asset-planner",
  "sites.visual-review",
  "sites.visual-repair",
];

const PROMPT_STAGES: readonly AgentContractStage[] = [
  "SITE_PLANNING",
  "GENERATE_SITE",
  "BUILD_REPAIR",
  "MOTION_REPAIR",
  "EDIT_PLANNING",
  "TARGETED_EDIT",
  "VISUAL_REVIEW",
  "VISUAL_REPAIR",
  "ASSET_PLANNING",
];

const RESPONSE_KINDS: readonly AgentResponseContractKind[] = ["TEXT", "JSON_SCHEMA", "TOOL_LOOP"];
const LIFECYCLE_STATUSES: readonly PromptLifecycleStatus[] = ["ACTIVE", "DORMANT", "DEPRECATED"];

function hasValue<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", `${field} must not be empty`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", `${field} must be a positive integer`);
  }
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sortedContracts(contracts: readonly PromptAgentContractCompatibility[]) {
  return [...contracts].sort(
    (left, right) => left.agentId.localeCompare(right.agentId) || left.contractVersion - right.contractVersion,
  );
}

function canonicalHashInput(definition: Omit<PromptDefinition, "promptHash">): string {
  return JSON.stringify({
    promptId: definition.promptId,
    promptVersion: definition.promptVersion,
    stage: definition.stage,
    systemPrompt: normalizePromptText(definition.systemPrompt),
    compatibleAgentContracts: sortedContracts(definition.compatibleAgentContracts),
    responseContract: definition.responseContract ?? null,
    providerCompatibility: definition.providerCompatibility ?? null,
    modelCompatibility: definition.modelCompatibility ?? null,
    lifecycle: definition.lifecycle,
  });
}

export function computePromptHash(definition: Omit<PromptDefinition, "promptHash">): string {
  return createHash("sha256").update(canonicalHashInput(definition), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createPromptDefinition(input: PromptDefinitionInput): PromptDefinition {
  const normalized: Omit<PromptDefinition, "promptHash"> = {
    ...input,
    systemPrompt: normalizePromptText(input.systemPrompt),
  };
  return deepFreeze({ ...normalized, promptHash: computePromptHash(normalized) });
}

export function validatePromptDefinition(
  definition: PromptDefinition,
  contractRegistry: AgentContractRegistry = AGENT_CONTRACT_REGISTRY,
): void {
  if (!definition || typeof definition !== "object") {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", "Prompt definition must be an object");
  }
  if (!hasValue(PROMPT_IDS, definition.promptId)) {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", `Unknown prompt ID '${definition.promptId}'`);
  }
  assertPositiveInteger(definition.promptVersion, "promptVersion");
  if (!hasValue(PROMPT_STAGES, definition.stage)) {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", `Unknown prompt stage '${definition.stage}'`);
  }
  assertNonEmpty(definition.systemPrompt, "systemPrompt");
  if (!hasValue(LIFECYCLE_STATUSES, definition.lifecycle.status)) {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", "Invalid prompt lifecycle status");
  }
  if (definition.lifecycle.status === "ACTIVE" && !definition.compatibleAgentContracts.length) {
    throw new ApplicationError("INVALID_PROMPT_DEFINITION", "Active prompts require a compatible agent contract");
  }
  const compatibilityKeys = definition.compatibleAgentContracts.map(
    (item) => `${item.agentId}@${item.contractVersion}`,
  );
  if (new Set(compatibilityKeys).size !== compatibilityKeys.length) {
    throw new ApplicationError(
      "INVALID_PROMPT_DEFINITION",
      "compatibleAgentContracts must not contain duplicates",
    );
  }
  for (const compatibility of definition.compatibleAgentContracts) {
    assertPositiveInteger(compatibility.contractVersion, "compatibleAgentContracts.contractVersion");
    let contract;
    try {
      contract = contractRegistry.getAgentContract(
        compatibility.agentId,
        compatibility.contractVersion,
      );
    } catch (cause) {
      if (definition.lifecycle.status !== "ACTIVE") continue;
      throw new ApplicationError(
        "PROMPT_AGENT_CONTRACT_MISMATCH",
        `Prompt '${definition.promptId}' references an unavailable agent contract`,
        { cause },
      );
    }
    if (definition.lifecycle.status === "ACTIVE" && contract.stage !== definition.stage) {
      throw new ApplicationError(
        "PROMPT_STAGE_MISMATCH",
        `Prompt '${definition.promptId}' stage '${definition.stage}' does not match agent contract stage '${contract.stage}'`,
      );
    }
  }
  if (definition.responseContract) {
    assertNonEmpty(definition.responseContract.id, "responseContract.id");
    if (!hasValue(RESPONSE_KINDS, definition.responseContract.kind)) {
      throw new ApplicationError("INVALID_PROMPT_DEFINITION", "Invalid response contract kind");
    }
    if (definition.responseContract.kind === "JSON_SCHEMA") {
      assertNonEmpty(definition.responseContract.schemaId ?? "", "responseContract.schemaId");
    }
    for (const compatibility of definition.compatibleAgentContracts) {
      let contract;
      try {
        contract = contractRegistry.getAgentContract(
          compatibility.agentId,
          compatibility.contractVersion,
        );
      } catch (cause) {
        if (definition.lifecycle.status !== "ACTIVE") continue;
        throw new ApplicationError(
          "PROMPT_AGENT_CONTRACT_MISMATCH",
          `Prompt '${definition.promptId}' references an unavailable agent contract`,
          { cause },
        );
      }
      if (definition.lifecycle.status === "ACTIVE" && (
        contract.responseContract.id !== definition.responseContract.id ||
        contract.responseContract.kind !== definition.responseContract.kind ||
        contract.responseContract.schemaId !== definition.responseContract.schemaId
      )) {
        throw new ApplicationError(
          "PROMPT_AGENT_CONTRACT_MISMATCH",
          `Prompt '${definition.promptId}' response contract is incompatible with agent contract '${compatibility.agentId}'`,
        );
      }
    }
  }
  if (definition.providerCompatibility) {
    for (const value of Object.values(definition.providerCompatibility)) {
      if (typeof value !== "boolean") {
        throw new ApplicationError("INVALID_PROMPT_DEFINITION", "Provider compatibility values must be boolean");
      }
    }
  }
  if (definition.modelCompatibility?.allowedModels) {
    if (definition.modelCompatibility.allowedModels.some((model) => !model.trim())) {
      throw new ApplicationError("INVALID_PROMPT_DEFINITION", "Allowed model names must not be empty");
    }
  }
  const expectedHash = computePromptHash(definition);
  if (!/^[a-f0-9]{64}$/.test(definition.promptHash)) {
    throw new ApplicationError("PROMPT_HASH_MISMATCH", `Prompt '${definition.promptId}' has an invalid hash`);
  }
  if (expectedHash !== definition.promptHash) {
    throw new ApplicationError("PROMPT_HASH_MISMATCH", `Prompt '${definition.promptId}' hash does not match its definition`);
  }
}

function historicalPrompt(
  promptId: PromptId,
  promptVersion: number,
  stage: AgentContractStage,
  systemPrompt: string,
  responseContract: PromptResponseContractCompatibility,
): PromptDefinition {
  return createPromptDefinition({
    promptId,
    promptVersion,
    stage,
    systemPrompt,
    compatibleAgentContracts: [{ agentId: promptId, contractVersion: 1 }],
    responseContract,
    lifecycle: { status: "DEPRECATED" },
  });
}

const structuredPromptCompatibility = {
  providerCompatibility: { requiresStructuredOutput: false },
} as const;

function dormantPrompt(
  promptId: PromptId,
  stage: AgentContractStage,
  systemPrompt: string,
  responseContract: PromptResponseContractCompatibility,
  providerCompatibility?: PromptProviderCompatibility,
  lifecycleStatus: PromptLifecycleStatus = "DORMANT",
): PromptDefinition {
  return createPromptDefinition({
    promptId,
    promptVersion: 2,
    stage,
    systemPrompt,
    compatibleAgentContracts: [{ agentId: promptId, contractVersion: 1 }],
    responseContract,
    ...(providerCompatibility ? { providerCompatibility } : {}),
    lifecycle: { status: lifecycleStatus },
  });
}

export const REGISTERED_PROMPT_DEFINITIONS: readonly PromptDefinition[] = deepFreeze([
  historicalPrompt("sites.site-planner", 1, "SITE_PLANNING", SITES_SITE_PLANNER_PROMPT, { id: "site-plan", kind: "JSON_SCHEMA", schemaId: "SitePlan" }),
  dormantPrompt("sites.site-planner", "SITE_PLANNING", SITES_SITE_PLANNER_PROMPT_V2, { id: "site-plan", kind: "JSON_SCHEMA", schemaId: "SitePlan" }, undefined, "ACTIVE"),
  historicalPrompt("sites.site-coder", 1, "GENERATE_SITE", SITES_CODING_AGENT_PROMPT, { id: "generation-tool-loop", kind: "TOOL_LOOP" }),
  historicalPrompt("sites.site-coder", 2, "GENERATE_SITE", SITES_SITE_CODER_PROMPT_V2, { id: "generation-tool-loop", kind: "TOOL_LOOP" }),
  historicalPrompt("sites.site-coder", 3, "GENERATE_SITE", SITES_SITE_CODER_PROMPT_V3, { id: "generation-tool-loop", kind: "TOOL_LOOP" }),
  createPromptDefinition({ promptId: "sites.site-coder", promptVersion: 4, stage: "GENERATE_SITE", systemPrompt: SITES_SITE_CODER_PROMPT_V4, compatibleAgentContracts: [{ agentId: "sites.site-coder", contractVersion: 1 }], responseContract: { id: "site-coder-file-bundle", kind: "JSON_SCHEMA", schemaId: "SiteCoderFileBundle" }, providerCompatibility: structuredPromptCompatibility.providerCompatibility, lifecycle: { status: "ACTIVE" } }),
  historicalPrompt("sites.build-repair", 1, "BUILD_REPAIR", SITES_CODING_AGENT_PROMPT, { id: "build-repair-tool-loop", kind: "TOOL_LOOP" }),
  dormantPrompt("sites.build-repair", "BUILD_REPAIR", SITES_BUILD_REPAIR_PROMPT_V2, { id: "build-repair-patch-bundle", kind: "JSON_SCHEMA", schemaId: "BuildRepairPatchBundle" }, structuredPromptCompatibility.providerCompatibility, "ACTIVE"),
  historicalPrompt("sites.edit-planner", 1, "EDIT_PLANNING", SITES_EDIT_PLANNER_PROMPT, { id: "site-edit-plan", kind: "JSON_SCHEMA", schemaId: "SiteEditPlan" }),
  historicalPrompt("sites.edit-planner", 2, "EDIT_PLANNING", SITES_EDIT_PLANNER_PROMPT_V2, { id: "site-edit-plan", kind: "JSON_SCHEMA", schemaId: "SiteEditPlan" }),
  historicalPrompt("sites.targeted-edit", 1, "TARGETED_EDIT", SITES_CODING_AGENT_PROMPT, { id: "targeted-edit-tool-loop", kind: "TOOL_LOOP" }),
  dormantPrompt("sites.targeted-edit", "TARGETED_EDIT", SITES_TARGETED_EDIT_PROMPT_V2, { id: "site-edit-patch-bundle", kind: "JSON_SCHEMA", schemaId: "SiteEditPatchBundle" }, structuredPromptCompatibility.providerCompatibility, "ACTIVE"),
]);

export class PromptRegistry {
  readonly #prompts = new Map<PromptId, Map<number, PromptDefinition>>();
  readonly #currentVersions = new Map<PromptId, number>();
  readonly #contractRegistry: AgentContractRegistry;
  readonly #releaseHistory: PromptReleaseRecord[] = [];

  constructor(
    definitions: readonly PromptDefinition[] = REGISTERED_PROMPT_DEFINITIONS,
    contractRegistry: AgentContractRegistry = AGENT_CONTRACT_REGISTRY,
  ) {
    this.#contractRegistry = contractRegistry;
    for (const definition of definitions) this.register(definition);
  }

  register(definition: PromptDefinition, options: { readonly current?: boolean } = {}): void {
    validatePromptDefinition(definition, this.#contractRegistry);
    const registered = deepFreeze(definition);
    let versions = this.#prompts.get(registered.promptId);
    if (!versions) {
      versions = new Map<number, PromptDefinition>();
      this.#prompts.set(registered.promptId, versions);
    }
    if (versions.has(registered.promptVersion)) {
      throw new ApplicationError(
        "DUPLICATE_PROMPT_VERSION",
        `Prompt '${registered.promptId}' version ${registered.promptVersion} is already registered`,
      );
    }
    versions.set(registered.promptVersion, registered);
    if (options.current === true) this.setCurrentPrompt(registered.promptId, registered.promptVersion);
    else if (registered.lifecycle.status === "ACTIVE" && !this.#currentVersions.has(registered.promptId))
      this.#currentVersions.set(registered.promptId, registered.promptVersion);
  }

  getPrompt(promptId: string, promptVersion: number): PromptDefinition {
    const versions = this.#prompts.get(promptId as PromptId);
    if (!versions) throw new ApplicationError("UNKNOWN_PROMPT", `Prompt '${promptId}' is not registered`);
    const prompt = versions.get(promptVersion);
    if (!prompt) {
      throw new ApplicationError(
        "UNKNOWN_PROMPT_VERSION",
        `Prompt '${promptId}' version ${promptVersion} is not registered`,
      );
    }
    return prompt;
  }

  getCurrentPrompt(promptId: string): PromptDefinition {
    const versions = this.#prompts.get(promptId as PromptId);
    if (!versions) throw new ApplicationError("UNKNOWN_PROMPT", `Prompt '${promptId}' is not registered`);
    const version = this.#currentVersions.get(promptId as PromptId);
    if (version === undefined) {
      throw new ApplicationError("NO_CURRENT_PROMPT", `Prompt '${promptId}' has no current version`);
    }
    return versions.get(version)!;
  }

  setCurrentPrompt(promptId: string, promptVersion: number, reason = "explicit production release"): void {
    const previous = this.#currentVersions.get(promptId as PromptId);
    const prompt = this.getPrompt(promptId, promptVersion);
    if (prompt.lifecycle.status !== "ACTIVE") {
      throw new ApplicationError(
        "INVALID_PROMPT_DEFINITION",
        `Only ACTIVE prompts can be current for new runs: '${promptId}' version ${promptVersion}`,
      );
    }
    this.#currentVersions.set(prompt.promptId, prompt.promptVersion);
    this.#releaseHistory.push(Object.freeze({
      agentId: prompt.promptId,
      ...(previous !== undefined ? {
        fromVersion: previous,
        fromHash: this.getPrompt(prompt.promptId, previous).promptHash,
      } : {}),
      toVersion: prompt.promptVersion,
      toHash: prompt.promptHash,
      reason,
      timestamp: new Date().toISOString(),
    }));
  }

  rollbackPrompt(promptId: string, targetVersion: number): void {
    this.setCurrentPrompt(promptId, targetVersion, "exact-version rollback");
  }

  listReleaseHistory(): readonly PromptReleaseRecord[] {
    return Object.freeze([...this.#releaseHistory]);
  }

  listPrompts(): readonly PromptDefinition[] {
    const result: PromptDefinition[] = [];
    for (const versions of this.#prompts.values()) {
      for (const prompt of versions.values()) result.push(prompt);
    }
    result.sort(
      (left, right) => left.promptId.localeCompare(right.promptId) || left.promptVersion - right.promptVersion,
    );
    return Object.freeze(result);
  }

  listPromptVersions(promptId: string): readonly number[] {
    const versions = this.#prompts.get(promptId as PromptId);
    if (!versions) throw new ApplicationError("UNKNOWN_PROMPT", `Prompt '${promptId}' is not registered`);
    return Object.freeze([...versions.keys()].sort((left, right) => left - right));
  }

  hasPrompt(promptId: string, promptVersion?: number): boolean {
    const versions = this.#prompts.get(promptId as PromptId);
    return versions !== undefined &&
      (promptVersion === undefined || versions.has(promptVersion));
  }
}

export const PROMPT_REGISTRY = new PromptRegistry();

// Production selection is explicit and per-agent. Registration order or the
// highest available version never changes these pointers implicitly.
for (const [promptId, promptVersion] of [
  ["sites.site-planner", 2],
  ["sites.site-coder", 4],
  ["sites.build-repair", 2],
  ["sites.targeted-edit", 2],
] as const) PROMPT_REGISTRY.setCurrentPrompt(promptId, promptVersion);

export function getPrompt(promptId: string, promptVersion: number): PromptDefinition {
  return PROMPT_REGISTRY.getPrompt(promptId, promptVersion);
}

export function getCurrentPrompt(promptId: string): PromptDefinition {
  return PROMPT_REGISTRY.getCurrentPrompt(promptId);
}

export function listPrompts(): readonly PromptDefinition[] {
  return PROMPT_REGISTRY.listPrompts();
}
