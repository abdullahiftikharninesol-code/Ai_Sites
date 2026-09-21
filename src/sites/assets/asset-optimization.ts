import type { ResolvedAsset } from "./asset-domain.js";

export interface AssetOptimizationResult {
  readonly asset: ResolvedAsset;
  readonly bytes: Uint8Array;
  readonly optimized: boolean;
}

export interface AssetOptimizer {
  optimize(asset: ResolvedAsset, bytes: Uint8Array): Promise<AssetOptimizationResult>;
}

/** Stable pass-through until a reviewed image encoder is introduced. */
export class PassthroughAssetOptimizer implements AssetOptimizer {
  async optimize(asset: ResolvedAsset, bytes: Uint8Array): Promise<AssetOptimizationResult> {
    return { asset, bytes, optimized: false };
  }
}
