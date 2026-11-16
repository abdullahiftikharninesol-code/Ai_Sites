import type { IncomingMessage, ServerResponse } from "node:http";
import { VERCEL_CALLBACK_PATH } from "./vercel-integration-config.js";
import {
  VERCEL_DISCONNECT_CONFIRMATION,
  VercelIntegrationError,
  type VercelCallbackFailure,
  type VercelConnectionService,
  type VercelReturnContext,
} from "./vercel-connection-service.js";

export const VERCEL_ROUTE_PREFIX = "/api/integrations/vercel/";

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};

/** Bounded JSON object reader; an empty body is `{}`. Returns undefined when invalid. */
async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 4_096) return undefined;
    chunks.push(bytes);
  }
  if (!size) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Shown only when no return URL is configured; contains no request data. */
const fallbackPage = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>AI Sites</title><p>${
    ok
      ? "Vercel account connected. You can close this window."
      : "Vercel connection failed. Return to AI Sites and try again."
  }</p>`;

/**
 * Vercel's Redirect URL. Authentication comes from the single-use state, not a
 * bearer token, because this request is a browser redirect from vercel.com.
 */
export async function handleVercelCallback(
  url: URL,
  res: ServerResponse,
  service: VercelConnectionService,
): Promise<void> {
  let outcome: { ok: true } | { ok: false; reason: VercelCallbackFailure };
  let context: VercelReturnContext | undefined;
  try {
    context = await service.complete(url.searchParams);
    outcome = { ok: true };
  } catch (error) {
    const known = error instanceof VercelIntegrationError;
    if (!known)
      console.error("[sites][vercel] callback failed unexpectedly", {
        name: (error as Error)?.name,
      });
    outcome = { ok: false, reason: known && error.reason ? error.reason : "storage_failed" };
    context = known ? error.returnContext : undefined;
  }
  const headers = {
    "cache-control": "no-store",
    // Keeps the one-time code and state out of the next page's Referer.
    "referrer-policy": "no-referrer",
  };
  const location = await service.returnLocation(outcome, context);
  if (location) {
    res.writeHead(303, { ...headers, location });
    res.end();
    return;
  }
  res.writeHead(outcome.ok ? 200 : 503, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'",
  });
  res.end(fallbackPage(outcome.ok));
}

/** True when the request is the unauthenticated Vercel callback. */
export const isVercelCallback = (method: string, path: string) =>
  method === "GET" && path === VERCEL_CALLBACK_PATH;

/**
 * Authenticated status/connect/disconnect routes. Returns false when the path
 * is not a Vercel integration route.
 */
export async function handleVercelAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ownerId: string,
  service: VercelConnectionService,
): Promise<boolean> {
  if (!path.startsWith(VERCEL_ROUTE_PREFIX)) return false;
  const method = req.method ?? "GET";
  try {
    if (method === "GET" && path === "/api/integrations/vercel/status") {
      // ?refresh=1 re-verifies with Vercel (throttled per user); otherwise a cached verification is used.
      const refresh = new URL(req.url ?? path, "http://localhost").searchParams.get("refresh") === "1";
      json(res, 200, await service.status(ownerId, { refresh }));
      return true;
    }
    if (method === "POST" && path === "/api/integrations/vercel/connect") {
      const body = await readSmallJson(req);
      if (body === undefined) {
        json(res, 400, {
          error: { code: "INVALID_REQUEST", message: "Request body must be a small JSON object" },
        });
        return true;
      }
      json(res, 201, await service.start(ownerId, "siteId" in body ? { siteId: body.siteId } : {}));
      return true;
    }
    if (method === "DELETE" && path === "/api/integrations/vercel/connection") {
      // Bearer-authenticated (no cookies), plus an explicit confirmation the UI sends only after the user confirms.
      const body = await readSmallJson(req);
      if (body?.confirm !== VERCEL_DISCONNECT_CONFIRMATION) {
        json(res, 400, { error: { code: "CONFIRMATION_REQUIRED", message: "Confirm disconnecting Vercel." } });
        return true;
      }
      json(res, 200, await service.disconnect(ownerId, { allowActivePublishing: body.allowActivePublishing === true }));
      return true;
    }
  } catch (error) {
    if (
      error instanceof VercelIntegrationError &&
      error.code === "VERCEL_INTEGRATION_NOT_CONFIGURED"
    ) {
      json(res, 503, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof VercelIntegrationError && error.code === "VERCEL_DISCONNECT_BLOCKED") {
      json(res, 409, { error: { code: error.code, message: error.message } });
      return true;
    }
    // Same response as any missing or foreign site.
    if (error instanceof VercelIntegrationError && error.code === "VERCEL_SITE_NOT_FOUND") {
      json(res, 404, { error: { code: "SITE_NOT_FOUND", message: "Site not found" } });
      return true;
    }
    throw error;
  }
  json(res, 404, {
    error: { code: "NOT_FOUND", message: "Vercel integration endpoint not found" },
  });
  return true;
}
