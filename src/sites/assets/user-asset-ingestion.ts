import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { createAssetIntent, createAssetManifest, createResolvedAsset, type AssetManifest, type ResolvedAsset } from "./asset-domain.js";
import type { MediaStore } from "./media-store.js";

const allowed = Object.freeze({ "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"] } as const);
export interface UserImageUpload { readonly originalName: string; readonly mimeType: string; readonly bytes: Uint8Array; }
export interface UserProvidedAsset { readonly id: string; readonly originalName: string; readonly mimeType: string; readonly managedPath: string; readonly asset: ResolvedAsset; }
function fail(code: "UNSUPPORTED_IMAGE_TYPE" | "IMAGE_TOO_LARGE" | "IMAGE_INGESTION_FAILED", message: string): never { throw new ApplicationError(code, message); }
function safeName(value: string): string {
  const name = basename(value.replaceAll("\\", "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "-").trim();
  if (!name || name === "." || name === "..") fail("UNSUPPORTED_IMAGE_TYPE", "Image filename is invalid");
  return name.slice(0, 180);
}
/** Stores browser image bytes behind the existing local artifact boundary. */
export async function ingestUserImage(mediaStore: MediaStore, upload: UserImageUpload): Promise<UserProvidedAsset> {
  const originalName = safeName(upload.originalName);
  const mimeType = upload.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = originalName.split(".").at(-1)?.toLowerCase();
  if (!extension || !(mimeType in allowed) || !(allowed[mimeType as keyof typeof allowed] as readonly string[]).includes(extension)) fail("UNSUPPORTED_IMAGE_TYPE", "Only PNG, JPG, JPEG, and WEBP images are supported");
  if (!upload.bytes.byteLength) fail("UNSUPPORTED_IMAGE_TYPE", "Image files cannot be empty");
  const id = `user-${randomUUID()}`;
  try {
    const asset = await mediaStore.put({ intent: createAssetIntent({ intentId: id, logicalAssetId: id, mediaType: "IMAGE", role: "CONTENT", purpose: "User-provided website image", description: `User-provided image: ${originalName}`, required: true, decorative: false, altTextIntent: originalName, sourcePreference: ["USER_UPLOAD"] }), bytes: upload.bytes, contentType: mimeType, sourceType: "USER_UPLOAD", provenance: { userUploadName: originalName }, altText: originalName });
    if (!asset.publicPath) fail("IMAGE_INGESTION_FAILED", "Managed image path was not created");
    return { id, originalName, mimeType, managedPath: asset.publicPath, asset };
  } catch (cause) {
    if (cause instanceof ApplicationError && cause.code === "ASSET_LIMIT_EXCEEDED") fail("IMAGE_TOO_LARGE", "Image exceeds the configured size limit");
    if (cause instanceof ApplicationError && cause.code === "ASSET_UNSUPPORTED_MIME") fail("UNSUPPORTED_IMAGE_TYPE", "Image content does not match its type");
    if (cause instanceof ApplicationError) throw cause;
    throw new ApplicationError("IMAGE_INGESTION_FAILED", "Unable to ingest image", { cause });
  }
}
export function userAssetsManifest(assets: readonly UserProvidedAsset[], referenceIds: readonly string[] = []): AssetManifest {
  const references = new Set(referenceIds);
  if (references.size !== referenceIds.length || references.size > 4 || referenceIds.some((id) => !assets.some((asset) => asset.id === id)))
    throw new ApplicationError("ASSET_VALIDATION_FAILED", "Design references must be distinct selected images (maximum four)");
  return createAssetManifest({
    manifestVersion: 1,
    assets: assets.map(({ id, asset }) => references.has(id)
      ? createResolvedAsset({ ...asset, role: "REFERENCE", purpose: "Design reference for website layout and visual style" })
      : asset),
  });
}
