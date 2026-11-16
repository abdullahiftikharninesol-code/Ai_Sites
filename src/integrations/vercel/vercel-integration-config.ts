/**
 * Vercel Connectable Account Integration configuration. Values are read from
 * the environment on demand and never logged; an incomplete configuration
 * disables the integration instead of falling back to defaults.
 */
export const VERCEL_CALLBACK_PATH = "/api/integrations/vercel/callback";

export const VERCEL_INTEGRATION_ENV = Object.freeze({
  clientId: "VERCEL_INTEGRATION_CLIENT_ID",
  clientSecret: "VERCEL_INTEGRATION_CLIENT_SECRET",
  slug: "VERCEL_INTEGRATION_SLUG",
  redirectUri: "VERCEL_INTEGRATION_REDIRECT_URI",
  returnUrl: "VERCEL_INTEGRATION_RETURN_URL",
  encryptionKey: "VERCEL_TOKEN_ENCRYPTION_KEY",
} as const);

export interface VercelIntegrationConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  /** Must equal the Redirect URL registered in the Vercel Integration Console. */
  readonly redirectUri: string;
  /** AI Sites page the browser returns to after the callback. */
  readonly returnUrl: string;
  /** 32-byte AES-256-GCM key for access tokens at rest. */
  readonly encryptionKey: Buffer;
}

export type VercelIntegrationConfigResult =
  | { readonly configured: true; readonly config: VercelIntegrationConfig }
  | { readonly configured: false; readonly problems: readonly string[] };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parseUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    if (url.protocol === "https:") return url;
    // Plain HTTP is accepted only for local development callbacks.
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
};

export function parseEncryptionKey(value: string): Buffer | undefined {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : /^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)
      ? Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      : undefined;
  return key?.length === 32 ? key : undefined;
}

export function loadVercelIntegrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): VercelIntegrationConfigResult {
  const problems: string[] = [];
  const read = (name: string) => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };
  const clientId = read(VERCEL_INTEGRATION_ENV.clientId);
  const clientSecret = read(VERCEL_INTEGRATION_ENV.clientSecret);
  const slug = read(VERCEL_INTEGRATION_ENV.slug);
  const redirectUri = read(VERCEL_INTEGRATION_ENV.redirectUri);
  const returnUrl = read(VERCEL_INTEGRATION_ENV.returnUrl);
  const rawKey = read(VERCEL_INTEGRATION_ENV.encryptionKey);

  if (slug && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug))
    problems.push(`${VERCEL_INTEGRATION_ENV.slug} is not a valid integration slug`);
  if (redirectUri) {
    const url = parseUrl(redirectUri);
    if (!url || url.search)
      problems.push(
        `${VERCEL_INTEGRATION_ENV.redirectUri} must be an https URL (http only on localhost) without query`,
      );
    else if (url.pathname !== VERCEL_CALLBACK_PATH)
      problems.push(
        `${VERCEL_INTEGRATION_ENV.redirectUri} must use the path ${VERCEL_CALLBACK_PATH}`,
      );
  }
  if (returnUrl && !parseUrl(returnUrl))
    problems.push(
      `${VERCEL_INTEGRATION_ENV.returnUrl} must be an https URL (http only on localhost)`,
    );
  const encryptionKey = rawKey ? parseEncryptionKey(rawKey) : undefined;
  if (rawKey && !encryptionKey)
    problems.push(
      `${VERCEL_INTEGRATION_ENV.encryptionKey} must be 32 bytes encoded as base64 or 64 hex characters`,
    );

  if (problems.length || !encryptionKey) return { configured: false, problems };
  return {
    configured: true,
    config: { clientId, clientSecret, slug, redirectUri, returnUrl, encryptionKey },
  };
}
