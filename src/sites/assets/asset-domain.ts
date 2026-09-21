import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";

export const ASSET_MEDIA_TYPES = ["IMAGE"] as const;
export type AssetMediaType = (typeof ASSET_MEDIA_TYPES)[number];

export const ASSET_SOURCE_TYPES = [
  "USER_UPLOAD",
  "GENERATED",
  "STOCK",
  "SYSTEM",
  "PLACEHOLDER",
] as const;
export type AssetSourceType = (typeof ASSET_SOURCE_TYPES)[number];

export const ASSET_ROLES = [
  "HERO",
  "CONTENT",
  "BACKGROUND",
  "LOGO",
  "GALLERY",
  "PRODUCT",
  "TEAM",
  "TESTIMONIAL",
  "THUMBNAIL",
  "SOCIAL",
  "DECORATIVE",
] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

export const ASSET_RESOLUTION_STATUSES = ["PENDING", "RESOLVED", "FALLBACK", "FAILED"] as const;
export type AssetResolutionStatus = (typeof ASSET_RESOLUTION_STATUSES)[number];

export interface AssetAspectRatio {
  readonly width: number;
  readonly height: number;
}

export interface AssetIntent {
  readonly intentId: string;
  readonly logicalAssetId: string;
  readonly mediaType: AssetMediaType;
  readonly role: AssetRole;
  readonly pageId?: string;
  readonly sectionId?: string;
  readonly purpose: string;
  readonly description: string;
  readonly required: boolean;
  readonly decorative: boolean;
  readonly altTextIntent?: string;
  readonly preferredAspectRatio?: AssetAspectRatio;
  readonly sourcePreference?: readonly AssetSourceType[];
}

export interface AssetProvenance {
  readonly sourceType: AssetSourceType;
  readonly providerId?: string;
  readonly providerAssetId?: string;
  readonly originalSourceUrl?: string;
  readonly author?: string;
  readonly license?: string;
  readonly attribution?: string;
  readonly retrievedAt?: string;
  readonly generationPrompt?: string;
  readonly userUploadName?: string;
}

export interface ResolvedAsset {
  readonly assetId: string;
  readonly logicalAssetId: string;
  readonly intentId: string;
  readonly mediaType: AssetMediaType;
  readonly role: AssetRole;
  readonly purpose?: string;
  readonly sourceType: AssetSourceType;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width?: number;
  readonly height?: number;
  readonly storageKey: string;
  readonly publicPath?: string;
  readonly altText?: string;
  readonly decorative: boolean;
  readonly provenance: AssetProvenance;
  readonly status: AssetResolutionStatus;
}

export interface AssetManifest {
  readonly manifestVersion: number;
  readonly assets: readonly ResolvedAsset[];
  readonly manifestHash: string;
}

const stableId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const hash = /^[a-f0-9]{64}$/;
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);

function fail(message: string): never {
  throw new ApplicationError("ASSET_VALIDATION_FAILED", message);
}

