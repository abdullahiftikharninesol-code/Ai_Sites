import { ApplicationError } from "../../app/errors/application-error.js";
import type { AssetIntent } from "./asset-domain.js";
import type { AssetCandidate } from "./media-store.js";
import {
  AssetResolutionSession,
  type AssetProviderBudget,
  type AssetSourceAdapter,
  type StockImageProvider,
  type StockImageResult,
} from "./source-adapters.js";
import { stockQueryForIntent, type StockQueryPlan } from "./stock-image-query.js";

/** At most this many downloads are tried for one image per provider before moving on. */
const MAX_DOWNLOAD_ATTEMPTS = 2;

const suits = (result: StockImageResult, plan: StockQueryPlan) =>
  !result.width || !result.height || Math.min(result.width, result.height) >= plan.minShortSide;

/** Provider-qualified so photo ids from different providers never collide. */
export const stockPhotoKey = (providerId: string, providerAssetId: string) => `${providerId}:${providerAssetId}`;

/** Providers whose search failed in a session are not asked again in that session. */
const unavailableProviders = new WeakMap<AssetResolutionSession, Set<string>>();

/**
 * Resolves image intents with relevant stock photos from the configured
 * providers in priority order: one cached search per distinct query, never the
 * same photo twice on a site, and no candidate at all (so the placeholder is
 * used) when no provider can supply a suitable photo.
 */
export class StockAssetSourceAdapter implements AssetSourceAdapter {
  readonly sourceType = "STOCK" as const;
  readonly id: string;
  readonly #providers: readonly StockImageProvider[];

  constructor(providers: StockImageProvider | readonly StockImageProvider[]) {
    this.#providers = Array.isArray(providers) ? providers : [providers as StockImageProvider];
    this.id = `stock-${this.#providers.map((provider) => provider.id).join("+")}`;
  }

  get available(): boolean {
    return this.#providers.some(usable);
  }

  async resolve(intent: AssetIntent, budget: AssetProviderBudget, session = new AssetResolutionSession()): Promise<AssetCandidate | undefined> {
    const plan = stockQueryForIntent(intent, session.context);
    if (!plan) return undefined;
    let down = unavailableProviders.get(session);
    if (!down) unavailableProviders.set(session, down = new Set());
    for (const provider of this.#providers) {
      if (!usable(provider) || down.has(provider.id)) continue;
      const outcome = await this.#resolveWith(provider, intent, plan, budget, session);
      if (outcome === "unavailable") down.add(provider.id);
      else if (outcome === "budget") return undefined; // shared limits are spent: placeholder
      else if (outcome) return outcome;
    }
    return undefined;
  }

  async #resolveWith(
    provider: StockImageProvider,
    intent: AssetIntent,
    plan: StockQueryPlan,
    budget: AssetProviderBudget,
    session: AssetResolutionSession,
  ): Promise<AssetCandidate | "unavailable" | "budget" | undefined> {
    let attempts = 0;
    for (const query of plan.queries) {
      let results: readonly StockImageResult[];
      try {
        results = await session.search(`${provider.id}|${plan.orientation}|${query}`, () =>
          provider.search({ description: intent.description, purpose: intent.purpose, query, orientation: plan.orientation }, budget));
      } catch (cause) {
        return cause instanceof ApplicationError ? "budget" : "unavailable";
      }
      for (const result of results) {
        const key = stockPhotoKey(provider.id, result.providerAssetId);
        const used = session.usedProviderAssetIds;
        if (used.has(key) || used.has(result.providerAssetId) || !suits(result, plan)) continue;
        if (attempts >= MAX_DOWNLOAD_ATTEMPTS) return undefined;
        attempts += 1;
        // Claimed before downloading so concurrent picks never share a photo.
        used.add(key);
        try {
          const image = await provider.download!(result, plan.rendition, budget);
          if (Math.min(image.width, image.height) < plan.minShortSide) continue;
          return {
            intentId: intent.intentId,
            bytes: image.bytes,
            contentType: image.contentType,
            sourceType: "STOCK",
            width: image.width,
            height: image.height,
            ...(result.alt ? { altText: result.alt } : {}),
            provenance: {
              providerId: result.providerId,
              providerAssetId: result.providerAssetId,
              ...(result.sourceUrl ? { originalSourceUrl: result.sourceUrl } : {}),
              ...(result.author ? { author: result.author } : {}),
              ...(result.license ? { license: result.license } : {}),
              ...(result.attribution ? { attribution: result.attribution } : {}),
              retrievedAt: new Date().toISOString(),
            },
          };
        } catch (cause) {
          if (cause instanceof ApplicationError) return "budget"; // download budget exhausted
        }
      }
    }
    return undefined;
  }
}

function usable(provider: StockImageProvider): boolean {
  return provider.configured && typeof provider.download === "function";
}
