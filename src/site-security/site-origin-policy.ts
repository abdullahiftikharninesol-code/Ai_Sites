import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteId } from "../shared/types.js";
export interface SiteOriginPolicy {
  isAllowed(siteId: SiteId, origin: string): boolean | Promise<boolean>;
}

import type { CustomDomainRepository } from "../domains/custom-domain-repository.js";
export class DomainAwareSiteOriginPolicy implements SiteOriginPolicy {
  constructor(
    private readonly domains: CustomDomainRepository,
    private readonly fallback?: SiteOriginPolicy,
  ) {}
  async isAllowed(siteId: SiteId, origin: string): Promise<boolean> {
    if (await this.fallback?.isAllowed(siteId, origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) return false;
    const domain = await this.domains.findByHostname(url.hostname.toLowerCase());
    return domain?.siteId === siteId && domain.status === "ACTIVE";
  }
}
export class ConfiguredSiteOriginPolicy implements SiteOriginPolicy {
  constructor(
    private readonly origins: ReadonlyMap<string, readonly string[]>,
    private readonly developmentOrigins: readonly string[] = [],
  ) {}
  isAllowed(siteId: SiteId, origin: string): boolean {
    try {
      new URL(origin);
    } catch {
      return false;
    }
    return [...(this.origins.get(siteId) ?? []), ...this.developmentOrigins].includes(origin);
  }
  assert(siteId: SiteId, origin?: string): void {
    if (!origin || !this.isAllowed(siteId, origin))
      throw new ApplicationError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
  }
}
