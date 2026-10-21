import { createHash } from "node:crypto";

/**
 * Bound every supplied OpenAI cache identity without exposing its raw contents.
 * The fixed ASCII prefix (6) plus a full SHA-256 base64url digest (43) is always
 * 49 characters, below OpenAI's 64-character limit regardless of identity length.
 */
export function openAIPromptCacheKey(logicalIdentity: string): string {
  return `sites-${createHash("sha256").update(logicalIdentity, "utf8").digest("base64url")}`;
}
