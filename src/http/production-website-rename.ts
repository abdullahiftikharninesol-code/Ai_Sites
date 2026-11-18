import type { Connection } from "mongoose";
import type { MongoSiteProjectRecord } from "../persistence/mongodb/mongo-models.js";
import { normalizeSiteRename } from "../sites/application/site-rename.js";
import type { ProductionRoute } from "./production-http-routes.js";
import { validSiteId } from "./production-website-reads.js";

export interface WebsiteRenameRepository {
  renameOwned(siteId: string, ownerId: string, name: string): Promise<boolean>;
}

/** One atomic, owner-fenced update. No upsert, general save, model hooks or unrelated fields. */
export function mongoWebsiteRenames(connection: Pick<Connection, "db">, now: () => Date = () => new Date()): WebsiteRenameRepository {
  return {
    async renameOwned(siteId, ownerId, name) {
      if (!connection.db) throw new Error("Website database is unavailable");
      const result = await connection.db.collection<MongoSiteProjectRecord>("sites_projects").updateOne(
        { _id: siteId, ownerId }, { $set: { name, updatedAt: now() } }, { upsert: false, maxTimeMS: 5_000 },
      );
      if (!result.acknowledged || ![0, 1].includes(result.matchedCount)) throw new Error("Website rename was not confirmed");
      return result.matchedCount === 1;
    },
  };
}

export function productionWebsiteRenameRoute(repository: WebsiteRenameRepository): ProductionRoute {
  return { access: "authenticated", method: "PATCH", path: "/api/dev/sites/:siteId", body: "json",
    handle: async ({ ownerId, params, body, response }) => {
      if (!body || body instanceof Uint8Array || Object.keys(body).length !== 1 || !Object.hasOwn(body, "name"))
        throw Object.assign(new Error("Only a site name may be changed"), { code: "INVALID_REQUEST" });
      const name = normalizeSiteRename(body.name), siteId = params.siteId!;
      if (!validSiteId(siteId) || !await repository.renameOwned(siteId, ownerId, name))
        throw Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ projectId: siteId, name }));
    },
  };
}
