import { ApplicationError } from "../../app/errors/application-error.js";

export interface CircuitState {
  readonly open: boolean;
  readonly reason?: string;
  readonly trippedAt?: number;
}

export class CircuitBreaker {
  readonly #circuits = new Map<string, CircuitState>();

  #routeKey(provider: string, model?: string): string {
    return model ? `${provider}::${model}` : provider;
  }

  isOpen(provider: string, model?: string): boolean {
    const specific = this.#circuits.get(this.#routeKey(provider, model));
    if (specific?.open) return true;
    const providerWide = this.#circuits.get(provider);
    return providerWide?.open ?? false;
  }

  isAvailable(provider: string, model?: string): boolean {
    return !this.isOpen(provider, model);
  }

  recordQuotaExhaustion(provider: string, category: string, model?: string): void {
    this.trip(provider, category, model);
  }

  getTripReason(provider: string, model?: string): string | undefined {
    const specific = this.#circuits.get(this.#routeKey(provider, model));
    if (specific?.open) return specific.reason;
    const providerWide = this.#circuits.get(provider);
    return providerWide?.reason;
  }

  trip(provider: string, reason: string, model?: string): void {
    const key = model ? this.#routeKey(provider, model) : provider;
    this.#circuits.set(key, {
      open: true,
      reason,
      trippedAt: Date.now(),
    });
    // If it's a provider-wide exhaustion (e.g. billing or project daily quota), also record on the base provider
    if (/daily quota|billing|project quota/i.test(reason)) {
      this.#circuits.set(provider, {
        open: true,
        reason,
        trippedAt: Date.now(),
      });
    }
  }

  assertAvailable(provider: string, model?: string): void {
    if (this.isOpen(provider, model)) {
      const reason = this.getTripReason(provider, model) ?? "Provider route is currently unavailable due to exhausted quota";
      throw new ApplicationError("PROVIDER_NOT_AVAILABLE", `Circuit breaker open for ${provider}${model ? ` (${model})` : ""}: ${reason}`, {
        metadata: {
          provider,
          ...(model ? { model } : {}),
          circuitOpen: true,
          reason,
        },
      });
    }
  }

  reset(provider?: string, model?: string): void {
    if (provider && model) {
      this.#circuits.delete(this.#routeKey(provider, model));
    } else if (provider) {
      for (const key of Array.from(this.#circuits.keys())) {
        if (key === provider || key.startsWith(`${provider}::`)) {
          this.#circuits.delete(key);
        }
      }
    } else {
      this.#circuits.clear();
    }
  }
}

export const defaultCircuitBreaker = new CircuitBreaker();
