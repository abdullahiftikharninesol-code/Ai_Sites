import { ApplicationError } from "../../app/errors/application-error.js";
import type { AgentImagePart, AgentImageMimeType } from "../../agents/agent-types.js";
import { isVisualReferenceAsset, type AssetManifest } from "./asset-domain.js";
import type { MediaStore } from "./media-store.js";

const supported = new Set<AgentImageMimeType>(["image/png", "image/jpeg", "image/webp"]);

/** Transient visual inputs for the existing coder call; never serialized into project records. */
export async function loadVisualReferences(manifest: AssetManifest | undefined, mediaStore: MediaStore | undefined): Promise<readonly AgentImagePart[]> {
  const references = (manifest?.assets ?? []).filter(isVisualReferenceAsset);
  if (!references.length) return [];
  if (!mediaStore) throw new ApplicationError("USER_ASSET_NOT_FOUND", "Design reference storage is unavailable");
  if (references.length > 4) throw new ApplicationError("ASSET_LIMIT_EXCEEDED", "At most four design references are supported");
  return Promise.all(references.map(async (asset): Promise<AgentImagePart> => {
    if (!supported.has(asset.mimeType as AgentImageMimeType))
      throw new ApplicationError("UNSUPPORTED_IMAGE_TYPE", "Design reference image format is unsupported");
    const data = await mediaStore.get(asset);
    if (!data) throw new ApplicationError("USER_ASSET_NOT_FOUND", "A design reference image is no longer available");
    return { mimeType: asset.mimeType as AgentImageMimeType, data, sourceRef: asset.assetId };
  }));
}
