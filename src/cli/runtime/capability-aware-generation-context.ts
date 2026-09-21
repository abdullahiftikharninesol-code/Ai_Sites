import type { GeneratedAppProfile } from "./site-technical-profile.js";
import type { ResolvedCapabilities } from "../../sites/generation/capability-resolver.js";
import type { ResolvedDependencyManifest } from "../../sites/generation/resolved-dependency-manifest.js";
import type { SitesUiRegistryItem } from "../../sites/generation/sites-ui-registry.js";
import type { AssetManifest } from "../../sites/assets/asset-domain.js";

export interface CapabilityAwareGenerationContextInput {
  readonly profile: GeneratedAppProfile;
  readonly capabilities?: ResolvedCapabilities | undefined;
  readonly dependencyManifest?: ResolvedDependencyManifest | undefined;
  readonly uiRegistryItems?: readonly SitesUiRegistryItem[] | undefined;
  readonly assetManifest?: AssetManifest | undefined;
  readonly requestText?: string | undefined;
}

/**
 * Builds the small deterministic capability contract supplied to the coding
 * model. It contains identities and approved roots, never package-selection
 * authority or full managed-file contents.
 */
export function buildCapabilityAwareGenerationContext(
  input: CapabilityAwareGenerationContextInput,
): string {
  const selected = new Set(input.capabilities?.capabilities.map(({ id }) => id));
  const packageRoots = [
    ...Object.keys(input.dependencyManifest?.dependencies ?? {}),
    ...Object.keys(input.dependencyManifest?.devDependencies ?? {}),
  ].sort((a, b) => a.localeCompare(b));
  // Advertise each item by its exact import specifier. The registry roots are
  // managed, so an item the model can only guess at is worse than no item: the
  // guess fails import validation and the whole paid response is discarded.
  // Grouped by directory to stay inside the context budget.
  const uiImportGroups = new Map<string, string[]>();
  for (const item of input.uiRegistryItems ?? []) {
    if (!item.requiredCapabilities.every((id) => selected.has(id))) continue;
    const separator = item.importPath.lastIndexOf("/");
    const directory = item.importPath.slice(0, separator);
    const name = item.importPath.slice(separator + 1);
    uiImportGroups.set(directory, [...(uiImportGroups.get(directory) ?? []), name]);
  }
  const uiItems = [...uiImportGroups]
    .map(([directory, names]) =>
      names.length > 1
        ? `${directory}/{${[...names].sort((a, b) => a.localeCompare(b)).join(",")}}`
        : `${directory}/${names[0]}`,
    )
    .sort((a, b) => a.localeCompare(b));
  const assets = (input.assetManifest?.assets ?? []).map((asset) => ({
    logicalAssetId: asset.logicalAssetId,
    role: asset.role,
    purpose: asset.purpose ?? asset.role,
    publicPath: asset.publicPath,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    ...(asset.altText === undefined ? {} : { altText: asset.altText }),
    decorative: asset.decorative,
  }));
  const backgroundAssets = assets.filter((asset) => asset.role === "BACKGROUND");
  const imageAssets = assets.filter((asset) => asset.role !== "BACKGROUND");
  const explicitMotion = /\b(?:animat(?:e|ed|ion|ions)|motion|parallax|cinematic|moving\s+background)\b/i.test(input.requestText ?? "");
  const lines = [
    "Capability Context:",
    `Profile: ${input.profile.id}@${input.profile.version}`,
    `Capabilities: ${input.capabilities?.capabilities.map(({ id }) => id).join(", ") || "none"}`,
    `Allowed package roots: ${packageRoots.join(", ") || "none"}`,
    `Sites UI registry (named exports, import from): ${uiItems.join(", ") || "none"}`,
    `Asset manifest: ${assets.length ? JSON.stringify(assets) : "none"}`,
    "Motion: one-time staggered hero/CTA entrances plus restrained card/button hover/focus feedback. Use opacity/transform, finite durations, no layout shifts or loops.",
    "At prefers-reduced-motion: reduce, disable decorative movement and keep all content visible.",
    ...(explicitMotion ? ["The user explicitly requested animation: make the motion design visible and purposeful across the hero and relevant content, within the CSS and accessibility rules above."] : []),
    ...(backgroundAssets.length ? [
      `Background image motion: use the resolved BACKGROUND asset publicPath (${backgroundAssets.map((asset) => asset.publicPath).join(", ")}) in the requested section, not as a substitute for a missing image. Put it on a separate, clipped layer behind readable content and a contrast overlay; use a one-time opacity/scale reveal (for example scale 1.04 to 1 over 700–1200ms), then rest. Keep the image visible when motion is reduced.`,
    ] : []),
    ...(imageAssets.length ? ["Content image motion: where appropriate, give resolved hero/gallery/content images a one-time subtle opacity/scale reveal without changing layout or hiding meaningful imagery in reduced-motion mode."] : []),
    "Use only Asset manifest public paths for media, including <img src> and CSS background-image declarations wherever requested imagery belongs. Do not invent remote URLs, silently omit resolved requested assets, or write Sites-managed asset binaries.",
    "Dependency and package-manager changes are controlled by Sites; use only the listed capabilities and package roots.",
  ];
  return lines.join("\n");
}
