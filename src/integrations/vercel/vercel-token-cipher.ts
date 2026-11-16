import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for Vercel access tokens at rest:
 * `v1.<iv>.<tag>.<ciphertext>` (base64url). The owner and Vercel configuration
 * are bound as associated data, so a ciphertext copied onto another user's or
 * another installation's record fails authentication.
 */
const VERSION = "v1";

export interface TokenBinding {
  readonly ownerId: string;
  readonly configurationId: string;
}

const aad = (binding: TokenBinding) =>
  Buffer.from(`ai-sites:vercel:${binding.ownerId}:${binding.configurationId}`, "utf8");

export function encryptVercelToken(key: Buffer, token: string, binding: TokenBinding): string {
  if (key.length !== 32) throw new Error("Vercel token encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptVercelToken(key: Buffer, envelope: string, binding: TokenBinding): string {
  const [version, iv, tag, ciphertext, ...rest] = envelope.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext || rest.length)
    throw new Error("Unsupported Vercel token envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
