import { ApplicationError } from "../../app/errors/application-error.js";
import type { InferenceStage } from "../budget/agent-run-budget.js";
import { isApprovedAgentTool } from "../tool-catalog.js";
import type { AgentToolName } from "../agent-types.js";

/** Stable identities for the core Sites agents. Versions belong to contracts, not IDs. */
export type AgentId =
  | "sites.site-planner"
  | "sites.site-coder"
  | "sites.build-repair"
  | "sites.motion-repair"
  | "sites.edit-planner"
  | "sites.targeted-edit"
  | "sites.asset-planner"
  | "sites.visual-review"
  | "sites.visual-repair";

export type AgentContractStage = InferenceStage | "ASSET_PLANNING";
export type AgentToolId = AgentToolName;
export type AgentContractStatus = "ACTIVE" | "DORMANT" | "FUTURE";

export type AgentInputKind =
  | "USER_REQUEST"
  | "PLATFORM_CONSTRAINTS"
  | "SITE_SPEC"
  | "PROFILE"
  | "RESOLVED_CAPABILITIES"
  | "DEPENDENCY_MANIFEST"
  | "UI_REGISTRY_CONTEXT"
  | "BUILD_DIAGNOSTICS"
  | "RELEVANT_SOURCE"
  | "EDIT_REQUEST"
  | "CURRENT_PROJECT_CONTEXT"
  | "SITE_EDIT_PLAN"
  | "SCREENSHOTS"
  | "DESIGN_CONTEXT"
  | "DESIGN_DIRECTION"
  | "EXISTING_ASSETS"
  | "VISUAL_ISSUES"
  | "MOTION_VIOLATION_DIAGNOSTICS";

export type AgentOutputKind =
  | "SITE_PLAN"
  | "GENERATED_SOURCE"
  | "SOURCE_PATCH"
  | "SITE_EDIT_PLAN"
  | "ASSET_INTENT_LIST"
  | "VISUAL_REVIEW";

export interface AgentInputContractMetadata {
  readonly required: readonly AgentInputKind[];
  readonly optional?: readonly AgentInputKind[];
}

export interface AgentOutputContractMetadata {
  readonly kind: AgentOutputKind;
}

export interface AgentPermissionPolicy {
  readonly mayReadSource: boolean;
  readonly mayWriteSource: boolean;
  readonly mayPatchSource: boolean;
  readonly mayModifyManagedFiles: boolean;
  readonly maySelectDependencies: boolean;
  readonly mayInstallDependencies: boolean;
  readonly mayInvokeShell: boolean;
  readonly mayAccessSecrets: boolean;
  readonly mayChangeArchitecture: boolean;
  readonly mayCreateAssets: boolean;
  readonly mayReviewScreenshots: boolean;
}

export type AgentForbiddenAction =
  | "WRITE_SOURCE"
  | "MODIFY_PROJECT"
  | "MODIFY_MANAGED_FILES"
  | "INSTALL_DEPENDENCIES"
  | "SELECT_DEPENDENCIES"
  | "SELECT_PACKAGE_VERSIONS"
  | "ACCESS_SECRETS"
  | "WRITE_OUTSIDE_WORKSPACE"
  | "ARBITRARY_SHELL"
  | "REDESIGN_DURING_BUILD_REPAIR"
  | "MODIFY_UNRELATED_SCOPE"
  | "ACTIVATE_UNSUPPORTED_BACKEND"
  | "BYPASS_DEPENDENCY_POLICY"
  | "CREATE_ASSETS"
  | "REVIEW_SCREENSHOTS";

export type AgentResponseContractKind = "TEXT" | "JSON_SCHEMA" | "TOOL_LOOP";

export interface AgentResponseContractReference {
  readonly id: string;
  readonly kind: AgentResponseContractKind;
  /** Identity only. The JSON schema remains owned by the existing response validators. */
  readonly schemaId?: string;
}

export interface AgentPolicyReference {
  readonly id: string;
  readonly version?: number;
}

export type AgentStopCondition =
  | "VALID_STRUCTURED_OUTPUT"
  | "VALID_FINALIZE_GENERATION"
  | "BUILD_PASSES"
  | "REPAIR_LIMIT_REACHED"
  | "VALID_EDIT_PLAN"
  | "REQUESTED_EDIT_APPLIED"
  | "VALID_VISUAL_REVIEW"
  | "VISUAL_REPAIR_APPLIED"
  | "MOTION_REPAIR_APPLIED";

