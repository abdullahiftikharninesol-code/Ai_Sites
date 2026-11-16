import { VercelApiError, createVercelProjectsClient, type VercelAuth, type VercelProjectsClient } from "./vercel-projects-client.js";

/**
 * Why a stored connection can't be used as-is. Only problems Vercel actually
 * reported are "reauthorization" problems; outages and throttling are never
 * treated as proof that access was revoked.
 */
export type VercelConnectionProblem =
  | "TOKEN_REVOKED"
  | "TOKEN_UNREADABLE"
  | "INTEGRATION_DISABLED"
  | "INTEGRATION_REMOVED"
  | "ACCESS_REMOVED"
  | "ACCOUNT_MISMATCH"
  | "MISSING_PERMISSIONS"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export type VercelVerificationState = "OK" | "REAUTHORIZATION_REQUIRED" | "UNAVAILABLE";

export interface VercelAccountVerification {
  readonly state: VercelVerificationState;
  readonly problem?: VercelConnectionProblem;
  readonly accountType: "personal" | "team";
  /** From Vercel itself (team or user name); absent unless Vercel returned one. */
  readonly displayName?: string;
  readonly checkedAt: Date;
}

export interface VercelAccountVerifier {
  verify(input: { readonly auth: VercelAuth; readonly configurationId: string; readonly accountId: string; readonly now: Date }): Promise<VercelAccountVerification>;
}

const reauthorize = (problem: VercelConnectionProblem) => ({ state: "REAUTHORIZATION_REQUIRED" as const, problem });
const unavailable = (problem: VercelConnectionProblem) => ({ state: "UNAVAILABLE" as const, problem });

/** Maps a failed configuration lookup; only definite answers from Vercel require reauthorization. */
export function classifyVerificationFailure(error: unknown) {
  if (!(error instanceof VercelApiError) || error.status === undefined || error.status >= 500) return unavailable("UNAVAILABLE");
  if (error.status === 429) return unavailable("RATE_LIMITED");
  if (error.status === 401) return reauthorize("TOKEN_REVOKED");
  if (error.status === 403) return reauthorize(error.vercelCode === "integration_configuration_disabled" ? "INTEGRATION_DISABLED" : "ACCESS_REMOVED");
  if (error.status === 404 || error.status === 410) return reauthorize("INTEGRATION_REMOVED");
  return unavailable("UNAVAILABLE");
}

/** "read:project" / "read-write:deployment": only a recognizable read-only grant counts as missing. */
const lacksWrite = (scopes: readonly string[], resource: string) => {
  const matching = scopes.filter((scope) => new RegExp(`(?:^|:)${resource}$`).test(scope));
  return matching.length > 0 && !matching.some((scope) => scope.startsWith("read-write:"));
};

/**
 * Verifies a connection with at most two bounded Vercel requests (no retries):
 * the integration configuration (token validity, installation identity,
 * disabled state, granted scopes) and, best effort, the account's display name.
 */
export function createVercelAccountVerifier(client: VercelProjectsClient = createVercelProjectsClient()): VercelAccountVerifier {
  return {
    async verify({ auth, configurationId, accountId, now }) {
      const accountType = auth.teamId ? "team" : "personal";
      let configuration;
      try {
        configuration = await client.getConfiguration(auth, configurationId);
      } catch (error) {
        return { ...classifyVerificationFailure(error), accountType, checkedAt: now };
      }
      if (configuration.id !== configurationId || configuration.teamId !== auth.teamId || (configuration.ownerId !== undefined && configuration.ownerId !== accountId))
        return { ...reauthorize("ACCOUNT_MISMATCH"), accountType, checkedAt: now };
      if (configuration.disabled) return { ...reauthorize("INTEGRATION_DISABLED"), accountType, checkedAt: now };
      if (lacksWrite(configuration.scopes, "project") || lacksWrite(configuration.scopes, "deployment"))
        return { ...reauthorize("MISSING_PERMISSIONS"), accountType, checkedAt: now };
      const displayName = await client.getAccountName(auth).catch(() => undefined);
      return { state: "OK", accountType, ...(displayName ? { displayName } : {}), checkedAt: now };
    },
  };
}
