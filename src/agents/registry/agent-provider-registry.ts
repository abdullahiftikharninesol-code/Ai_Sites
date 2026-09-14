import type { AgentProvider } from "../agent-provider.js";
import { ProviderRegistry } from "../../shared/provider-registry.js";
export class AgentProviderRegistry extends ProviderRegistry<AgentProvider> {
  constructor() {
    super("agent");
  }
}
