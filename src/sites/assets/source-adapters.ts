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

export interface AssetSourceAdapter {
  readonly id: string;
  readonly sourceType: AssetSourceType;
  readonly available: boolean;
  resolve(intent: AssetIntent, budget: AssetProviderBudget): Promise<AssetCandidate | undefined>;
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
}

export interface StockImageProvider {
  readonly id: string;
  readonly configured: boolean;
  search(request: { readonly description: string; readonly purpose: string }, budget: AssetProviderBudget): Promise<readonly StockImageResult[]>;
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

export class AdapterBackedAssetResolver {
  private readonly resolver: DeterministicAssetResolver;
  constructor(
    mediaStore: MediaStore,
    private readonly adapters: readonly AssetSourceAdapter[],
    private readonly policy: AssetSourcePolicy = DEFAULT_ASSET_SOURCE_POLICY,
  ) { this.resolver = new Resolver(mediaStore); }

  async resolve(intents: readonly AssetIntent[], budget = new AssetProviderBudget()) {
    const candidates: AssetCandidate[] = [];
    for (const intent of intents) {
      const preferred = intent.sourcePreference ?? this.policy.allowedSources;
      const sources = this.policy.allowedSources.filter((source) => preferred.includes(source));
      for (const source of sources) {
        const adapter = this.adapters.find((candidate) => candidate.sourceType === source && candidate.available);
        if (!adapter) continue;
        if (source === "GENERATED" || source === "STOCK") budget.reserve("PROVIDER");
        const candidate = await adapter.resolve(intent, budget);
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
