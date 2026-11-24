import type {
  AssetProviderBudget,
  DownloadedStockImage,
  StockImageOrientation,
  StockImageProvider,
  StockImageResult,
  StockImageSearchRequest,
} from "./source-adapters.js";
import {
  cleanText,
  downloadStockImage,
  isRetryableStatus,
  positiveInt,
  safeHttpsUrl,
  sanitizeStockError,
  StockRequestError,
  stockWarning,
  withRetries,
} from "./stock-http.js";
import { InMemoryStockSearchCache, STOCK_SEARCH_CACHE_TTL_MS, stockSearchCacheKey, type StockSearchCache } from "./stock-search-cache.js";

/**
 * Pixabay stock photos (https://pixabay.com/api/docs/).
 * Off unless SITES_PIXABAY_ENABLED=true and PIXABAY_API_KEY are both set.
 * The API key travels as a query parameter, so request URLs are never logged
 * or placed in errors, and cache keys are built from the search terms alone.
 * Search responses are cached for 24 hours, as Pixabay requires, and images
 * are downloaded to Sites storage rather than hotlinked.
 */

export const PIXABAY_LICENSE = "Pixabay Content License (https://pixabay.com/service/license-summary/)";
const SEARCH_URL = "https://pixabay.com/api/";
const IMAGE_HOSTS = new Set(["pixabay.com", "cdn.pixabay.com"]);
const PAGE_HOST = /^(?:www\.)?pixabay\.com$/i;
/** Pixabay's documented longest side for largeImageURL and webformatURL. */
const LARGE_SIDE = 1280;
const WEBFORMAT_SIDE = 640;

export interface PixabayConfig {
  readonly enabled: boolean;
  readonly apiKey?: string;
}

export function loadPixabayConfig(env: NodeJS.ProcessEnv = process.env): PixabayConfig {
  const apiKey = env.PIXABAY_API_KEY?.trim();
  return env.SITES_PIXABAY_ENABLED?.trim().toLowerCase() === "true" && apiKey ? { enabled: true, apiKey } : { enabled: false };
}

export interface PixabayProviderOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  /** 24-hour search cache, shared across instances in production; per-process when omitted. */
  readonly searchCache?: StockSearchCache;
  readonly searchTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxBytes?: number;
  /** Extra attempts after a timeout, network error, 429 or 5xx. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly perPage?: number;
  readonly logger?: Pick<Console, "warn">;
  readonly now?: () => number;
}

/** Image links must stay on Pixabay's own hosts and never carry a key. */
const imageUrl = (value: unknown) => {
  const url = safeHttpsUrl(value, (hostname) => IMAGE_HOSTS.has(hostname));
  return url && !new URL(url).searchParams.has("key") ? url : undefined;
};

const ORIENTATION: Record<StockImageOrientation, "horizontal" | "vertical" | "all"> = {
  landscape: "horizontal",
  portrait: "vertical",
  square: "all",
};

/** Large enough originals that the 1280px rendition is full size on the long side. */
const MIN_ORIGINAL: Record<"horizontal" | "vertical" | "all", Record<string, string>> = {
  horizontal: { min_width: String(LARGE_SIDE) },
  vertical: { min_height: String(LARGE_SIDE) },
  all: { min_width: "960", min_height: "960" },
};

