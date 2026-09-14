import { ApplicationError } from "../../app/errors/application-error.js";

export const WORKFLOW_STATES = [
  "QUEUED",
  "PLANNING",
  "DESIGNING",
  "CREATING_ENVIRONMENT",
  "GENERATING",
  "BUILDING",
  "PREVIEW_READY",
  "QA_RUNNING",
  "WAITING_FOR_USER",
  "SAVING",
  "DEPLOYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const terminal = new Set<WorkflowState>(["COMPLETED", "FAILED", "CANCELLED"]);
const transitions: Readonly<Partial<Record<WorkflowState, readonly WorkflowState[]>>> = {
  QUEUED: ["PLANNING", "CANCELLED"],
  PLANNING: ["DESIGNING", "FAILED", "CANCELLED"],
  DESIGNING: ["CREATING_ENVIRONMENT", "FAILED", "CANCELLED"],
  CREATING_ENVIRONMENT: ["GENERATING", "FAILED", "CANCELLED"],
  GENERATING: ["BUILDING", "FAILED", "CANCELLED"],
  BUILDING: ["PREVIEW_READY", "GENERATING", "FAILED", "CANCELLED"],
  PREVIEW_READY: ["QA_RUNNING", "WAITING_FOR_USER", "SAVING", "FAILED", "CANCELLED"],
  QA_RUNNING: ["GENERATING", "WAITING_FOR_USER", "FAILED", "CANCELLED"],
  WAITING_FOR_USER: ["GENERATING", "SAVING", "CANCELLED"],
  SAVING: ["DEPLOYING", "COMPLETED", "FAILED", "CANCELLED"],
  DEPLOYING: ["COMPLETED", "FAILED"],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return !terminal.has(from) && (transitions[from]?.includes(to) ?? false);
}
export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to))
    throw new ApplicationError(
      "INVALID_STATE_TRANSITION",
      `Cannot transition from ${from} to ${to}`,
      { metadata: { from, to } },
    );
}
