import { ApplicationError } from "../../app/errors/application-error.js";

export const SITE_CAPABILITY_IDS = [
  "core-web",
  "ui",
  "forms",
  "images",
  "motion-basic",
  "server-data",
  "client-state",
  "charts",
  "auth",
  "database",
  "motion-advanced",
  "animation-assets",
  "storage",
  "maps",
  "cms",
  "payments",
  "3d",
] as const;
export type SiteCapabilityId = (typeof SITE_CAPABILITY_IDS)[number];
export type SiteCapabilityPriority = "P0" | "P1" | "P2" | "P3";
export type SiteCapabilityStatus = "AVAILABLE" | "PLANNED" | "UNSUPPORTED";
export type SiteCapabilityImplementationKind =
  "PROFILE" | "SOURCE_REGISTRY" | "INTERNAL_RUNTIME" | "PACKAGE" | "FUTURE";

export interface SiteCapabilityDefinition {
  readonly id: SiteCapabilityId;
  readonly version: number;
  readonly priority: SiteCapabilityPriority;
  readonly status: SiteCapabilityStatus;
  readonly supportedProfiles: readonly string[];
  readonly requires: readonly SiteCapabilityId[];
  readonly conflictsWith: readonly SiteCapabilityId[];
  readonly supersedes: readonly SiteCapabilityId[];
  readonly implementationKind: SiteCapabilityImplementationKind;
}

export const SITE_CAPABILITY_REGISTRY_VERSION = "v1";

const profile = "react-vite-v1";
const definition = (
  id: SiteCapabilityId,
  priority: SiteCapabilityPriority,
  status: SiteCapabilityStatus,
  implementationKind: SiteCapabilityImplementationKind,
  requires: readonly SiteCapabilityId[] = [],
): SiteCapabilityDefinition => ({
  id,
  version: 1,
  priority,
  status,
  supportedProfiles: [profile],
  requires,
  conflictsWith: [],
  supersedes: [],
  implementationKind,
});

export const SITE_CAPABILITY_DEFINITIONS: readonly SiteCapabilityDefinition[] = [
  definition("core-web", "P0", "AVAILABLE", "PROFILE"),
  definition("ui", "P0", "AVAILABLE", "SOURCE_REGISTRY", ["core-web"]),
  definition("forms", "P0", "AVAILABLE", "INTERNAL_RUNTIME", ["core-web"]),
  definition("images", "P0", "AVAILABLE", "PROFILE", ["core-web"]),
  // Ordinary CSS motion is part of the generated source surface, not a
  // separately resolved capability. Retain the ID for historical registry
  // compatibility, but do not make it selectable for new projects.
  definition("motion-basic", "P1", "UNSUPPORTED", "SOURCE_REGISTRY", ["core-web"]),
  definition("server-data", "P1", "AVAILABLE", "INTERNAL_RUNTIME", ["core-web"]),
  definition("client-state", "P1", "PLANNED", "PACKAGE", ["core-web"]),
  definition("charts", "P1", "PLANNED", "PACKAGE", ["core-web"]),
  definition("auth", "P1", "AVAILABLE", "INTERNAL_RUNTIME", ["core-web"]),
  definition("database", "P1", "AVAILABLE", "INTERNAL_RUNTIME", ["core-web"]),
  definition("motion-advanced", "P2", "PLANNED", "PACKAGE", ["core-web"]),
  definition("animation-assets", "P2", "PLANNED", "FUTURE", ["core-web"]),
  definition("storage", "P2", "PLANNED", "FUTURE", ["core-web"]),
  definition("maps", "P2", "PLANNED", "FUTURE", ["core-web"]),
  definition("cms", "P2", "PLANNED", "INTERNAL_RUNTIME", ["core-web"]),
  definition("payments", "P3", "UNSUPPORTED", "FUTURE", ["core-web"]),
  definition("3d", "P3", "PLANNED", "FUTURE", ["core-web"]),
];

export class SiteCapabilityRegistry {
  readonly #items = new Map<string, SiteCapabilityDefinition>();
  readonly version: string;

  constructor(
    definitions: readonly SiteCapabilityDefinition[] = [],
    version = SITE_CAPABILITY_REGISTRY_VERSION,
  ) {
    this.version = version;
    for (const item of definitions) this.register(item);
  }

  register(definition: SiteCapabilityDefinition): void {
    const key = this.key(definition.id, definition.version);
    if (this.#items.has(key))
      throw new ApplicationError("VALIDATION_FAILED", `Capability '${key}' is already registered`);
    this.#items.set(key, definition);
  }

  getCapability(id: string, version?: number): SiteCapabilityDefinition {
    if (!SITE_CAPABILITY_IDS.includes(id as SiteCapabilityId))
      throw new ApplicationError("UNKNOWN_CAPABILITY", `Capability '${id}' is unknown`, {
        metadata: { capabilityId: id },
      });
    const candidates = [...this.#items.values()]
      .filter((item) => item.id === id)
      .sort((a, b) => b.version - a.version);
    const result =
      version === undefined ? candidates[0] : candidates.find((item) => item.version === version);
    if (!result)
      throw new ApplicationError(
        "UNSUPPORTED_CAPABILITY",
        `Capability '${id}${version === undefined ? "" : `@${version}`}' is not registered`,
        { metadata: { capabilityId: id, ...(version === undefined ? {} : { version }) } },
      );
    return result;
  }

  listCapabilities(): readonly SiteCapabilityDefinition[] {
    return [...this.#items.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || a.version - b.version,
    );
  }

  private key(id: SiteCapabilityId, version: number): string {
    return `${id}@${version}`;
  }
}

export const SITE_CAPABILITY_REGISTRY = new SiteCapabilityRegistry(SITE_CAPABILITY_DEFINITIONS);

export function getCapability(id: string, version?: number): SiteCapabilityDefinition {
  return SITE_CAPABILITY_REGISTRY.getCapability(id, version);
}
