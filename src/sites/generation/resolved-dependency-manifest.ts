import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { GeneratedAppProfile } from "../../cli/runtime/site-technical-profile.js";
import type { ResolvedCapabilities } from "./capability-resolver.js";

export type ExactVersion = `${number}.${number}.${number}`;

export interface ResolvedDependencyManifest {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly capabilityRegistryVersion: string;
  readonly capabilities: readonly { readonly id: string; readonly version: number }[];
  readonly dependencies: Readonly<Record<string, ExactVersion>>;
  readonly devDependencies: Readonly<Record<string, ExactVersion>>;
  readonly scripts: Readonly<Record<string, string>>;
  readonly packageManager: { readonly name: "npm"; readonly expectedVersion?: string };
  readonly policyVersion: string;
  readonly manifestHash: string;
  readonly packageJsonHash?: string;
  readonly lockfileHash?: string;
}

export interface PackageJsonMetadata {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
}

export const SITE_DEPENDENCY_POLICY_VERSION = "site-dependencies-v1";
export const SITE_V1_PACKAGE_MANAGER = { name: "npm" as const };

const BASE_DEPENDENCIES: Readonly<Record<string, ExactVersion>> = {
  react: "19.2.8",
  "react-dom": "19.2.8",
};
const BASE_DEV_DEPENDENCIES: Readonly<Record<string, ExactVersion>> = {
  "@types/react": "19.2.18",
  "@types/react-dom": "19.2.5",
  "@vitejs/plugin-react": "6.1.0",
  typescript: "7.0.2",
  vite: "8.2.2",
};
const BASE_SCRIPTS: Readonly<Record<string, string>> = {
  dev: "vite",
  build: "tsc --noEmit && vite build",
};

const withoutHash = (manifest: Omit<ResolvedDependencyManifest, "manifestHash">) => manifest;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const canonicalJson = (value: unknown): string => JSON.stringify(value);

export function buildResolvedDependencyManifest(
  profile: GeneratedAppProfile,
  capabilities: ResolvedCapabilities,
): ResolvedDependencyManifest {
  if (capabilities.profileId !== profile.id || capabilities.profileVersion !== profile.version)
    throw new ApplicationError(
      "PACKAGE_MANIFEST_MISMATCH",
      "Resolved capabilities do not match the generated app profile",
      { metadata: { profileId: profile.id, profileVersion: profile.version } },
    );
  if (profile.id !== "react-vite-v1" || profile.version !== 1)
    throw new ApplicationError(
      "UNSUPPORTED_SITE_REQUIREMENT",
      `No dependency manifest is registered for profile '${profile.id}@${profile.version}'`,
    );

  const base = withoutHash({
    schemaVersion: 1,
    profileId: profile.id,
    profileVersion: profile.version,
    capabilityRegistryVersion: capabilities.capabilityRegistryVersion,
    capabilities: capabilities.capabilities,
    dependencies: BASE_DEPENDENCIES,
    devDependencies: BASE_DEV_DEPENDENCIES,
    scripts: BASE_SCRIPTS,
    packageManager: SITE_V1_PACKAGE_MANAGER,
    policyVersion: SITE_DEPENDENCY_POLICY_VERSION,
  });
  return { ...base, manifestHash: hash(canonicalJson(base)) };
}

export function materializePackageJson(
  manifest: ResolvedDependencyManifest,
  metadata: PackageJsonMetadata,
): string {
  const packageJson = {
    name: metadata.name,
    version: metadata.version ?? "0.0.0",
    private: metadata.private ?? true,
    type: "module",
    scripts: manifest.scripts,
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
  };
  return JSON.stringify(packageJson, null, 2) + "\n";
}

export function attachDependencyArtifactHashes(
  manifest: ResolvedDependencyManifest,
  packageJson: string,
  lockfile: string,
): ResolvedDependencyManifest {
  const base = {
    schemaVersion: manifest.schemaVersion,
    profileId: manifest.profileId,
    profileVersion: manifest.profileVersion,
    capabilityRegistryVersion: manifest.capabilityRegistryVersion,
    capabilities: manifest.capabilities,
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    scripts: manifest.scripts,
    packageManager: manifest.packageManager,
    policyVersion: manifest.policyVersion,
    packageJsonHash: hash(packageJson),
    lockfileHash: hash(lockfile),
  };
  return { ...base, manifestHash: hash(canonicalJson(base)) };
}

export function assertExactDependencyVersions(manifest: ResolvedDependencyManifest): void {
  for (const section of [manifest.dependencies, manifest.devDependencies])
    for (const [name, version] of Object.entries(section))
      if (!/^\d+\.\d+\.\d+$/.test(version))
        throw new ApplicationError(
          "PACKAGE_MANIFEST_MISMATCH",
          `Dependency '${name}' must use an exact semantic version`,
          { metadata: { dependency: name } },
        );
}
