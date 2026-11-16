/**
 * Server-side calls to the Vercel REST API used by the connection flow.
 * https://vercel.com/docs/integrations/create-integration/vercel-api-integrations
 */
export const VERCEL_API_BASE_URL = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 10_000;

export interface VercelTokenExchange {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly installationId: string;
  readonly userId: string;
  readonly teamId: string | null;
}

export interface VercelOAuthClient {
  exchangeCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<VercelTokenExchange>;
  /** Removes the integration configuration; true when it is gone on Vercel. */
  removeConfiguration(input: {
    readonly accessToken: string;
    readonly configurationId: string;
    readonly teamId: string | null;
  }): Promise<boolean>;
}

export class VercelOAuthError extends Error {
  constructor(readonly status: number | undefined) {
    super("Vercel token exchange failed");
    this.name = "VercelOAuthError";
  }
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function createVercelOAuthClient(
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl = VERCEL_API_BASE_URL,
): VercelOAuthClient {
  return {
    async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v2/oauth/access_token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }).toString(),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new VercelOAuthError(undefined);
      }
      if (!response.ok) throw new VercelOAuthError(response.status);
      const body = (await response.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      if (
        !body ||
        !nonEmpty(body.access_token) ||
        !nonEmpty(body.installation_id) ||
        !nonEmpty(body.user_id) ||
        !(body.team_id === null || body.team_id === undefined || nonEmpty(body.team_id)) ||
        (body.token_type !== undefined &&
          !(typeof body.token_type === "string" && /^bearer$/i.test(body.token_type)))
      )
        throw new VercelOAuthError(response.status);
      return {
        accessToken: body.access_token,
        tokenType: "Bearer",
        installationId: body.installation_id,
        userId: body.user_id,
        teamId: nonEmpty(body.team_id) ? body.team_id : null,
      };
    },
    async removeConfiguration({ accessToken, configurationId, teamId }) {
      const url = new URL(
        `${baseUrl}/v1/integrations/configuration/${encodeURIComponent(configurationId)}`,
      );
      if (teamId) url.searchParams.set("teamId", teamId);
      try {
        const response = await fetchImpl(url, {
          method: "DELETE",
          headers: { authorization: `Bearer ${accessToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // 404: already removed on Vercel (e.g. uninstalled from the dashboard).
        return response.ok || response.status === 404;
      } catch {
        return false;
      }
    },
  };
}
