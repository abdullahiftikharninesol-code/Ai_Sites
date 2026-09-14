export type AgentRuntimeMode = "REMOTE_TOOL_LOOP" | "LOCAL_CLI" | "SANDBOX_CLI";
export interface AgentRuntimeSelection {
  readonly mode: AgentRuntimeMode;
  readonly implemented: boolean;
}
export const AGENT_RUNTIMES: readonly AgentRuntimeSelection[] = [
  { mode: "REMOTE_TOOL_LOOP", implemented: true },
  { mode: "LOCAL_CLI", implemented: true },
  { mode: "SANDBOX_CLI", implemented: true },
];
