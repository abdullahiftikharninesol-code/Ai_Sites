/* eslint-disable @typescript-eslint/require-await -- in-memory adapter follows async repository contract */
import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteId } from "../shared/types.js";
import type { CustomDomain, CustomDomainStatus } from "./custom-domain.js";
import type { CustomDomainRepository } from "./custom-domain-repository.js";
export class InMemoryCustomDomainRepository implements CustomDomainRepository {
  readonly #items = new Map<string, CustomDomain>();
  async create(domain: CustomDomain) {
    if (await this.findByHostname(domain.hostname))
      throw new ApplicationError(
        "CUSTOM_DOMAIN_ALREADY_EXISTS",
        "Custom hostname is already registered",
      );
    this.#items.set(domain.id, structuredClone(domain));
  }
  async findById(id: string) {
    const value = this.#items.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async findByHostname(hostname: string) {
    const value = [...this.#items.values()].find((item) => item.hostname === hostname);
    return value ? structuredClone(value) : undefined;
  }
  async listForSite(siteId: SiteId) {
    return [...this.#items.values()]
      .filter((item) => item.siteId === siteId)
      .map((item) => structuredClone(item));
  }
  async transition(
    id: string,
    from: readonly CustomDomainStatus[],
    next: CustomDomainStatus,
    changes = {},
  ) {
    const current = this.#items.get(id);
    if (!current)
      throw new ApplicationError("CUSTOM_DOMAIN_NOT_FOUND", "Custom domain was not found");
    if (!from.includes(current.status))
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Invalid custom-domain transition");
    const updated = { ...current, ...changes, status: next, updatedAt: new Date() };
    this.#items.set(id, updated);
    return structuredClone(updated);
  }
}
