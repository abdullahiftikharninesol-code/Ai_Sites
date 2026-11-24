import type {
  AssetProviderBudget,
  DownloadedStockImage,
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

/**
 * Pexels stock photos (https://www.pexels.com/api/documentation/).
 * Off unless SITES_PEXELS_ENABLED=true and PEXELS_API_KEY are both set.
 * Photos are free to use under the Pexels License; each stored asset keeps the
 * photographer credit and the photo's Pexels page in its provenance.
 */

export const PEXELS_LICENSE = "Pexels License (https://www.pexels.com/license/)";
const SEARCH_URL = "https://api.pexels.com/v1/search";
const IMAGE_HOST = "images.pexels.com";
const PAGE_HOST = /^(?:www\.)?pexels\.com$/i;

export interface PexelsConfig {
  readonly enabled: boolean;
  readonly apiKey?: string;
}

export function loadPexelsConfig(env: NodeJS.ProcessEnv = process.env): PexelsConfig {
  const apiKey = env.PEXELS_API_KEY?.trim();
  return env.SITES_PEXELS_ENABLED?.trim().toLowerCase() === "true" && apiKey ? { enabled: true, apiKey } : { enabled: false };
}

export interface PexelsProviderOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly searchTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxBytes?: number;
  /** Extra attempts after a timeout, network error, 429 or 5xx. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly perPage?: number;
  readonly logger?: Pick<Console, "warn">;
}

const imageUrl = (value: unknown) => safeHttpsUrl(value, (hostname) => hostname === IMAGE_HOST);

/** Accepts only well-formed photos whose links point at Pexels itself. */
function parsePhotos(body: unknown): StockImageResult[] {
  const photos = (body as { photos?: unknown } | undefined)?.photos;
  if (!Array.isArray(photos)) throw new StockRequestError(undefined, false, "Pexels search returned an unexpected response");
  const results: StockImageResult[] = [];
  for (const photo of photos as Array<Record<string, unknown>>) {
    const id = typeof photo.id === "number" || typeof photo.id === "string" ? String(photo.id) : "";
    const width = positiveInt(photo.width), height = positiveInt(photo.height);
    const page = safeHttpsUrl(photo.url, (hostname) => PAGE_HOST.test(hostname));
    const photographer = cleanText(photo.photographer, 200);
    const src = photo.src && typeof photo.src === "object" ? photo.src as Record<string, unknown> : {};
    const downloadUrls = Object.fromEntries(["large2x", "large", "portrait", "landscape", "medium"]
      .flatMap((name) => { const url = imageUrl(src[name]); return url ? [[name, url]] : []; }));
    if (!/^\d{1,20}$/.test(id) || !width || !height || !page || !Object.keys(downloadUrls).length) continue;
    const alt = cleanText(photo.alt, 300);
    results.push({
      providerId: "pexels",
      providerAssetId: id,
      sourceUrl: page,
      license: PEXELS_LICENSE,
      ...(photographer ? { author: photographer, attribution: `Photo by ${photographer} on Pexels` } : { attribution: "Photo from Pexels" }),
      width,
      height,
      ...(alt ? { alt } : {}),
      downloadUrls,
    });
  }
  return results;
}

export class PexelsStockImageProvider implements StockImageProvider {
  readonly id = "pexels";
  readonly configured: boolean;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #searchTimeoutMs: number;
  readonly #downloadTimeoutMs: number;
  readonly #maxBytes: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #perPage: number;
  readonly #logger: Pick<Console, "warn">;

  constructor(options: PexelsProviderOptions) {
    this.#apiKey = options.apiKey.trim();
    this.configured = Boolean(this.#apiKey);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#searchTimeoutMs = options.searchTimeoutMs ?? 6_000;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? 10_000;
    this.#maxBytes = options.maxBytes ?? 6 * 1024 * 1024;
    this.#retries = Math.max(0, Math.min(options.retries ?? 1, 2));
    this.#retryDelayMs = options.retryDelayMs ?? 400;
    this.#perPage = Math.max(1, Math.min(options.perPage ?? 15, 40));
    this.#logger = options.logger ?? console;
  }

  async search(request: StockImageSearchRequest, budget: AssetProviderBudget): Promise<readonly StockImageResult[]> {
    const query = cleanText(request.query ?? request.description, 100);
    if (!this.configured || !query) return [];
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(this.#perPage));
    if (request.orientation) url.searchParams.set("orientation", request.orientation);
    budget.reserve("PROVIDER");
    try {
      return await withRetries(this.#searchTimeoutMs, { retries: this.#retries, retryDelayMs: this.#retryDelayMs }, async (signal) => {
        const response = await this.#fetch(url, { headers: { Authorization: this.#apiKey, Accept: "application/json" }, redirect: "error", signal });
        if (!response.ok) throw new StockRequestError(response.status, isRetryableStatus(response.status), "Pexels search failed");
        return parsePhotos(await response.json());
      });
    } catch (cause) {
      this.#warn("search", cause);
      throw sanitizeStockError(cause);
    }
  }

  async download(result: StockImageResult, rendition: string, budget: AssetProviderBudget): Promise<DownloadedStockImage> {
    try {
      const url = result.providerId === this.id ? result.downloadUrls?.[rendition] ?? result.downloadUrls?.large : undefined;
      if (!url) throw new StockRequestError(undefined, false, "Stock image has no Pexels download URL");
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
    const message = stockWarning("Pexels", stage, cause);
    if (message) this.#logger.warn(message);
  }
}

/** The configured provider, or undefined when Pexels is disabled or has no key. */
export function createPexelsStockImageProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<PexelsProviderOptions, "apiKey"> = {},
): PexelsStockImageProvider | undefined {
  const config = loadPexelsConfig(env);
  return config.enabled && config.apiKey ? new PexelsStockImageProvider({ ...options, apiKey: config.apiKey }) : undefined;
}
