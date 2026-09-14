export type AgentPurpose =
  | "site_planning"
  | "code_generation"
  | "build_repair"
  | "targeted_edit";

export interface RoutedModel {
  readonly provider: string;
  readonly model?: string;
  readonly tier?: "economy" | "standard" | "premium";
}

export interface ModelRoutingConfig {
  readonly defaultProvider?: string;
  readonly plannerModel?: string;
  readonly plannerProvider?: string;
  readonly generatorModel?: string;
  readonly generatorProvider?: string;
  readonly repairModel?: string;
  readonly repairProvider?: string;
  readonly editModel?: string;
  readonly editProvider?: string;
}

export class AgentModelRouter {
  constructor(private readonly config: ModelRoutingConfig = {}) {}

  route(purpose: AgentPurpose, fallbackProvider?: string): RoutedModel {
    const baseProvider = fallbackProvider ?? this.config.defaultProvider ?? "mock";
    switch (purpose) {
      case "site_planning":
        return {
          provider: this.config.plannerProvider ?? baseProvider,
          ...(this.config.plannerModel ? { model: this.config.plannerModel } : {}),
          tier: "economy",
        };
      case "code_generation":
        return {
          provider: this.config.generatorProvider ?? baseProvider,
          ...(this.config.generatorModel ? { model: this.config.generatorModel } : {}),
          tier: "standard",
        };
      case "build_repair":
        return {
          provider: this.config.repairProvider ?? baseProvider,
          ...(this.config.repairModel ? { model: this.config.repairModel } : {}),
          tier: "economy",
        };
      case "targeted_edit":
        return {
          provider: this.config.editProvider ?? baseProvider,
          ...(this.config.editModel ? { model: this.config.editModel } : {}),
          tier: "standard",
        };
      default:
        return { provider: baseProvider, tier: "standard" };
    }
  }
}
