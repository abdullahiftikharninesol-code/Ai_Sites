import type { AppConfig } from "../../app/config/environment.js";
import { LocalExecutionProvider } from "../local/local-execution.provider.js";
import { loadLocalExecutionConfig } from "../local/local-execution.config.js";
import { MockExecutionProvider } from "../mock-execution-provider.js";
import { DaytonaExecutionProvider } from "../daytona/daytona-execution.provider.js";
import { loadDaytonaConfig } from "../daytona/daytona-config.js";
import { ExecutionProviderRegistry } from "./execution-provider-registry.js";
export function createExecutionProviderRegistry(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionProviderRegistry {
  const registry = new ExecutionProviderRegistry();
  registry.register(new MockExecutionProvider());
  if (config.defaultExecutionProvider === "local")
    registry.register(new LocalExecutionProvider(loadLocalExecutionConfig(env)));
  if (config.defaultExecutionProvider === "daytona")
    registry.register(new DaytonaExecutionProvider(loadDaytonaConfig(env)));
  if (config.defaultExecutionProvider)
    registry.get(
      config.defaultExecutionProvider === "mock"
        ? "mock-execution"
        : config.defaultExecutionProvider,
    );
  return registry;
}
