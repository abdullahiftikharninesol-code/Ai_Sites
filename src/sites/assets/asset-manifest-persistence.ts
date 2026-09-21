import { ApplicationError } from "../../app/errors/application-error.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import { createAssetManifest, type AssetManifest } from "./asset-domain.js";

export async function persistAssetManifest(
  artifacts: ArtifactStore,
  artifactRef: string,
  manifest: AssetManifest,
): Promise<void> {
  await artifacts.put(artifactRef, Buffer.from(JSON.stringify(manifest), "utf8"), {
    kind: "GENERATED_ASSET",
    contentType: "application/vnd.sites.asset-manifest+json",
  });
}

export async function loadAssetManifest(artifacts: ArtifactStore, artifactRef: string): Promise<AssetManifest> {
  const bytes = await artifacts.get(artifactRef);
  if (!bytes) throw new ApplicationError("ASSET_NOT_FOUND", `Asset manifest not found: ${artifactRef}`);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (cause) {
    throw new ApplicationError("ASSET_RESOLUTION_FAILED", "Asset manifest is not valid JSON", { cause });
  }
  if (!raw || typeof raw !== "object" || typeof (raw as { manifestVersion?: unknown }).manifestVersion !== "number" || !Array.isArray((raw as { assets?: unknown }).assets))
    throw new ApplicationError("ASSET_RESOLUTION_FAILED", "Asset manifest shape is invalid");
  const value = raw as { manifestVersion: number; assets: AssetManifest["assets"]; manifestHash?: unknown };
  const manifest = createAssetManifest({ manifestVersion: value.manifestVersion, assets: value.assets });
  if (value.manifestHash !== manifest.manifestHash)
    throw new ApplicationError("ASSET_RESOLUTION_FAILED", "Asset manifest hash does not match its content");
  return manifest;
}

export interface AssetManifestImpact {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function compareAssetManifests(previous: AssetManifest | undefined, next: AssetManifest): AssetManifestImpact {
  const before = new Map((previous?.assets ?? []).map((asset) => [asset.logicalAssetId, asset.contentHash]));
  const after = new Map(next.assets.map((asset) => [asset.logicalAssetId, asset.contentHash]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)).sort();
  return { added, removed, changed };
}
