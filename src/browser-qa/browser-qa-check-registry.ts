import { ApplicationError } from "../app/errors/application-error.js";
import {
  BROWSER_QA_CATEGORIES,
  BROWSER_QA_SEVERITIES,
  type BrowserQACategory,
  type BrowserQASeverity,
} from "./browser-qa-domain.js";

export interface BrowserQACheckApplicabilityContext {
  readonly capabilities: ReadonlySet<string>;
  readonly hasRoutes: boolean;
  readonly hasAssets: boolean;
  readonly hasMotion: boolean;
  readonly hasForms: boolean;
}

export type BrowserQACheckScope = "PAGE" | "ROUTE" | "VIEWPORT" | "INTERACTION";

export interface BrowserQACheckDefinition {
  readonly checkId: string;
  readonly version: number;
  readonly category: BrowserQACategory;
  readonly defaultSeverity: BrowserQASeverity;
  readonly scope: BrowserQACheckScope;
  readonly timeoutMs: number;
  readonly applicability?: (context: BrowserQACheckApplicabilityContext) => boolean;
}

export class BrowserQACheckRegistry {
  readonly #definitions = new Map<string, BrowserQACheckDefinition>();
  constructor(definitions: readonly BrowserQACheckDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }
  register(definition: BrowserQACheckDefinition): void {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(definition.checkId))
      throw new ApplicationError("VALIDATION_FAILED", `Invalid Browser QA check ID '${definition.checkId}'`);
    if (!Number.isInteger(definition.version) || definition.version < 1)
      throw new ApplicationError("VALIDATION_FAILED", `Invalid Browser QA check version for '${definition.checkId}'`);
    if (!BROWSER_QA_CATEGORIES.includes(definition.category))
      throw new ApplicationError("VALIDATION_FAILED", `Invalid Browser QA category for '${definition.checkId}'`);
    if (!BROWSER_QA_SEVERITIES.includes(definition.defaultSeverity))
      throw new ApplicationError("VALIDATION_FAILED", `Invalid Browser QA severity for '${definition.checkId}'`);
    if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0)
      throw new ApplicationError("VALIDATION_FAILED", `Invalid Browser QA timeout for '${definition.checkId}'`);
    const key = `${definition.checkId}@${definition.version}`;
    if (this.#definitions.has(key))
      throw new ApplicationError("VALIDATION_FAILED", `Browser QA check '${key}' is already registered`);
    this.#definitions.set(key, Object.freeze({ ...definition }));
  }
  get(checkId: string, version?: number): BrowserQACheckDefinition {
    const candidates = [...this.#definitions.values()]
      .filter((definition) => definition.checkId === checkId)
      .sort((a, b) => b.version - a.version);
    const result = version === undefined ? candidates[0] : candidates.find((item) => item.version === version);
    if (!result) throw new ApplicationError("VALIDATION_FAILED", `Browser QA check '${checkId}' is not registered`);
    return result;
  }
  list(): readonly BrowserQACheckDefinition[] {
    return Object.freeze([...this.#definitions.values()].sort((a, b) => a.checkId.localeCompare(b.checkId) || a.version - b.version));
  }
  applicable(context: BrowserQACheckApplicabilityContext): readonly BrowserQACheckDefinition[] {
    return this.list().filter((definition) => definition.applicability?.(context) ?? true);
  }
}

export const BROWSER_QA_CHECK_DEFINITIONS: readonly BrowserQACheckDefinition[] = [
  { checkId: "page-readiness", version: 1, category: "RUNTIME", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 5_000 },
  { checkId: "runtime.page-error", version: 1, category: "RUNTIME", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 1_000 },
  { checkId: "runtime.console-error", version: 1, category: "CONSOLE", defaultSeverity: "WARNING", scope: "PAGE", timeoutMs: 1_000 },
  { checkId: "network.failed-request", version: 1, category: "NETWORK", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 1_000 },
  { checkId: "route.load", version: 1, category: "ROUTING", defaultSeverity: "ERROR", scope: "ROUTE", timeoutMs: 5_000, applicability: ({ hasRoutes }) => hasRoutes },
  // ERROR blocks the version; WARNING is reported on the version instead.
  // Only "the site does not work" and safety boundaries block.
  { checkId: "internal-links", version: 1, category: "ROUTING", defaultSeverity: "WARNING", scope: "PAGE", timeoutMs: 3_000 },
  { checkId: "broken-images", version: 1, category: "ASSET", defaultSeverity: "WARNING", scope: "VIEWPORT", timeoutMs: 3_000, applicability: ({ hasAssets }) => hasAssets },
  { checkId: "responsive-overflow", version: 1, category: "RESPONSIVE", defaultSeverity: "WARNING", scope: "VIEWPORT", timeoutMs: 2_000 },
  { checkId: "interaction-smoke", version: 1, category: "INTERACTION", defaultSeverity: "WARNING", scope: "INTERACTION", timeoutMs: 3_000 },
  { checkId: "form-smoke", version: 1, category: "FORM", defaultSeverity: "WARNING", scope: "INTERACTION", timeoutMs: 3_000, applicability: ({ hasForms }) => hasForms },
  { checkId: "accessibility-smoke", version: 1, category: "ACCESSIBILITY", defaultSeverity: "WARNING", scope: "PAGE", timeoutMs: 3_000 },
];

export const BROWSER_QA_CHECK_REGISTRY = new BrowserQACheckRegistry(BROWSER_QA_CHECK_DEFINITIONS);
