import { PublishingError } from "../../publishing/publishing-errors.js";
import type { VercelApiError } from "./vercel-projects-client.js";

/**
 * Maps a Vercel REST failure to a user-safe publishing error. Never includes
 * request headers or tokens; only Vercel's own bounded error code/message.
 */
export function classifyVercelApiError(error: VercelApiError, scope: "project" | "deployment" = "project"): PublishingError {
  const metadata = { status: error.status, ...(error.vercelCode ? { vercelCode: error.vercelCode } : {}) };
  const status = error.status;
  if (status === 401 || (scope === "project" && (status === 404 || status === 410)))
    return new PublishingError("VERCEL_TOKEN_REVOKED", "Vercel no longer accepts this connection. Reconnect Vercel and try again.", { metadata });
  if (status === 403 && error.vercelCode === "integration_configuration_disabled")
    return new PublishingError("VERCEL_INTEGRATION_DISABLED", "The AI Sites integration is disabled in this Vercel account. Re-enable or reinstall it in Vercel.", { metadata });
  if (status === 403)
    return new PublishingError(
      "VERCEL_PROJECT_ACCESS_RESTRICTED",
      `Vercel denied ${scope} access for this installation${error.vercelMessage ? `: ${error.vercelMessage}` : "."} Check the AI Sites integration's permissions in Vercel.`,
      { metadata },
    );
  if (status === 402) return new PublishingError("VERCEL_PLAN_LIMIT", `Your Vercel plan does not allow this ${scope} operation.`, { metadata });
  if (status === 429) return new PublishingError("VERCEL_RATE_LIMITED", "Vercel is rate limiting requests. Try again shortly.", { metadata });
  if (status === undefined || status >= 500) return new PublishingError("VERCEL_UNAVAILABLE", "Vercel could not be reached. Try again shortly.", { metadata });
  return new PublishingError("VERCEL_REQUEST_REJECTED", `Vercel rejected the ${scope} request${error.vercelMessage ? `: ${error.vercelMessage}` : "."}`, { metadata });
}
