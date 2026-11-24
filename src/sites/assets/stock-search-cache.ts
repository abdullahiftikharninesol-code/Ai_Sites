import { createHash } from "node:crypto";
import type { StockImageResult } from "./source-adapters.js";

/**
 * Stock-search response cache. Pixabay asks API clients to cache search
 * requests for 24 hours; every instance shares the Redis layer so a scaled-out
 * deployment does not repeat a search another instance already made. Entries
 * carry an absolute expiry, so copying one between layers never extends it.
 */

export const STOCK_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface StockSearchCacheEntry {
  readonly results: readonly StockImageResult[];
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export interface StockSearchCache {
  /** A live entry, or undefined on a miss, an expired entry or any cache failure. */
  read(key: string): Promise<StockSearchCacheEntry | undefined>;
  /** Best effort: a failed write never fails the search. */
  write(key: string, entry: StockSearchCacheEntry): Promise<void>;
}

/** A stable cache key from the provider and its search parameters; never includes credentials. */
export function stockSearchCacheKey(providerId: string, params: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(params).sort().map((name) => [name, params[name]]);
  return `${providerId}:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)}`;
}

/** Per-process cache with expiry and a size bound. */
export class InMemoryStockSearchCache implements StockSearchCache {
  readonly #entries = new Map<string, StockSearchCacheEntry>();
  constructor(private readonly maxEntries = 500, private readonly now: () => number = Date.now) {}

  read(key: string): Promise<StockSearchCacheEntry | undefined> {
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt <= this.now()) this.#entries.delete(key);
    return Promise.resolve(entry && entry.expiresAt > this.now() ? entry : undefined);
  }

  write(key: string, entry: StockSearchCacheEntry): Promise<void> {
    if (entry.expiresAt > this.now()) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      while (this.#entries.size > this.maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    }
    return Promise.resolve();
  }
}

export interface StockSearchRedis {
  getString(key: string): Promise<string | undefined>;
  setString(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

/** Shared across instances through Redis with a native TTL. Unavailable Redis is simply a miss. */
export class RedisStockSearchCache implements StockSearchCache {
  readonly #prefix: string;
  #warned = false;
  constructor(
    private readonly redis: StockSearchRedis,
    environment: string,
    private readonly logger: Pick<Console, "warn"> = console,
    private readonly now: () => number = Date.now,
  ) {
    const safeEnvironment = environment.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "development";
    this.#prefix = `sites:${safeEnvironment}:stock-search:v1`;
  }

  async read(key: string) {
    try {
      const value = await this.redis.getString(`${this.#prefix}:${key}`);
      if (value === undefined) return undefined;
      const parsed = JSON.parse(value) as Partial<StockSearchCacheEntry> | null;
      if (!parsed || !Array.isArray(parsed.results) || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= this.now()) return undefined;
      return { results: parsed.results, expiresAt: parsed.expiresAt };
    } catch {
      this.#warn();
      return undefined;
    }
  }

  async write(key: string, entry: StockSearchCacheEntry) {
    const ttlSeconds = Math.floor((entry.expiresAt - this.now()) / 1000);
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.setString(`${this.#prefix}:${key}`, JSON.stringify(entry), ttlSeconds);
    } catch {
      this.#warn();
    }
  }

  #warn() {
    if (this.#warned) return;
    this.#warned = true;
    this.logger.warn("[sites] Stock search cache is unavailable; searching the provider directly");
  }
}

/** Local first, then shared; a shared hit warms the local layer with the same expiry. */
export class LayeredStockSearchCache implements StockSearchCache {
  readonly #layers: readonly StockSearchCache[];
  constructor(...layers: StockSearchCache[]) {
    this.#layers = layers;
  }

  async read(key: string) {
    for (const [index, layer] of this.#layers.entries()) {
      const entry = await layer.read(key).catch(() => undefined);
      if (entry) {
        await Promise.all(this.#layers.slice(0, index).map((earlier) => earlier.write(key, entry).catch(() => undefined)));
        return entry;
      }
    }
    return undefined;
  }

  async write(key: string, entry: StockSearchCacheEntry) {
    await Promise.all(this.#layers.map((layer) => layer.write(key, entry).catch(() => undefined)));
  }
}
