import { resolve } from "node:path";
export interface PersistenceConfig {
  readonly provider: "memory" | "sqlite";
  readonly sqlitePath: string;
}
export function loadPersistenceConfig(env: NodeJS.ProcessEnv = process.env): PersistenceConfig {
  const provider = env.PERSISTENCE_PROVIDER?.toLowerCase() ?? "sqlite";
  if (provider !== "memory" && provider !== "sqlite")
    throw new Error(`Unsupported persistence provider: ${provider}`);
  return { provider, sqlitePath: resolve(env.SQLITE_DB_PATH?.trim() || ".local-data/sites.db") };
}