/** Numeric limits are optional because run-scoped budgets remain authoritative. */
export interface AgentExecutionLimits {
  readonly authority: "INFERENCE_RUN_BUDGET" | "AGENT_LOOP_RUNTIME";
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxRepairAttempts?: number;
}

export interface AgentContract {
  readonly agentId: AgentId;
  readonly contractVersion: number;
  readonly stage: AgentContractStage;
  readonly purpose: string;
  readonly inputContract: AgentInputContractMetadata;
  readonly outputContract: AgentOutputContractMetadata;
  readonly tools: readonly AgentToolId[];
  readonly permissions: AgentPermissionPolicy;
  readonly forbiddenActions: readonly AgentForbiddenAction[];
  readonly responseContract: AgentResponseContractReference;
  readonly reasoningPolicy: AgentPolicyReference;
  readonly contextPolicy: AgentPolicyReference;
  readonly stopConditions: readonly AgentStopCondition[];
  readonly limits: AgentExecutionLimits;
  readonly prompt: {
    readonly promptId: string;
    readonly promptVersion?: number;
  };
  readonly lifecycle: {
    readonly status: AgentContractStatus;
  };
}

const AGENT_IDS: readonly AgentId[] = [
  "sites.site-planner",
  "sites.site-coder",
  "sites.build-repair",
  "sites.targeted-edit",
];

const AGENT_STAGES: readonly AgentContractStage[] = [
  "SITE_PLANNING",
  "GENERATE_SITE",
  "BUILD_REPAIR",
  "TARGETED_EDIT",
];

const CONTRACT_STATUSES: readonly AgentContractStatus[] = ["ACTIVE", "DORMANT", "FUTURE"];
const RESPONSE_KINDS: readonly AgentResponseContractKind[] = ["TEXT", "JSON_SCHEMA", "TOOL_LOOP"];

function hasValue<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", `${field} must not be empty`);
  }
}

function assertPositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", `${field} must be a positive integer`);
  }
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", `${field} must not contain duplicates`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateAgentContract(contract: AgentContract): void {
  if (!contract || typeof contract !== "object") {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", "Agent contract must be an object");
  }
  if (!hasValue(AGENT_IDS, contract.agentId)) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", `Unknown agent ID '${contract.agentId}'`);
  }
  assertPositiveInteger(contract.contractVersion, "contractVersion");
  if (!hasValue(AGENT_STAGES, contract.stage)) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", `Unknown agent stage '${contract.stage}'`);
  }
  assertNonEmpty(contract.purpose, "purpose");
  assertUnique(contract.tools, "tools");
  for (const tool of contract.tools) {
    if (!isApprovedAgentTool(tool)) {
      throw new ApplicationError("INVALID_AGENT_CONTRACT", `Unknown agent tool '${tool}'`);
    }
  }
  assertUnique(contract.inputContract.required, "inputContract.required");
  assertUnique(contract.inputContract.optional ?? [], "inputContract.optional");
  assertUnique(contract.forbiddenActions, "forbiddenActions");
  assertUnique(contract.stopConditions, "stopConditions");
  if (!hasValue(CONTRACT_STATUSES, contract.lifecycle.status)) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", "Invalid lifecycle status");
  }
  assertNonEmpty(contract.responseContract.id, "responseContract.id");
  if (!hasValue(RESPONSE_KINDS, contract.responseContract.kind)) {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", "Invalid response contract kind");
  }
  if (contract.responseContract.kind === "JSON_SCHEMA") {
    assertNonEmpty(contract.responseContract.schemaId ?? "", "responseContract.schemaId");
  }
  assertNonEmpty(contract.reasoningPolicy.id, "reasoningPolicy.id");
  assertNonEmpty(contract.contextPolicy.id, "contextPolicy.id");
  assertPositiveInteger(contract.reasoningPolicy.version, "reasoningPolicy.version");
  assertPositiveInteger(contract.contextPolicy.version, "contextPolicy.version");
  assertNonEmpty(contract.prompt.promptId, "prompt.promptId");
  assertPositiveInteger(contract.prompt.promptVersion, "prompt.promptVersion");
  if (contract.limits.authority !== "INFERENCE_RUN_BUDGET" && contract.limits.authority !== "AGENT_LOOP_RUNTIME") {
    throw new ApplicationError("INVALID_AGENT_CONTRACT", "Invalid execution-limit authority");
  }
  assertPositiveInteger(contract.limits.maxModelTurns, "limits.maxModelTurns");
  assertPositiveInteger(contract.limits.maxToolCalls, "limits.maxToolCalls");
  assertPositiveInteger(contract.limits.maxRepairAttempts, "limits.maxRepairAttempts");
}

