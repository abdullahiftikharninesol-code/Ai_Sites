import { createHash } from "node:crypto";

export const TEMPLATE_CATALOG_CACHE_TTL_SECONDS = 300;

export interface TemplateCatalogRedis {
  getString(key: string): Promise<string | undefined>;
  setString(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  increment(key: string): Promise<number | undefined>;
}

export interface TemplateCacheLogger {
  warn(message: string): void;
}

export class TemplateCatalogCache {
  readonly #prefix: string;
  readonly #generationKey: string;

  constructor(
    private readonly redis: TemplateCatalogRedis,
    environment: string,
    private readonly logger: TemplateCacheLogger = console,
    private readonly ttlSeconds = TEMPLATE_CATALOG_CACHE_TTL_SECONDS,
  ) {
    const safeEnvironment = environment.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "development";
    this.#prefix = `sites:${safeEnvironment}:templates`;
    this.#generationKey = `${this.#prefix}:cache-generation`;
  }

  async generation(): Promise<string> {
    try {
      return (await this.redis.getString(this.#generationKey)) ?? "0";
    } catch {
      this.logger.warn("[sites][templates] Redis catalog cache generation read failed");
      return "0";
    }
  }

  async read<T>(
    kind: "catalog" | "categories" | "detail",
    identity: unknown,
    generation?: string,
  ): Promise<T | undefined> {
    try {
      const resolvedGeneration = generation ?? (await this.generation());
      const value = await this.redis.getString(this.#key(kind, identity, resolvedGeneration));
      return value === undefined ? undefined : (JSON.parse(value) as T);
    } catch {
      this.logger.warn("[sites][templates] Redis catalog cache read failed");
      return undefined;
    }
  }

  async write(
    kind: "catalog" | "categories" | "detail",
    identity: unknown,
    value: unknown,
    generation?: string,
  ): Promise<void> {
    try {
      const resolvedGeneration = generation ?? (await this.generation());
      await this.redis.setString(
        this.#key(kind, identity, resolvedGeneration),
        JSON.stringify(value),
        this.ttlSeconds,
      );
    } catch {
      this.logger.warn("[sites][templates] Redis catalog cache write failed");
    }
  }

  async invalidateTemplateCatalogCache(): Promise<void> {
    try {
      await this.redis.increment(this.#generationKey);
    } catch {
      this.logger.warn("[sites][templates] Redis catalog cache invalidation failed");
    }
  }

  async requireTemplateCatalogCacheInvalidation(): Promise<void> {
    try {
      const generation = await this.redis.increment(this.#generationKey);
      if (generation === undefined) throw new Error("Redis template cache is unavailable");
    } catch (error) {
      this.logger.warn("[sites][templates] Redis catalog cache invalidation failed");
      throw error;
    }
  }

  keyPrefix(): string {
    return this.#prefix;
  }

  #key(kind: string, identity: unknown, generation: string): string {
    const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
    return `${this.#prefix}:${kind}:v${generation}:${digest}`;
  }
}
