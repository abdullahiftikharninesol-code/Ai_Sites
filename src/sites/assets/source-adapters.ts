import { ApplicationError } from "../../app/errors/application-error.js";
import { createAssetManifest, createResolvedAsset, type AssetIntent, type AssetSourceType } from "./asset-domain.js";
import type { AssetCandidate, DeterministicAssetResolver, MediaStore } from "./media-store.js";
import { DeterministicAssetResolver as Resolver, PLACEHOLDER_PNG } from "./media-store.js";

export interface AssetProviderBudgetSnapshot {
  readonly providerRequests: number;
  readonly downloads: number;
  readonly generatedImages: number;
  readonly bytesDownloaded: number;
}

export class AssetProviderBudget {
  #providerRequests = 0;
  #downloads = 0;
  #generatedImages = 0;
  #bytesDownloaded = 0;
  constructor(private readonly limits: { readonly maxProviderRequests?: number; readonly maxDownloads?: number; readonly maxGeneratedImages?: number; readonly maxBytesDownloaded?: number } = {}) {}
  reserve(kind: "PROVIDER" | "DOWNLOAD" | "GENERATED", bytes = 0): void {
    if (kind === "PROVIDER") {
      if (++this.#providerRequests > (this.limits.maxProviderRequests ?? 8)) throw new ApplicationError("ASSET_LIMIT_EXCEEDED", "Asset provider request budget exceeded");
    } else if (kind === "DOWNLOAD") {
      if (++this.#downloads > (this.limits.maxDownloads ?? 8)) throw new ApplicationError("ASSET_LIMIT_EXCEEDED", "Asset download budget exceeded");
      this.#bytesDownloaded += bytes;
    } else {
      if (++this.#generatedImages > (this.limits.maxGeneratedImages ?? 4)) throw new ApplicationError("ASSET_LIMIT_EXCEEDED", "Generated image budget exceeded");
    }
    if (this.#bytesDownloaded > (this.limits.maxBytesDownloaded ?? 40 * 1024 * 1024)) throw new ApplicationError("ASSET_LIMIT_EXCEEDED", "Asset byte budget exceeded");
  }
  snapshot(): AssetProviderBudgetSnapshot {
    return { providerRequests: this.#providerRequests, downloads: this.#downloads, generatedImages: this.#generatedImages, bytesDownloaded: this.#bytesDownloaded };
  }
}

/** Site-level context a remote source may use to find relevant media. */
export interface AssetResolutionContext {
  /** The user's request for this generation or edit. */
  readonly requestText?: string;
  /** What the site is about (project description, site type). */
  readonly subjectText?: string;
  /** Provider photos already used by this site, so a new pick is never a duplicate. */
  readonly excludeProviderAssetIds?: readonly string[];
}

/** State shared by every intent resolved in one call: duplicate prevention and search caching. */
export class AssetResolutionSession {
  readonly usedProviderAssetIds: Set<string>;
  readonly #searches = new Map<string, Promise<readonly StockImageResult[]>>();
  constructor(readonly context: AssetResolutionContext = {}) {
    this.usedProviderAssetIds = new Set(context.excludeProviderAssetIds ?? []);
  }
  /** One provider request per distinct search, however many intents share it. */
  search(key: string, run: () => Promise<readonly StockImageResult[]>): Promise<readonly StockImageResult[]> {
    let pending = this.#searches.get(key);
    if (!pending) {
      pending = run();
      this.#searches.set(key, pending);
    }
    return pending;
  }
}

export interface AssetSourceAdapter {
  readonly id: string;
  readonly sourceType: AssetSourceType;
  readonly available: boolean;
  resolve(intent: AssetIntent, budget: AssetProviderBudget, session?: AssetResolutionSession): Promise<AssetCandidate | undefined>;
}

export interface GeneratedImageRequest {
  readonly description: string;
  readonly purpose: string;
  readonly aspectRatio?: { readonly width: number; readonly height: number };
  readonly sizeClass?: "SMALL" | "MEDIUM" | "LARGE";
  readonly styleHints?: readonly string[];
}

export interface GeneratedImageProvider {
  readonly id: string;
  readonly configured: boolean;
  generate(request: GeneratedImageRequest, budget: AssetProviderBudget): Promise<AssetCandidate>;
}

export interface StockImageResult {
  readonly providerId: string;
  readonly providerAssetId: string;
  readonly previewUrl?: string;
  readonly sourceUrl?: string;
  readonly author?: string;
  readonly license?: string;
  readonly attribution?: string;
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
  /** Provider-reported original dimensions. */
  readonly width?: number;
  readonly height?: number;
  /** Provider-written description of the photo, used as alt text. */
  readonly alt?: string;
  /** Provider-hosted renditions by size name. */
  readonly downloadUrls?: Readonly<Record<string, string>>;
}

export type StockImageOrientation = "landscape" | "portrait" | "square";

export interface StockImageSearchRequest {
  readonly description: string;
  readonly purpose: string;
  readonly query?: string;
  readonly orientation?: StockImageOrientation;
}

export interface DownloadedStockImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

export interface StockImageProvider {
  readonly id: string;
  readonly configured: boolean;
  search(request: StockImageSearchRequest, budget: AssetProviderBudget): Promise<readonly StockImageResult[]>;
  /** Downloads and validates one result's bytes from the provider's own image host. */
  download?(result: StockImageResult, rendition: string, budget: AssetProviderBudget): Promise<DownloadedStockImage>;
}

export class MapAssetSourceAdapter implements AssetSourceAdapter {
  readonly available = true;
  constructor(
    readonly id: string,
    readonly sourceType: Extract<AssetSourceType, "USER_UPLOAD" | "SYSTEM">,
    private readonly candidates: ReadonlyMap<string, AssetCandidate>,
  ) {}
  async resolve(intent: AssetIntent, _budget: AssetProviderBudget): Promise<AssetCandidate | undefined> {
    return this.candidates.get(intent.logicalAssetId) ?? this.candidates.get(intent.intentId);
  }
}

/** Neutral, deterministic local fallback for an otherwise unresolved image. */
export class PlaceholderAssetSourceAdapter implements AssetSourceAdapter {
  readonly id = "sites-placeholder";
  readonly sourceType = "PLACEHOLDER" as const;
  readonly available = true;
  async resolve(intent: AssetIntent, _budget: AssetProviderBudget): Promise<AssetCandidate> {
    return { intentId: intent.intentId, bytes: PLACEHOLDER_PNG, contentType: "image/png", sourceType: "PLACEHOLDER" };
  }
}

export class UnavailableAssetSourceAdapter implements AssetSourceAdapter {
  readonly available = false;
  constructor(readonly id: string, readonly sourceType: Extract<AssetSourceType, "GENERATED" | "STOCK">) {}
  async resolve(_intent: AssetIntent, _budget: AssetProviderBudget): Promise<undefined> { return undefined; }
}

export interface AssetSourcePolicy {
  readonly allowedSources: readonly AssetSourceType[];
}

export const DEFAULT_ASSET_SOURCE_POLICY: AssetSourcePolicy = Object.freeze({
  allowedSources: ["USER_UPLOAD", "GENERATED", "STOCK", "SYSTEM", "PLACEHOLDER"] as const,
});

/** Per-resolution bounds: enough for an image-rich page (hero plus several 4-image sections). */
export const DEFAULT_RESOLUTION_LIMITS = Object.freeze({ maxProviderRequests: 12, maxDownloads: 16 });

export class AdapterBackedAssetResolver {
  private readonly resolver: DeterministicAssetResolver;
  constructor(
    mediaStore: MediaStore,
    private readonly adapters: readonly AssetSourceAdapter[],
    private readonly policy: AssetSourcePolicy = DEFAULT_ASSET_SOURCE_POLICY,
  ) { this.resolver = new Resolver(mediaStore); }

  async resolve(
    intents: readonly AssetIntent[],
    budget = new AssetProviderBudget(DEFAULT_RESOLUTION_LIMITS),
    context: AssetResolutionContext = {},
  ) {
    const session = new AssetResolutionSession(context);
    const candidates: AssetCandidate[] = [];
    for (const intent of intents) {
      const preferred = intent.sourcePreference ?? this.policy.allowedSources;
      const sources = this.policy.allowedSources.filter((source) => preferred.includes(source));
      for (const source of sources) {
        const adapter = this.adapters.find((candidate) => candidate.sourceType === source && candidate.available);
        if (!adapter) continue;
        let candidate: AssetCandidate | undefined;
        try {
          // Stock adapters reserve per real provider request and download themselves.
          if (source === "GENERATED") budget.reserve("PROVIDER");
          candidate = await adapter.resolve(intent, budget, session);
        } catch (cause) {
          // Remote media is best effort: an unavailable provider or an exhausted
          // budget falls through to the next source (ultimately the placeholder).
          if (source !== "GENERATED" && source !== "STOCK") throw cause;
          continue;
        }
        if (candidate) {
          candidates.push(candidate);
          break;
        }
      }
    }
    const manifest = await this.resolver.resolve(intents, candidates);
    return createAssetManifest({
      manifestVersion: manifest.manifestVersion,
      assets: manifest.assets.map((asset) => asset.sourceType === "PLACEHOLDER" ? createResolvedAsset({ ...asset, status: "FALLBACK" }) : asset),
    });
  }
}
