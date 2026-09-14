import { createHash } from "node:crypto";
import type { SitePlan } from "../sites/domain/site-plan.js";

export interface SitePlanCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

interface CacheEntry {
  readonly plan: SitePlan;
  readonly expiresAt: number;
}

export class SitePlanCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  constructor(options: SitePlanCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 100;
    this.#ttlMs = options.ttlMs ?? 3_600_000; // 1 hour default
  }

  static createKey(
    prompt: string,
    options: {
      tenantId?: string;
      model?: string;
      schemaVersion?: string;
    } = {},
  ): string {
    const normalizedPrompt = prompt.trim().toLowerCase().replace(/\s+/g, " ");
    const parts = [
      options.tenantId ?? "default",
      options.schemaVersion ?? "site-plan-v1",
      options.model ?? "default-model",
      normalizedPrompt,
    ];
    return createHash("sha256").update(parts.join("::")).digest("hex");
  }

  get(key: string): SitePlan | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.plan;
  }

  set(key: string, plan: SitePlan): void {
    if (this.#entries.size >= this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey) this.#entries.delete(oldestKey);
    }
    this.#entries.set(key, {
      plan,
      expiresAt: Date.now() + this.#ttlMs,
    });
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

export const defaultSitePlanCache = new SitePlanCache();
