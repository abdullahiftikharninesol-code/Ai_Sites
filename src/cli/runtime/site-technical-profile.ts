import { ApplicationError } from "../../app/errors/application-error.js";

export interface LogicalCommand {
  readonly executable: "npm";
  readonly args: readonly string[];
}

export interface GeneratedAppProfile {
  readonly id: string;
  readonly version: number;
  readonly framework: "react";
  readonly bundler: "vite";
  readonly language: "typescript";
  readonly packageManager: { readonly name: "npm" };
  readonly styling: "plain-css";
  readonly supportsRouting: boolean;
  readonly supportsResponsiveDesign: boolean;
  readonly commands: {
    readonly install: LogicalCommand;
    readonly build: LogicalCommand;
    readonly preview: LogicalCommand;
  };
  readonly files: {
    readonly managed: readonly string[];
    readonly editable: readonly string[];
  };
  readonly starterTemplateId: string;
}

/** @deprecated Use GeneratedAppProfile. Kept as a source-compatible name for existing callers. */
export type SiteTechnicalProfile = GeneratedAppProfile;

export const SITE_V1_TECHNICAL_PROFILE: GeneratedAppProfile = {
  id: "react-vite-v1",
  version: 1,
  framework: "react",
  bundler: "vite",
  language: "typescript",
  packageManager: { name: "npm" },
  styling: "plain-css",
  supportsRouting: true,
  supportsResponsiveDesign: true,
  commands: {
    install: {
      executable: "npm",
      args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
    },
    build: { executable: "npm", args: ["run", "build"] },
    preview: { executable: "npm", args: ["run", "dev"] },
  },
  files: {
    managed: [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "src/main.tsx",
      "src/vite-env.d.ts",
    ],
    editable: ["src/App.tsx", "src/styles.css"],
  },
  starterTemplateId: "react-vite-v1",
};

export class GeneratedAppProfileRegistry {
  readonly #profiles = new Map<string, GeneratedAppProfile>();

  constructor(profiles: readonly GeneratedAppProfile[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  register(profile: GeneratedAppProfile): void {
    if (this.#profiles.has(profile.id))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Generated app profile '${profile.id}' is already registered`,
      );
    this.#profiles.set(profile.id, profile);
  }

  getProfile(id: string): GeneratedAppProfile {
    const profile = this.#profiles.get(id);
    if (!profile)
      throw new ApplicationError(
        "UNSUPPORTED_SITE_REQUIREMENT",
        `Generated app profile '${id}' is not registered`,
      );
    return profile;
  }

  getDefaultProfile(): GeneratedAppProfile {
    return this.getProfile(SITE_V1_TECHNICAL_PROFILE.id);
  }
}

export const GENERATED_APP_PROFILE_REGISTRY = new GeneratedAppProfileRegistry([
  SITE_V1_TECHNICAL_PROFILE,
]);

export function getProfile(id: string): GeneratedAppProfile {
  return GENERATED_APP_PROFILE_REGISTRY.getProfile(id);
}

export function getDefaultProfile(): GeneratedAppProfile {
  return GENERATED_APP_PROFILE_REGISTRY.getDefaultProfile();
}

export const REACT_VITE_TYPESCRIPT_PROFILE = SITE_V1_TECHNICAL_PROFILE;
