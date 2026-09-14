import type { SiteId } from "../shared/types.js";
import type { CustomDomain, CustomDomainStatus } from "./custom-domain.js";
export interface CustomDomainRepository {
  create(domain: CustomDomain): Promise<void>;
  findById(id: string): Promise<CustomDomain | undefined>;
  findByHostname(hostname: string): Promise<CustomDomain | undefined>;
  listForSite(siteId: SiteId): Promise<readonly CustomDomain[]>;
  transition(
    id: string,
    from: readonly CustomDomainStatus[],
    next: CustomDomainStatus,
    changes?: Partial<
      Pick<
        CustomDomain,
        | "verificationTokenHash"
        | "challengeExpiresAt"
        | "verifiedAt"
        | "activatedAt"
        | "disabledAt"
        | "verificationAttempts"
      >
    >,
  ): Promise<CustomDomain>;
}
