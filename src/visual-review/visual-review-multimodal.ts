import { ApplicationError } from "../app/errors/application-error.js";
import type { AgentCapabilities, AgentImageMimeType, AgentImagePart } from "../agents/agent-types.js";
import type { VisualScreenshotReference } from "./visual-review-domain.js";

/**
 * Layer 3E.3 provider-neutral multimodal input support for Visual Review.
 * Narrowly scoped to the screenshot bytes Layer 3D actually produces
 * (full-page PNG). Never accepts arbitrary SVG/HTML as vision input.
 */

export const SUPPORTED_VISUAL_IMAGE_MIME_TYPES: readonly AgentImageMimeType[] = ["image/png"];

/**
 * Conservative per-image byte bound so a single oversized screenshot cannot
 * blow the provider payload limit. Revisit only with controlled evaluation
 * against the specific provider(s) approved for production Visual Review.
 */
export const MAX_VISUAL_REVIEW_IMAGE_BYTES = 5_000_000;

/**
 * Bounded selection so one Visual Review request never turns into one model
 * call per screenshot. Exact ceiling is a versioned policy value, not a
 * provider hard limit.
 */
export const MAX_VISUAL_REVIEW_IMAGES_PER_REQUEST = 6;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type VisualProviderFailureReason =
  | "VISION_UNSUPPORTED"
  | "PROVIDER_QUOTA"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK"
  | "INVALID_MULTIMODAL_REQUEST"
  | "STRUCTURED_RESPONSE_INVALID";

export interface VisualScreenshotBytes {
  readonly reference: VisualScreenshotReference;
  readonly bytes: Uint8Array;
}

function fail(message: string, reason: VisualProviderFailureReason = "INVALID_MULTIMODAL_REQUEST"): never {
  throw new ApplicationError("VISUAL_REVIEW_INPUT_INVALID", message, { metadata: { reason } });
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** Fails closed unless the provider/model explicitly declares PNG vision support. Never assumes vision from a bare boolean alone once mime types are declared. */
export function assertVisionCapableProvider(capabilities: AgentCapabilities): void {
  if (capabilities.vision !== true) fail("Provider does not report vision support", "VISION_UNSUPPORTED");
  const declaredMimeTypes = capabilities.visionInputMimeTypes;
  if (declaredMimeTypes !== undefined && !declaredMimeTypes.includes("image/png"))
    fail("Provider does not declare PNG vision input support", "VISION_UNSUPPORTED");
}

/**
 * Builds bounded, provider-neutral image parts from Layer 3D screenshot
 * bytes. Validates PNG signature (never trusts an extension or content-type
 * label alone), per-image size, and total request count. Returns parts in
 * the same order as the input so callers control deterministic ordering
 * (e.g. the review's own sorted screenshotRefs).
 */
export function buildVisualReviewImageParts(
  screenshots: readonly VisualScreenshotBytes[],
): readonly AgentImagePart[] {
  if (screenshots.length === 0) fail("Visual Review requires at least one screenshot");
  if (screenshots.length > MAX_VISUAL_REVIEW_IMAGES_PER_REQUEST)
    fail(`Visual Review requests are bounded to ${MAX_VISUAL_REVIEW_IMAGES_PER_REQUEST} screenshots`);
  return screenshots.map(({ reference, bytes }) => {
    if (!bytes || bytes.length === 0) fail(`Screenshot '${reference.artifactRef}' has no bytes`);
    if (bytes.length > MAX_VISUAL_REVIEW_IMAGE_BYTES)
      fail(`Screenshot '${reference.artifactRef}' exceeds the ${MAX_VISUAL_REVIEW_IMAGE_BYTES}-byte Visual Review limit`);
    if (!isPng(bytes)) fail(`Screenshot '${reference.artifactRef}' is not a valid PNG image`);
    return Object.freeze({
      mimeType: "image/png" as const,
      data: bytes,
      sourceRef: reference.artifactRef,
    });
  });
}

/**
 * Classifies a Visual Review provider failure into the bounded taxonomy the
 * pipeline uses to decide INCONCLUSIVE vs. a hard stop. Never maps a
 * provider failure to PASS.
 */
export function classifyVisualProviderFailure(cause: unknown): VisualProviderFailureReason {
  if (cause instanceof ApplicationError) {
    const declared = cause.metadata?.reason;
    if (
      declared === "VISION_UNSUPPORTED" ||
      declared === "PROVIDER_QUOTA" ||
      declared === "PROVIDER_TIMEOUT" ||
      declared === "PROVIDER_NETWORK" ||
      declared === "INVALID_MULTIMODAL_REQUEST" ||
      declared === "STRUCTURED_RESPONSE_INVALID"
    )
      return declared;
    if (
      cause.code === "STRUCTURED_RESPONSE_EMPTY" ||
      cause.code === "STRUCTURED_RESPONSE_PARSE_FAILED" ||
      cause.code === "STRUCTURED_RESPONSE_SCHEMA_INVALID" ||
      cause.code === "VALIDATION_FAILED"
    )
      return "STRUCTURED_RESPONSE_INVALID";
    const status = typeof cause.metadata?.status === "number" ? cause.metadata.status : undefined;
    if (status === 429) return "PROVIDER_QUOTA";
    if (status === 408 || status === 504) return "PROVIDER_TIMEOUT";
    if (status !== undefined && status >= 500) return "PROVIDER_NETWORK";
  }
  if (cause instanceof Error && cause.name === "AbortError") return "PROVIDER_TIMEOUT";
  return "PROVIDER_NETWORK";
}