const plannerPermissions: AgentPermissionPolicy = {
  mayReadSource: false,
  mayWriteSource: false,
  mayPatchSource: false,
  mayModifyManagedFiles: false,
  maySelectDependencies: false,
  mayInstallDependencies: false,
  mayInvokeShell: false,
  mayAccessSecrets: false,
  mayChangeArchitecture: false,
  mayCreateAssets: false,
  mayReviewScreenshots: false,
};

const sourceEditorPermissions: AgentPermissionPolicy = {
  ...plannerPermissions,
  mayReadSource: true,
  mayWriteSource: true,
  mayPatchSource: true,
};

const commonSourceForbidden: readonly AgentForbiddenAction[] = [
  "MODIFY_MANAGED_FILES",
  "INSTALL_DEPENDENCIES",
  "SELECT_DEPENDENCIES",
  "SELECT_PACKAGE_VERSIONS",
  "ACCESS_SECRETS",
  "WRITE_OUTSIDE_WORKSPACE",
  "ARBITRARY_SHELL",
  "BYPASS_DEPENDENCY_POLICY",
];

const plannerForbidden: readonly AgentForbiddenAction[] = [
  "WRITE_SOURCE",
  "MODIFY_PROJECT",
  "SELECT_DEPENDENCIES",
  "SELECT_PACKAGE_VERSIONS",
  "ACCESS_SECRETS",
  "WRITE_OUTSIDE_WORKSPACE",
  "ARBITRARY_SHELL",
];

function contract(params: Omit<AgentContract, "contractVersion">): AgentContract {
  return deepFreeze({ ...params, contractVersion: 1 });
}

export const CORE_AGENT_CONTRACTS: readonly AgentContract[] = deepFreeze([
  contract({
    agentId: "sites.site-planner",
    stage: "SITE_PLANNING",
    purpose: "Convert a user request into a validated structured SitePlan.",
    inputContract: { required: ["USER_REQUEST", "PLATFORM_CONSTRAINTS"] },
    outputContract: { kind: "SITE_PLAN" },
    tools: [],
    permissions: plannerPermissions,
    forbiddenActions: plannerForbidden,
    responseContract: { id: "site-plan", kind: "JSON_SCHEMA", schemaId: "SitePlan" },
    reasoningPolicy: { id: "SITE_PLANNING_DEFAULT" },
    contextPolicy: { id: "SITE_PLANNING_CONTEXT" },
    stopConditions: ["VALID_STRUCTURED_OUTPUT"],
    limits: { authority: "INFERENCE_RUN_BUDGET" },
    prompt: { promptId: "sites.site-planner", promptVersion: 2 },
    lifecycle: { status: "ACTIVE" },
  }),
  contract({
    agentId: "sites.site-coder",
    stage: "GENERATE_SITE",
    purpose: "Implement an approved SiteSpec using approved production context.",
    inputContract: {
      required: ["USER_REQUEST", "SITE_SPEC", "PROFILE", "RESOLVED_CAPABILITIES", "DEPENDENCY_MANIFEST", "UI_REGISTRY_CONTEXT"],
    },
    outputContract: { kind: "GENERATED_SOURCE" },
    tools: [],
    permissions: sourceEditorPermissions,
    forbiddenActions: commonSourceForbidden,
    responseContract: { id: "site-coder-file-bundle", kind: "JSON_SCHEMA", schemaId: "SiteCoderFileBundle" },
    reasoningPolicy: { id: "GENERATE_SITE_DEFAULT" },
    contextPolicy: { id: "GENERATE_SITE_CONTEXT" },
    stopConditions: ["VALID_STRUCTURED_OUTPUT"],
    limits: { authority: "INFERENCE_RUN_BUDGET" },
    prompt: { promptId: "sites.site-coder", promptVersion: 4 },
    lifecycle: { status: "ACTIVE" },
  }),
  contract({
    agentId: "sites.build-repair",
    stage: "BUILD_REPAIR",
    purpose: "Make the smallest source repair required to restore build success.",
    inputContract: { required: ["BUILD_DIAGNOSTICS", "RELEVANT_SOURCE"] },
    outputContract: { kind: "SOURCE_PATCH" },
    tools: [],
    permissions: sourceEditorPermissions,
    forbiddenActions: [...commonSourceForbidden, "REDESIGN_DURING_BUILD_REPAIR"],
    responseContract: { id: "build-repair-patch-bundle", kind: "JSON_SCHEMA", schemaId: "BuildRepairPatchBundle" },
    reasoningPolicy: { id: "BUILD_REPAIR_DEFAULT" },
    contextPolicy: { id: "BUILD_REPAIR_CONTEXT" },
    stopConditions: ["BUILD_PASSES", "REPAIR_LIMIT_REACHED"],
    limits: { authority: "INFERENCE_RUN_BUDGET", maxRepairAttempts: 1 },
    prompt: { promptId: "sites.build-repair", promptVersion: 2 },
    lifecycle: { status: "ACTIVE" },
  }),
  contract({
    agentId: "sites.targeted-edit",
    stage: "TARGETED_EDIT",
    purpose: "Implement a validated edit plan with a minimal diff.",
    inputContract: { required: ["EDIT_REQUEST", "RELEVANT_SOURCE"] },
    outputContract: { kind: "SOURCE_PATCH" },
    tools: [],
    permissions: sourceEditorPermissions,
    forbiddenActions: [...commonSourceForbidden, "MODIFY_UNRELATED_SCOPE"],
    responseContract: { id: "site-edit-patch-bundle", kind: "JSON_SCHEMA", schemaId: "SiteEditPatchBundle" },
    reasoningPolicy: { id: "TARGETED_EDIT_DEFAULT" },
    contextPolicy: { id: "TARGETED_EDIT_CONTEXT" },
    stopConditions: ["VALID_STRUCTURED_OUTPUT"],
    limits: { authority: "INFERENCE_RUN_BUDGET" },
    prompt: { promptId: "sites.targeted-edit", promptVersion: 2 },
    lifecycle: { status: "ACTIVE" },
  }),
] as const);

