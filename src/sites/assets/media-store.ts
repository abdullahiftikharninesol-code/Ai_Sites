import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  AssetIntent,
  AssetManifest,
  AssetSourceType,
  ResolvedAsset,
} from "./asset-domain.js";
import {
  createAssetManifest,
  createResolvedAsset,
  validateAssetIntent,
} from "./asset-domain.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";

export const ASSET_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxWidth: 12_000,
  maxHeight: 12_000,
});

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** Opaque neutral blue-gray pixel; browsers scale it safely for any unresolved image placement. */
export const PLACEHOLDER_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x98, 0xb2, 0x78, 0xc7,
  0x7f, 0x00, 0x06, 0xad, 0x02, 0xef, 0xcc, 0x3e,
  0x66, 0x01, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export interface AssetWorkspaceWriter {
  writeFileBytes(environmentId: string, path: string, content: Uint8Array): Promise<void>;
}

export interface StoreAssetInput {
  readonly intent: AssetIntent;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sourceType: AssetSourceType;
  readonly provenance?: Record<string, unknown>;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
}

export interface AssetCandidate {
  readonly intentId: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sourceType: AssetSourceType;
  readonly provenance?: Record<string, unknown>;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
}

export interface MediaStore {
  put(input: StoreAssetInput): Promise<ResolvedAsset>;
  get(asset: ResolvedAsset): Promise<Uint8Array | undefined>;
  materialize(writer: AssetWorkspaceWriter, environmentId: string, asset: ResolvedAsset): Promise<void>;
}

function fail(code: "ASSET_RESOLUTION_FAILED" | "ASSET_LIMIT_EXCEEDED" | "ASSET_UNSUPPORTED_MIME" | "ASSET_NOT_FOUND" | "ASSET_MANAGED_FILE_MODIFICATION", message: string): never {
  throw new ApplicationError(code, message);
}

function normalizedMime(contentType: string): string {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (!MIME_EXTENSIONS[mime]) fail("ASSET_UNSUPPORTED_MIME", `Unsupported asset MIME type: ${contentType}`);
  return mime;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((value, index) => bytes[offset + index] === value);
}

function signatureMatches(mime: string, bytes: Uint8Array): boolean {
  switch (mime) {
    case "image/png": return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg": return hasPrefix(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif": return hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
    case "image/webp": return hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "image/avif": return bytes.length >= 12 && hasPrefix(bytes, [0x66, 0x74, 0x79, 0x70], 4) && (new TextDecoder().decode(bytes.slice(8, 12)) === "avif" || new TextDecoder().decode(bytes.slice(8, 12)) === "avis");
  }
  return false;
}

function safeAssetPath(value: string): boolean {
  return value.startsWith("/__sites/assets/") && !value.includes("\\") && !value.split("/").includes("..") && !value.split("/").includes(".");
}

function assetId(logicalAssetId: string, hash: string): string {
  return `${logicalAssetId}-${hash.slice(0, 12)}`;
}

export class ArtifactMediaStore implements MediaStore {
  readonly #assets = new Map<string, ResolvedAsset>();
  constructor(private readonly artifacts: ArtifactStore) {}

