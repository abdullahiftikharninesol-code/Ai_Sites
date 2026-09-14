import { ApplicationError } from "../../app/errors/application-error.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import { bootstrapLocalProject } from "../../cli/runtime/bootstrap-local-project.js";
import {
  GENERATED_APP_PROFILE_REGISTRY,
  type GeneratedAppProfile,
  type GeneratedAppProfileRegistry,
} from "../../cli/runtime/site-technical-profile.js";
export interface StarterTemplate {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly sourceDirectory: string;
}
export class StarterTemplateRegistry {
  readonly #items = new Map<string, StarterTemplate>();
  constructor(
    private readonly profiles: GeneratedAppProfileRegistry = GENERATED_APP_PROFILE_REGISTRY,
  ) {}
  register(template: StarterTemplate): void {
    this.resolveProfile(template);
    const key = this.key(template.templateId, template.templateVersion);
    if (this.#items.has(key))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Starter template '${key}' is already registered`,
      );
    this.#items.set(key, template);
  }
  get(templateId: string, version?: number): StarterTemplate {
    const candidates = [...this.#items.values()]
      .filter((item) => item.templateId === templateId)
      .sort((a, b) => b.templateVersion - a.templateVersion);
    const result =
      version === undefined
        ? candidates[0]
        : candidates.find((item) => item.templateVersion === version);
    if (!result)
      throw new ApplicationError(
        "PROJECT_BOOTSTRAP_FAILED",
        `Starter template '${templateId}${version === undefined ? "" : `@${version}`}' is not registered`,
      );
    return result;
  }
  key(id: string, version: number): string {
    return `${id}@${version}`;
  }
  resolveProfile(template: StarterTemplate): GeneratedAppProfile {
    const profile = this.profiles.getProfile(template.profileId);
    if (profile.version !== template.profileVersion)
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Starter template '${this.key(template.templateId, template.templateVersion)}' requires profile '${template.profileId}@${template.profileVersion}', but the registered profile is version ${profile.version}`,
      );
    return profile;
  }
  async seed(
    execution: LocalExecutionProvider,
    environmentId: string,
    template: StarterTemplate,
  ): Promise<number> {
    try {
      return await bootstrapLocalProject(execution, environmentId, template.sourceDirectory);
    } catch (cause) {
      throw new ApplicationError("PROJECT_BOOTSTRAP_FAILED", "Starter project bootstrap failed", {
        cause,
      });
    }
  }
}
