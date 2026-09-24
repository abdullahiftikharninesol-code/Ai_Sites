export interface PersistenceConfig {
  readonly provider: "mongodb";
  readonly databaseUri?: string;
}
export function loadPersistenceConfig(env: NodeJS.ProcessEnv = process.env): PersistenceConfig {
  const databaseUri = env.DATABASE?.trim();
  return { provider: "mongodb", ...(databaseUri ? { databaseUri } : {}) };
}

export function requireMongoDatabaseUri(config: PersistenceConfig): string {
  if (!config.databaseUri)
    throw new Error("MongoDB persistence requires DATABASE to be configured");
  return config.databaseUri;
}