const scaled = (width: number, height: number, side: number) => {
  const scale = Math.min(1, side / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

/** Accepts only well-formed photos whose links point at Pixabay itself. */
function parseHits(body: unknown): StockImageResult[] {
  const hits = (body as { hits?: unknown } | undefined)?.hits;
  if (!Array.isArray(hits)) throw new StockRequestError(undefined, false, "Pixabay search returned an unexpected response");
  const results: StockImageResult[] = [];
  for (const hit of hits as Array<Record<string, unknown>>) {
    if (!hit || typeof hit !== "object") continue;
    const id = typeof hit.id === "number" || typeof hit.id === "string" ? String(hit.id) : "";
    const width = positiveInt(hit.imageWidth), height = positiveInt(hit.imageHeight);
    const page = safeHttpsUrl(hit.pageURL, (hostname) => PAGE_HOST.test(hostname));
    const large = imageUrl(hit.largeImageURL), webformat = imageUrl(hit.webformatURL);
    if (!/^\d{1,20}$/.test(id) || !width || !height || !page || !(large || webformat)) continue;
    if (typeof hit.type === "string" && hit.type !== "photo") continue;
    const user = cleanText(hit.user, 200);
    // Reported size is the rendition that will be downloaded, not the original.
    const size = scaled(width, height, large ? LARGE_SIDE : WEBFORMAT_SIDE);
    results.push({
      providerId: "pixabay",
      providerAssetId: id,
      sourceUrl: page,
      license: PIXABAY_LICENSE,
      ...(user ? { author: user, attribution: `Image by ${user} from Pixabay` } : { attribution: "Image from Pixabay" }),
      width: size.width,
      height: size.height,
      downloadUrls: { ...(large ? { large } : {}), ...(webformat ? { medium: webformat } : {}) },
    });
  }
  return results;
}

export class PixabayStockImageProvider implements StockImageProvider {
  readonly id = "pixabay";
  readonly configured: boolean;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #cache: StockSearchCache;
  readonly #searchTimeoutMs: number;
  readonly #downloadTimeoutMs: number;
  readonly #maxBytes: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #perPage: number;
  readonly #logger: Pick<Console, "warn">;
  readonly #now: () => number;

  constructor(options: PixabayProviderOptions) {
    this.#apiKey = options.apiKey.trim();
    this.configured = Boolean(this.#apiKey);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#cache = options.searchCache ?? new InMemoryStockSearchCache(500, this.#now);
    this.#searchTimeoutMs = options.searchTimeoutMs ?? 6_000;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? 10_000;
    this.#maxBytes = options.maxBytes ?? 6 * 1024 * 1024;
    this.#retries = Math.max(0, Math.min(options.retries ?? 1, 2));
    this.#retryDelayMs = options.retryDelayMs ?? 400;
    this.#perPage = Math.max(3, Math.min(options.perPage ?? 20, 50));
    this.#logger = options.logger ?? console;
  }

  async search(request: StockImageSearchRequest, budget: AssetProviderBudget): Promise<readonly StockImageResult[]> {
    const query = cleanText(request.query ?? request.description, 100);
    if (!this.configured || !query) return [];
    const orientation = ORIENTATION[request.orientation ?? "landscape"];
    // Everything but the key: these alone identify the search and its cache entry.
    const params: Record<string, string> = {
      q: query,
      image_type: "photo",
      safesearch: "true",
      orientation,
      order: "popular",
      per_page: String(this.#perPage),
      ...MIN_ORIGINAL[orientation],
    };
    const cacheKey = stockSearchCacheKey(this.id, params);
    const cached = await this.#cache.read(cacheKey).catch(() => undefined);
    if (cached) return cached.results.filter((result) => result.providerId === this.id);

    budget.reserve("PROVIDER");
    const url = new URL(SEARCH_URL);
    url.searchParams.set("key", this.#apiKey);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    try {
      const results = await withRetries(this.#searchTimeoutMs, { retries: this.#retries, retryDelayMs: this.#retryDelayMs }, async (signal) => {
        const response = await this.#fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal });
        if (!response.ok) throw new StockRequestError(response.status, isRetryableStatus(response.status), "Pixabay search failed");
        return parseHits(await response.json());
      });
      await this.#cache.write(cacheKey, { results, expiresAt: this.#now() + STOCK_SEARCH_CACHE_TTL_MS }).catch(() => undefined);
      return results;
    } catch (cause) {
      this.#warn("search", cause);
      throw sanitizeStockError(cause);
    }
  }

  async download(result: StockImageResult, rendition: string, budget: AssetProviderBudget): Promise<DownloadedStockImage> {
    try {
      const urls = result.providerId === this.id ? result.downloadUrls : undefined;
      const url = urls?.[rendition] ?? urls?.large ?? urls?.medium;
      if (!url) throw new StockRequestError(undefined, false, "Stock image has no Pixabay download URL");
      return await downloadStockImage({
        fetch: this.#fetch,
        url,
        allowUrl: imageUrl,
        timeoutMs: this.#downloadTimeoutMs,
        maxBytes: this.#maxBytes,
        retries: this.#retries,
        retryDelayMs: this.#retryDelayMs,
        budget,
      });
    } catch (cause) {
      this.#warn("download", cause);
      throw sanitizeStockError(cause);
    }
  }

  /** Status and reason only: never the API key, query or URLs. */
  #warn(stage: "search" | "download", cause: unknown) {
    const message = stockWarning("Pixabay", stage, cause);
    if (message) this.#logger.warn(message);
  }
}

/** The configured provider, or undefined when Pixabay is disabled or has no key. */
export function createPixabayStockImageProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<PixabayProviderOptions, "apiKey"> = {},
): PixabayStockImageProvider | undefined {
  const config = loadPixabayConfig(env);
  return config.enabled && config.apiKey ? new PixabayStockImageProvider({ ...options, apiKey: config.apiKey }) : undefined;
}
