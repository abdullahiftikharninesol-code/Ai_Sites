import { createPexelsStockImageProvider } from "./pexels-stock-provider.js";
import { createPixabayStockImageProvider } from "./pixabay-stock-provider.js";
import type { StockImageProvider } from "./source-adapters.js";
import type { StockSearchCache } from "./stock-search-cache.js";

export interface StockImageProviderOptions {
  readonly fetch?: typeof fetch;
  readonly logger?: Pick<Console, "warn">;
  /** Pixabay's 24-hour search cache (shared across instances in production). */
  readonly searchCache?: StockSearchCache;
}

/**
 * The configured stock photo providers in the order they are tried:
 * Pixabay first, then Pexels. Empty when neither is enabled.
 */
export function createStockImageProviders(
  env: NodeJS.ProcessEnv = process.env,
  options: StockImageProviderOptions = {},
): StockImageProvider[] {
  const shared = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.logger ? { logger: options.logger } : {}) };
  const pixabay = createPixabayStockImageProvider(env, { ...shared, ...(options.searchCache ? { searchCache: options.searchCache } : {}) });
  const pexels = createPexelsStockImageProvider(env, shared);
  return [pixabay, pexels].filter((provider): provider is NonNullable<typeof provider> => Boolean(provider));
}
