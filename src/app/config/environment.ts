export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly defaultAgentProvider?: string;
  readonly defaultExecutionProvider?: string;
  readonly defaultHostingProvider?: string;
  readonly visualAgentProvider?: string;
  readonly visualAgentModel?: string;
  readonly maxAgentCallsPerRun?: number;
  readonly maxRepairAttempts?: number;
  readonly maxToolIterations?: number;
  readonly plannerModel?: string;
  readonly plannerProvider?: string;
  readonly generatorModel?: string;
  readonly generatorProvider?: string;
  readonly repairModel?: string;
  readonly repairProvider?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!(["development", "test", "production"] as const).includes(nodeEnv as never)) {
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  }
  const executionProvider = env.EXECUTION_PROVIDER ?? env.DEFAULT_EXECUTION_PROVIDER;
  const parseNum = (val: string | undefined): number | undefined => {
    if (!val) return undefined;
    const num = Number(val);
    return Number.isFinite(num) && num >= 0 ? num : undefined;
  };
  const maxAgentCalls = parseNum(env.SITES_MAX_AGENT_CALLS_PER_RUN);
  const maxRepairs = parseNum(env.SITES_MAX_REPAIR_ATTEMPTS);
  const maxTools = parseNum(env.SITES_MAX_TOOL_ITERATIONS);
  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    ...(env.DEFAULT_AGENT_PROVIDER ? { defaultAgentProvider: env.DEFAULT_AGENT_PROVIDER } : {}),
    ...(executionProvider ? { defaultExecutionProvider: executionProvider } : {}),
    ...(env.DEFAULT_HOSTING_PROVIDER
      ? { defaultHostingProvider: env.DEFAULT_HOSTING_PROVIDER }
      : {}),
    ...(env.SITES_VISUAL_AGENT_PROVIDER
      ? { visualAgentProvider: env.SITES_VISUAL_AGENT_PROVIDER }
      : {}),
    ...(env.SITES_VISUAL_AGENT_MODEL ? { visualAgentModel: env.SITES_VISUAL_AGENT_MODEL } : {}),
    ...(maxAgentCalls !== undefined ? { maxAgentCallsPerRun: maxAgentCalls } : {}),
    ...(maxRepairs !== undefined ? { maxRepairAttempts: maxRepairs } : {}),
    ...(maxTools !== undefined ? { maxToolIterations: maxTools } : {}),
    ...(env.SITES_PLANNER_MODEL ? { plannerModel: env.SITES_PLANNER_MODEL.trim() } : {}),
    ...(env.SITES_PLANNER_PROVIDER ? { plannerProvider: env.SITES_PLANNER_PROVIDER.trim() } : {}),
    ...(env.SITES_GENERATOR_MODEL ? { generatorModel: env.SITES_GENERATOR_MODEL.trim() } : {}),
    ...(env.SITES_GENERATOR_PROVIDER ? { generatorProvider: env.SITES_GENERATOR_PROVIDER.trim() } : {}),
    ...(env.SITES_REPAIR_MODEL ? { repairModel: env.SITES_REPAIR_MODEL.trim() } : {}),
    ...(env.SITES_REPAIR_PROVIDER ? { repairProvider: env.SITES_REPAIR_PROVIDER.trim() } : {}),
  };
}