export class AgentContractRegistry {
  readonly #contracts = new Map<AgentId, Map<number, AgentContract>>();

  constructor(contracts: readonly AgentContract[] = CORE_AGENT_CONTRACTS) {
    for (const item of contracts) this.register(item);
  }

  register(contractDefinition: AgentContract): void {
    validateAgentContract(contractDefinition);
    const registered = deepFreeze(contractDefinition);
    let versions = this.#contracts.get(registered.agentId);
    if (!versions) {
      versions = new Map<number, AgentContract>();
      this.#contracts.set(registered.agentId, versions);
    }
    if (versions.has(registered.contractVersion)) {
      throw new ApplicationError(
        "DUPLICATE_AGENT_CONTRACT",
        `Agent contract '${registered.agentId}' version ${registered.contractVersion} is already registered`,
      );
    }
    versions.set(registered.contractVersion, registered);
  }

  getAgentContract(agentId: string, contractVersion: number): AgentContract {
    const versions = this.#contracts.get(agentId as AgentId);
    if (!versions) {
      throw new ApplicationError("UNKNOWN_AGENT_CONTRACT", `Agent contract '${agentId}' is not registered`);
    }
    const result = versions.get(contractVersion);
    if (!result) {
      throw new ApplicationError(
        "UNKNOWN_AGENT_CONTRACT_VERSION",
        `Agent contract '${agentId}' version ${contractVersion} is not registered`,
      );
    }
    return result;
  }

  getCurrentAgentContract(agentId: string): AgentContract {
    const versions = this.#contracts.get(agentId as AgentId);
    if (!versions) {
      throw new ApplicationError("UNKNOWN_AGENT_CONTRACT", `Agent contract '${agentId}' is not registered`);
    }
    const current = [...versions.values()].filter((item) => item.lifecycle.status === "ACTIVE");
    if (current.length === 0)
      throw new ApplicationError("UNKNOWN_AGENT_CONTRACT", `Agent '${agentId}' has no executable current contract`);
    return current.sort((left, right) => right.contractVersion - left.contractVersion)[0]!;
  }

  listAgentContracts(): readonly AgentContract[] {
    const result: AgentContract[] = [];
    for (const versions of this.#contracts.values()) {
      for (const item of versions.values()) result.push(item);
    }
    result.sort((left, right) => left.agentId.localeCompare(right.agentId) || left.contractVersion - right.contractVersion);
    return Object.freeze(result);
  }
}

export const AGENT_CONTRACT_REGISTRY = new AgentContractRegistry();

export function getAgentContract(agentId: string, contractVersion: number): AgentContract {
  return AGENT_CONTRACT_REGISTRY.getAgentContract(agentId, contractVersion);
}

export function getCurrentAgentContract(agentId: string): AgentContract {
  return AGENT_CONTRACT_REGISTRY.getCurrentAgentContract(agentId);
}

export function listAgentContracts(): readonly AgentContract[] {
  return AGENT_CONTRACT_REGISTRY.listAgentContracts();
}
