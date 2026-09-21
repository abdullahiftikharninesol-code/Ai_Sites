/**
 * The invariant EDIT_PLANNING instruction extracted from the existing
 * intelligence request helper. The historical TARGETED_EDIT task label is
 * retained byte-for-byte for provider/mock compatibility; the AgentContract
 * and inference scope remain EDIT_PLANNING.
 */
export const SITES_EDIT_PLANNER_PROMPT = `SITES_AGENT_TASK:TARGETED_EDIT
Return only the requested compact JSON. Never include secrets, credentials, hidden reasoning, source code, or unsupported capabilities.`;