  async put(input: StoreAssetInput): Promise<ResolvedAsset> {
    const intent = validateAssetIntent(input.intent);
    if (input.bytes.byteLength > ASSET_LIMITS.maxBytes) fail("ASSET_LIMIT_EXCEEDED", `Asset exceeds ${ASSET_LIMITS.maxBytes} bytes`);
    const mimeType = normalizedMime(input.contentType);
    if (!signatureMatches(mimeType, input.bytes)) fail("ASSET_UNSUPPORTED_MIME", "Asset bytes do not match the declared image MIME type");
    const width = input.width;
    const height = input.height;
    if (width !== undefined && (width > ASSET_LIMITS.maxWidth || height === undefined || height > ASSET_LIMITS.maxHeight)) fail("ASSET_LIMIT_EXCEEDED", "Asset dimensions exceed the configured limit");
    if (height !== undefined && (height > ASSET_LIMITS.maxHeight || width === undefined || width > ASSET_LIMITS.maxWidth)) fail("ASSET_LIMIT_EXCEEDED", "Asset dimensions exceed the configured limit");
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const extension = MIME_EXTENSIONS[mimeType]!;
    const storageKey = `assets/content/${contentHash}.${extension}`;
    if (!(await this.artifacts.exists(storageKey))) {
      await this.artifacts.put(storageKey, input.bytes, { kind: "GENERATED_ASSET", contentType: mimeType });
    }
    const asset = createResolvedAsset({
      assetId: assetId(intent.logicalAssetId, contentHash),
      logicalAssetId: intent.logicalAssetId,
      intentId: intent.intentId,
      mediaType: intent.mediaType,
      role: intent.role,
      purpose: intent.purpose,
      sourceType: input.sourceType,
      contentHash,
      mimeType,
      byteLength: input.bytes.byteLength,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      storageKey,
      publicPath: `/__sites/assets/${contentHash}.${extension}`,
      ...(input.altText === undefined ? (intent.altTextIntent ? { altText: intent.altTextIntent } : {}) : { altText: input.altText }),
      decorative: intent.decorative,
      provenance: { sourceType: input.sourceType, ...(input.provenance ?? {}) },
      status: "RESOLVED",
    });
    this.#assets.set(asset.assetId, asset);
    return asset;
  }

  async get(asset: ResolvedAsset): Promise<Uint8Array | undefined> {
    const value = await this.artifacts.get(asset.storageKey);
    if (value === undefined) return undefined;
    const actualHash = createHash("sha256").update(value).digest("hex");
    if (actualHash !== asset.contentHash || value.byteLength !== asset.byteLength)
      fail("ASSET_RESOLUTION_FAILED", `Stored asset integrity mismatch: ${asset.assetId}`);
    return value;
  }

  async materialize(writer: AssetWorkspaceWriter, environmentId: string, asset: ResolvedAsset): Promise<void> {
    if (!asset.publicPath || !safeAssetPath(asset.publicPath)) fail("ASSET_MANAGED_FILE_MODIFICATION", "Asset public path is outside the managed asset directory");
    const bytes = await this.get(asset);
    if (!bytes) fail("ASSET_NOT_FOUND", `Asset not found: ${asset.assetId}`);
    await writer.writeFileBytes(environmentId, `public${asset.publicPath}`, bytes);
  }
}

export class DeterministicAssetResolver {
  constructor(private readonly mediaStore: MediaStore) {}

  async resolve(intents: readonly AssetIntent[], candidates: readonly AssetCandidate[] = []): Promise<AssetManifest> {
    const validatedIntents = intents.map(validateAssetIntent);
    const byIntent = new Map(validatedIntents.map((intent) => [intent.intentId, intent]));
    const candidatesByIntent = new Map<string, AssetCandidate[]>();
    for (const candidate of candidates) {
      if (!byIntent.has(candidate.intentId)) fail("ASSET_RESOLUTION_FAILED", `Candidate references unknown asset intent: ${candidate.intentId}`);
      const list = candidatesByIntent.get(candidate.intentId) ?? [];
      list.push(candidate);
      candidatesByIntent.set(candidate.intentId, list);
    }
    const resolved: ResolvedAsset[] = [];
    for (const intent of validatedIntents) {
      const candidatesForIntent = candidatesByIntent.get(intent.intentId) ?? [];
      const preferences = intent.sourcePreference ?? ["USER_UPLOAD", "SYSTEM", "GENERATED", "STOCK", "PLACEHOLDER"];
      const candidate = [...candidatesForIntent].sort((a, b) => preferences.indexOf(a.sourceType) - preferences.indexOf(b.sourceType) || a.sourceType.localeCompare(b.sourceType))[0];
      if (candidate) {
        resolved.push(await this.mediaStore.put({ ...candidate, intent }));
        continue;
      }
      if (!intent.required || preferences.includes("PLACEHOLDER")) {
        resolved.push(await this.mediaStore.put({ intent, bytes: PLACEHOLDER_PNG, contentType: "image/png", sourceType: "PLACEHOLDER" }));
        resolved[resolved.length - 1] = createResolvedAsset({ ...resolved[resolved.length - 1]!, status: "FALLBACK" });
        continue;
      }
      fail("ASSET_RESOLUTION_FAILED", `Required asset intent has no source: ${intent.intentId}`);
    }
    return createAssetManifest({ manifestVersion: 1, assets: resolved });
  }
}
