import { resolve, join } from "node:path";
import { MongoIdentityRepository } from "../auth/identity-repository.js";
import {
  loadPersistenceConfig,
  requireMongoDatabaseUri,
} from "../persistence/persistence-config.js";
import { createMongoPersistentSitesProduct } from "../sites/generation/create-mongo-persistent-sites-product.js";
import { SitesVersionHttpServer } from "./sites-version-http-server.js";

/** Production composition. Constructing this factory does not start services. */
export function createSitesVersionApi(env: NodeJS.ProcessEnv = process.env) {
  if (!env.JWTKEY?.trim()) throw new Error("JWTKEY is required for the Sites HTTP API");
  const databaseUri = requireMongoDatabaseUri(loadPersistenceConfig(env));
  const dataRoot = resolve(env.SITES_DATA_ROOT ?? ".sites-runtime/playground");
  const product = createMongoPersistentSitesProduct({
    databaseUri,
    artifactRoot: join(dataRoot, "artifacts"),
    executionRoot: join(dataRoot, "execution"),
  });
  const server = new SitesVersionHttpServer({
    host: env.SITES_HTTP_HOST?.trim() || "127.0.0.1",
    port: Number(env.SITES_HTTP_PORT ?? 4312),
    allowedOrigins:
      env.SITES_HTTP_ORIGINS?.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean) ?? [],
    identities: new MongoIdentityRepository(product.database.connection),
    jwtKey: () => env.JWTKEY,
  });
  return {
    server,
    start: async () => {
      try {
        // No blanket legacy migration or playground/hosting/socket startup.
        await product.database.connect();
        return await server.start();
      } catch (error) {
        await product.close();
        throw error;
      }
    },
    close: async () => {
      await server.close();
      await product.close();
    },
  };
}
