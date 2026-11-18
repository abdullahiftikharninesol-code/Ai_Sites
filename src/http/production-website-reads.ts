import type { Connection } from "mongoose";
import type { MongoSiteProjectRecord } from "../persistence/mongodb/mongo-models.js";
import { MongoRuntimeState, projectFrom, versionFrom } from "../persistence/mongodb/mongo-repositories.js";
import type { ProductionRoute } from "./production-http-routes.js";

/** Queries expose no writes, artifacts, runtime providers or publication reconciliation. No model registration. */
export interface WebsiteReadRepository {
  listByOwner(ownerId: string): Promise<readonly MongoSiteProjectRecord[]>;
  getOwnedById(siteId: string, ownerId: string): Promise<MongoSiteProjectRecord | undefined>;
}
export const WEBSITE_READ_LIMIT = 1_000;
export const WEBSITE_METADATA_PROJECTION = Object.freeze({
  _id: 1, ownerId: 1, name: 1, status: 1, versionNumber: 1, createdAt: 1, updatedAt: 1,
} as const);

/** Reuses the existing repository's owner-filter contract and pure mapping, without its broad reads/model initialization. */
export function mongoWebsiteReads(connection: Pick<Connection, "db">): WebsiteReadRepository {
  const projects = () => {
    if (!connection.db) throw new Error("Website database is unavailable");
    return connection.db.collection<MongoSiteProjectRecord>("sites_projects");
  };
  return {
    async listByOwner(ownerId) {
      const rows = await projects().find({ ownerId }, { projection: WEBSITE_METADATA_PROJECTION, maxTimeMS: 5_000 })
        .sort({ updatedAt: -1, _id: 1 }).limit(WEBSITE_READ_LIMIT + 1).toArray();
      if (rows.length > WEBSITE_READ_LIMIT) throw new Error("Website read limit exceeded");
      return rows;
    },
    async getOwnedById(siteId, ownerId) {
      const row = await projects().findOne({ _id: siteId, ownerId }, { projection: WEBSITE_METADATA_PROJECTION, maxTimeMS: 5_000 });
      return row ?? undefined;
    },
  };
}

const notFound = () => Object.assign(new Error("Site not found"), { code: "SITE_NOT_FOUND" });
export const validSiteId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);

/** Frontend-compatible current-only views. Optional runtime/preview/hosting data is not queried or invented. */
export function productionWebsiteRoutes(repository: WebsiteReadRepository): readonly ProductionRoute[] {
  const state = new MongoRuntimeState(); // Empty read-side mapping state; no local publication or runtime services.
  const owned = (record: MongoSiteProjectRecord | undefined, ownerId: string) => {
    if (!record || record.ownerId !== ownerId) throw notFound();
    if (!validSiteId(record._id) || !Number.isSafeInteger(record.versionNumber) || record.versionNumber < 0 ||
      typeof record.name !== "string" || !["DRAFT", "ACTIVE", "ARCHIVED"].includes(record.status) ||
      !Number.isFinite(new Date(record.createdAt).getTime()) || !Number.isFinite(new Date(record.updatedAt).getTime()))
      throw new Error("Invalid website metadata");
    return record;
  };
  return [
    { access: "authenticated", method: "GET", path: "/api/dev/sites", handle: async ({ ownerId, response }) => {
      const rows = await repository.listByOwner(ownerId);
      const sites = rows.map(row => {
        const project = projectFrom(owned(row, ownerId), state);
        return { projectId: project.id, name: project.name, slug: project.slug,
          ...(row.versionNumber > 0 ? { latestVersion: row.versionNumber } : {}),
          createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString() };
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ sites }));
    } },
    { access: "authenticated", method: "GET", path: "/api/dev/sites/:siteId", handle: async ({ ownerId, params, response }) => {
      const siteId = params.siteId!;
      if (!validSiteId(siteId)) throw notFound();
      const record = owned(await repository.getOwnedById(siteId, ownerId), ownerId);
      if (record._id !== siteId) throw notFound();
      const project = projectFrom(record, state), current = record.versionNumber > 0 ? versionFrom(record) : undefined;
      const result = {
        project: { projectId: project.id, name: project.name, slug: project.slug, status: project.status,
          ...(project.latestVersionId ? { latestVersionId: project.latestVersionId } : {}),
          createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString() },
        capabilities: { runtime: false, collections: [], auth: false, actions: [] },
        versions: current ? [{ versionId: current.id, versionNumber: current.versionNumber, createdAt: current.createdAt.toISOString(),
          buildStatus: current.buildStatus, browserQAStatus: current.browserQAStatus, published: false }] : [],
        deployments: [], domains: [],
      };
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(result));
    } },
  ];
}
