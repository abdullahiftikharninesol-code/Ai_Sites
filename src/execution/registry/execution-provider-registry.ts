import type { ExecutionProvider } from "../execution-provider.js";
import { ProviderRegistry } from "../../shared/provider-registry.js";
export class ExecutionProviderRegistry extends ProviderRegistry<ExecutionProvider> {
  constructor() {
    super("execution");
  }
}