function requireText(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${field} must be a non-empty string under ${max} characters`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max = 500): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) fail(`${field} must be under ${max} characters`);
  return value.trim() || undefined;
}

function validateId(value: unknown, field: string): string {
  const result = requireText(value, field, 160);
  if (!stableId.test(result)) fail(`${field} must be a stable lowercase identifier`);
  return result;
}

function validateAspectRatio(value: unknown, field: string): AssetAspectRatio {
  if (!value || typeof value !== "object") fail(`${field} must be an object`);
  const ratio = value as Partial<AssetAspectRatio>;
  if (typeof ratio.width !== "number" || typeof ratio.height !== "number" || !Number.isInteger(ratio.width) || !Number.isInteger(ratio.height) || ratio.width <= 0 || ratio.height <= 0)
    fail(`${field} width and height must be positive integers`);
  const width = ratio.width as number;
  const height = ratio.height as number;
  return { width, height };
}

function validateSafeRelative(value: unknown, field: string): string {
  const result = requireText(value, field, 500).replaceAll("\\", "/");
  if (result.startsWith("/") || posix.normalize(result).startsWith("../") || result.split("/").includes(".."))
    fail(`${field} must be a safe relative path`);
  return result;
}

function validatePublicPath(value: unknown, field: string): string {
  const result = requireText(value, field, 500);
  if (!result.startsWith("/") || result.includes("\\") || posix.normalize(result).startsWith("/../") || result.split("/").includes(".."))
    fail(`${field} must be a safe public path`);
  return result;
}

function validateProvenance(value: unknown, expectedSource: AssetSourceType): AssetProvenance {
  if (!value || typeof value !== "object") fail("provenance must be an object");
  const raw = value as Partial<AssetProvenance>;
  if (raw.sourceType !== expectedSource) fail("provenance.sourceType must match sourceType");
  const url = optionalText(raw.originalSourceUrl, "provenance.originalSourceUrl", 2_000);
  if (url !== undefined && !/^https?:\/\//i.test(url)) fail("provenance.originalSourceUrl must use http or https");
  const retrievedAt = optionalText(raw.retrievedAt, "provenance.retrievedAt", 40);
  if (retrievedAt !== undefined && !isoDate.test(retrievedAt)) fail("provenance.retrievedAt must be an ISO UTC timestamp");
  const providerId = optionalText(raw.providerId, "provenance.providerId", 120);
  const providerAssetId = optionalText(raw.providerAssetId, "provenance.providerAssetId", 240);
  const author = optionalText(raw.author, "provenance.author", 240);
  const license = optionalText(raw.license, "provenance.license", 240);
  const attribution = optionalText(raw.attribution, "provenance.attribution", 500);
  const generationPrompt = optionalText(raw.generationPrompt, "provenance.generationPrompt", 2_000);
  const userUploadName = optionalText(raw.userUploadName, "provenance.userUploadName", 255);
  return {
    sourceType: expectedSource,
    ...(providerId ? { providerId } : {}),
    ...(providerAssetId ? { providerAssetId } : {}),
    ...(url ? { originalSourceUrl: url } : {}),
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(attribution ? { attribution } : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
    ...(generationPrompt ? { generationPrompt } : {}),
    ...(userUploadName ? { userUploadName } : {}),
  };
}

export function validateAssetIntent(value: unknown): AssetIntent {
  if (!value || typeof value !== "object") fail("AssetIntent must be an object");
  const raw = value as Partial<AssetIntent>;
  const intentId = validateId(raw.intentId, "intentId");
  const logicalAssetId = validateId(raw.logicalAssetId, "logicalAssetId");
  if (!isOneOf(ASSET_MEDIA_TYPES, raw.mediaType)) fail("mediaType is invalid");
  if (!isOneOf(ASSET_ROLES, raw.role)) fail("role is invalid");
  if (typeof raw.required !== "boolean" || typeof raw.decorative !== "boolean") fail("required and decorative must be boolean");
  const sourcePreference = raw.sourcePreference;
  if (sourcePreference !== undefined && (!Array.isArray(sourcePreference) || sourcePreference.length === 0 || sourcePreference.some((source) => !isOneOf(ASSET_SOURCE_TYPES, source))))
    fail("sourcePreference must contain valid unique source types");
  if (sourcePreference && new Set(sourcePreference).size !== sourcePreference.length) fail("sourcePreference must not contain duplicates");
  const pageId = raw.pageId === undefined ? undefined : validateId(raw.pageId, "pageId");
  const sectionId = raw.sectionId === undefined ? undefined : validateId(raw.sectionId, "sectionId");
  const altTextIntent = optionalText(raw.altTextIntent, "altTextIntent", 500);
  if (!raw.decorative && !altTextIntent) fail("meaningful assets require altTextIntent");
  return {
    intentId,
    logicalAssetId,
    mediaType: raw.mediaType,
    role: raw.role,
    ...(pageId ? { pageId } : {}),
    ...(sectionId ? { sectionId } : {}),
    purpose: requireText(raw.purpose, "purpose"),
    description: requireText(raw.description, "description", 1_000),
    required: raw.required,
    decorative: raw.decorative,
    ...(altTextIntent ? { altTextIntent } : {}),
    ...(raw.preferredAspectRatio ? { preferredAspectRatio: validateAspectRatio(raw.preferredAspectRatio, "preferredAspectRatio") } : {}),
    ...(sourcePreference ? { sourcePreference: Object.freeze([...sourcePreference]) } : {}),
  };
}

export function validateResolvedAsset(value: unknown): ResolvedAsset {
  if (!value || typeof value !== "object") fail("ResolvedAsset must be an object");
  const raw = value as Partial<ResolvedAsset>;
  const assetId = validateId(raw.assetId, "assetId");
  const logicalAssetId = validateId(raw.logicalAssetId, "logicalAssetId");
  const intentId = validateId(raw.intentId, "intentId");
  if (!isOneOf(ASSET_MEDIA_TYPES, raw.mediaType)) fail("mediaType is invalid");
  if (!isOneOf(ASSET_ROLES, raw.role)) fail("role is invalid");
  if (!isOneOf(ASSET_SOURCE_TYPES, raw.sourceType)) fail("sourceType is invalid");
  if (!isOneOf(ASSET_RESOLUTION_STATUSES, raw.status)) fail("status is invalid");
  if (typeof raw.contentHash !== "string" || !hash.test(raw.contentHash)) fail("contentHash must be a lowercase SHA-256 hash");
  const mimeType = requireText(raw.mimeType, "mimeType", 120).toLowerCase();
  if (!mimeType.startsWith("image/")) fail("mimeType must be an image MIME type");
  const byteLength = raw.byteLength;
  if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 0) fail("byteLength must be a non-negative integer");
  const width = raw.width;
  const height = raw.height;
  if ((width === undefined) !== (height === undefined) || (width !== undefined && (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0))) fail("width and height must be positive integers supplied together");
  const storageKey = validateSafeRelative(raw.storageKey, "storageKey");
  const publicPath = raw.publicPath === undefined ? undefined : validatePublicPath(raw.publicPath, "publicPath");
  const altText = optionalText(raw.altText, "altText", 500);
  const purpose = optionalText(raw.purpose, "purpose", 500);
  if (!raw.decorative && !altText) fail("meaningful assets require altText");
  if (typeof raw.decorative !== "boolean") fail("decorative must be boolean");
  const provenance = validateProvenance(raw.provenance, raw.sourceType);
  return {
    assetId,
    logicalAssetId,
    intentId,
    mediaType: raw.mediaType,
    role: raw.role,
    ...(purpose ? { purpose } : {}),
    sourceType: raw.sourceType,
    contentHash: raw.contentHash,
    mimeType,
    byteLength: byteLength as number,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    storageKey,
    ...(publicPath ? { publicPath } : {}),
    ...(altText ? { altText } : {}),
    decorative: raw.decorative,
    provenance,
    status: raw.status,
  };
}

function canonicalAsset(asset: ResolvedAsset): Record<string, unknown> {
  return {
    assetId: asset.assetId,
    logicalAssetId: asset.logicalAssetId,
    intentId: asset.intentId,
    mediaType: asset.mediaType,
    role: asset.role,
    ...(asset.purpose === undefined ? {} : { purpose: asset.purpose }),
    sourceType: asset.sourceType,
    contentHash: asset.contentHash,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    storageKey: asset.storageKey,
    ...(asset.publicPath === undefined ? {} : { publicPath: asset.publicPath }),
    ...(asset.altText === undefined ? {} : { altText: asset.altText }),
    decorative: asset.decorative,
    provenance: asset.provenance,
    status: asset.status,
  };
}

export function serializeAssetManifestInput(manifest: Pick<AssetManifest, "manifestVersion" | "assets">): string {
  const assets = [...manifest.assets].sort((a, b) => a.logicalAssetId.localeCompare(b.logicalAssetId) || a.assetId.localeCompare(b.assetId));
  return JSON.stringify({ manifestVersion: manifest.manifestVersion, assets: assets.map(canonicalAsset) });
}

export function createAssetIntent(input: AssetIntent): AssetIntent {
  const validated = validateAssetIntent(input);
  return deepFreeze(validated);
}

export function createResolvedAsset(input: ResolvedAsset): ResolvedAsset {
  return deepFreeze(validateResolvedAsset(input));
}

export function createAssetManifest(input: { readonly manifestVersion: number; readonly assets: readonly ResolvedAsset[] }): AssetManifest {
  if (!Number.isInteger(input.manifestVersion) || input.manifestVersion <= 0) fail("manifestVersion must be a positive integer");
  const assets = input.assets.map((asset) => createResolvedAsset(asset));
  if (assets.some((asset) => !["RESOLVED", "FALLBACK"].includes(asset.status))) fail("AssetManifest cannot contain pending or failed assets");
  const logicalIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (logicalIds.has(asset.logicalAssetId)) fail(`Duplicate logical asset ID: ${asset.logicalAssetId}`);
    if (assetIds.has(asset.assetId)) fail(`Duplicate asset ID: ${asset.assetId}`);
    logicalIds.add(asset.logicalAssetId);
    assetIds.add(asset.assetId);
  }
  const canonical = serializeAssetManifestInput({ manifestVersion: input.manifestVersion, assets });
  return deepFreeze({
    manifestVersion: input.manifestVersion,
    assets: [...assets].sort((a, b) => a.logicalAssetId.localeCompare(b.logicalAssetId) || a.assetId.localeCompare(b.assetId)),
    manifestHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

export function findAssetByLogicalId(manifest: AssetManifest, logicalAssetId: string): ResolvedAsset | undefined {
  return manifest.assets.find((asset) => asset.logicalAssetId === logicalAssetId);
}

export function findAssetById(manifest: AssetManifest, assetId: string): ResolvedAsset | undefined {
  return manifest.assets.find((asset) => asset.assetId === assetId);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
