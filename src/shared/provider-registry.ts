import { ProviderNotAvailableError } from "../app/errors/application-error.js";
export class ProviderRegistry<T extends { readonly id: string }> {
  readonly #providers = new Map<string, T>();
  constructor(readonly kind: string) {}
  register(provider: T): void {
    if (this.#providers.has(provider.id))
      throw new Error(`${this.kind} provider '${provider.id}' is already registered`);
    this.#providers.set(provider.id, provider);
  }
  get(id: string): T {
    const provider = this.#providers.get(id);
    if (!provider) throw new ProviderNotAvailableError(this.kind, id);
    return provider;
  }
  has(id: string): boolean {
    return this.#providers.has(id);
  }
  list(): readonly T[] {
    return [...this.#providers.values()];
  }
}
