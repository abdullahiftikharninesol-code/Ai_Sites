import type { ServerResponse } from "node:http";
import { PublishingError } from "./publishing-errors.js";
import type { PublishPreparationService } from "./publish-preparation-service.js";
import type { VercelPublishService } from "./vercel-publish-service.js";

const PREPARE = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/publish\/prepare$/;
const STATUS = /^\/api\/dev\/sites\/([^/]+)\/publish\/preparation$/;
const PUBLISH = /^\/api\/dev\/sites\/([^/]+)\/versions\/([^/]+)\/publish\/vercel$/;
const PUBLISH_STATUS = /^\/api\/dev\/sites\/([^/]+)\/publish\/vercel$/;

/** True for the publishing routes (handled by handlePublishPreparationRoute). */
export const isPublishPreparationRoute = (path: string) =>
  PREPARE.test(path) || STATUS.test(path) || PUBLISH.test(path) || PUBLISH_STATUS.test(path);

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

const param = (value: string) => {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length <= 200) return decoded;
  } catch {
    /* fall through */
  }
  throw new PublishingError("PUBLISH_PREPARATION_NOT_FOUND", "Publishing preparation not found");
};

/**
 * Authenticated routes (ownerId comes only from the verified JWT):
 *   POST /api/dev/sites/:siteId/versions/:versionId/publish/prepare → 202 preparation
 *   GET  /api/dev/sites/:siteId/publish/preparation                 → 200 { preparation }
 *   POST /api/dev/sites/:siteId/versions/:versionId/publish/vercel  → 202 { publish }
 *   GET  /api/dev/sites/:siteId/publish/vercel                      → 200 { publish }
 * Returns false when the path is not one of them.
 */
export async function handlePublishPreparationRoute(
  method: string,
  path: string,
  res: ServerResponse,
  ownerId: string,
  service: PublishPreparationService,
  publisher?: () => VercelPublishService,
): Promise<boolean> {
  const prepare = PREPARE.exec(path);
  const status = STATUS.exec(path);
  const publish = PUBLISH.exec(path);
  const publishStatus = PUBLISH_STATUS.exec(path);
  if (!prepare && !status && !publish && !publishStatus) return false;
  try {
    if ((publish || publishStatus) && !publisher) {
      json(res, 404, { error: { code: "NOT_FOUND", message: "Publishing endpoint not found" } });
      return true;
    }
    if (publish && method === "POST") {
      json(res, 202, { publish: await publisher!().publish(ownerId, param(publish[1]!), param(publish[2]!)) });
      return true;
    }
    if (publishStatus && method === "GET") {
      json(res, 200, { publish: await publisher!().status(ownerId, param(publishStatus[1]!)) });
      return true;
    }
    if (prepare && method === "POST") {
      json(res, 202, { preparation: await service.prepare(ownerId, param(prepare[1]!), param(prepare[2]!)) });
      return true;
    }
    if (status && method === "GET") {
      json(res, 200, { preparation: (await service.latest(ownerId, param(status[1]!))) ?? null });
      return true;
    }
    json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
    return true;
  } catch (error) {
    if (error instanceof PublishingError) {
      json(res, error.httpStatus, { error: { code: error.code, message: error.message, retryable: error.retryable } });
      return true;
    }
    const code = (error as { code?: unknown })?.code;
    // A foreign site is indistinguishable from a missing one.
    if (code === "SITE_NOT_FOUND" || code === "VERSION_NOT_FOUND") {
      json(res, 404, { error: { code, message: code === "SITE_NOT_FOUND" ? "Site not found" : "Version not found" } });
      return true;
    }
    if (code === "AUTHENTICATION_REQUIRED") {
      json(res, 401, { error: { code, message: "Authentication required" } });
      return true;
    }
    console.error("[sites][publish] preparation route failed", { name: (error as Error)?.name });
    json(res, 500, { error: { code: "PUBLISH_PREPARATION_FAILED", message: "Publishing preparation failed" } });
    return true;
  }
}
