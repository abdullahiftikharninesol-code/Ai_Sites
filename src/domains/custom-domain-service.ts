import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteProjectRepository } from "../persistence/repositories.js";
import type { SiteId } from "../shared/types.js";
import { LocalRuntimeRateLimiter } from "../site-runtime/runtime-rate-limiter.js";
import type { CustomDomain, DomainVerificationChallenge } from "./custom-domain.js";
import { normalizeHostname } from "./custom-domain.js";
import type { ReservedHostnamePolicy } from "./custom-domain.js";
import type { CustomDomainRepository } from "./custom-domain-repository.js";
import type {
  CertificateProvider,
  DomainVerificationProvider,
} from "./domain-verification-provider.js";
export interface DomainTelemetry {
  domainsRegistered: number;
  verificationAttempts: number;
  verificationSuccess: number;
  verificationFailure: number;
  domainsActivated: number;
  domainsDisabled: number;
  customHostRequests: number;
  customHostResolutionFailures: number;
}
export class CustomDomainService {
  readonly metrics: DomainTelemetry = {
    domainsRegistered: 0,
    verificationAttempts: 0,
    verificationSuccess: 0,
    verificationFailure: 0,
    domainsActivated: 0,
    domainsDisabled: 0,
    customHostRequests: 0,
    customHostResolutionFailures: 0,
  };
  constructor(
    private readonly projects: SiteProjectRepository,
    private readonly domains: CustomDomainRepository,
    private readonly verification: DomainVerificationProvider,
    private readonly certificates: CertificateProvider,
    private readonly reserved: ReservedHostnamePolicy,
    private readonly maxPerSite = 5,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 86400000,
    private readonly limiter = new LocalRuntimeRateLimiter(
      { maxRequests: 10, windowMs: 60000 },
      now,
    ),
  ) {}
  async add(
    siteId: SiteId,
    input: string,
  ): Promise<{ domain: CustomDomain; challenge: DomainVerificationChallenge }> {
    if (!(await this.projects.getById(siteId)))
      throw new ApplicationError("SITE_NOT_FOUND", "Site not found");
    const hostname = normalizeHostname(input);
    this.reserved.assertAvailable(hostname);
    if (await this.domains.findByHostname(hostname))
      throw new ApplicationError(
        "CUSTOM_DOMAIN_ALREADY_EXISTS",
        "Custom hostname is already registered",
      );
    if (
      (await this.domains.listForSite(siteId)).filter((item) => item.status !== "DISABLED")
        .length >= this.maxPerSite
    )
      throw new ApplicationError("CUSTOM_DOMAIN_LIMIT_REACHED", "Custom-domain limit reached");
    const token = randomBytes(32).toString("base64url"),
      now = new Date(this.now()),
      domain: CustomDomain = {
        id: randomUUID(),
        siteId,
        hostname,
        status: "PENDING_VERIFICATION",
        verificationMethod: "DNS_TXT",
        verificationTokenHash: createHash("sha256").update(token).digest("hex"),
        challengeExpiresAt: new Date(this.now() + this.ttlMs),
        certificateStatus: "NOT_REQUIRED_LOCAL",
        createdAt: now,
        updatedAt: now,
        verificationAttempts: 0,
      };
    await this.domains.create(domain);
    this.metrics.domainsRegistered++;
    return { domain, challenge: this.#challenge(domain, token) };
  }
  async verify(siteId: SiteId, id: string): Promise<CustomDomain> {
    this.limiter.consume(`${siteId}:${id}:verify`);
    const domain = await this.#owned(siteId, id);
    if (domain.challengeExpiresAt.getTime() <= this.now())
      throw new ApplicationError(
        "DOMAIN_VERIFICATION_EXPIRED",
        "Domain verification challenge expired",
      );
    this.metrics.verificationAttempts++;
    const valid = await this.verification.verify(domain, this.#recordName(domain.hostname));
    if (!valid) {
      this.metrics.verificationFailure++;
      await this.domains.transition(
        id,
        ["PENDING_VERIFICATION", "VERIFICATION_FAILED"],
        "VERIFICATION_FAILED",
        { verificationAttempts: domain.verificationAttempts + 1 },
      );
      throw new ApplicationError("DOMAIN_VERIFICATION_FAILED", "Domain verification failed");
    }
    this.metrics.verificationSuccess++;
    return this.domains.transition(
      id,
      ["PENDING_VERIFICATION", "VERIFICATION_FAILED"],
      "VERIFIED",
      { verifiedAt: new Date(this.now()), verificationAttempts: domain.verificationAttempts + 1 },
    );
  }
  async activate(siteId: SiteId, id: string): Promise<CustomDomain> {
    const domain = await this.#owned(siteId, id);
    if (domain.status !== "VERIFIED")
      throw new ApplicationError("CUSTOM_DOMAIN_NOT_VERIFIED", "Custom domain is not verified");
    await this.certificates.provision(domain);
    this.metrics.domainsActivated++;
    return this.domains.transition(id, ["VERIFIED"], "ACTIVE", {
      activatedAt: new Date(this.now()),
    });
  }
  async disable(siteId: SiteId, id: string): Promise<CustomDomain> {
    await this.#owned(siteId, id);
    this.metrics.domainsDisabled++;
    return this.domains.transition(
      id,
      ["ACTIVE", "VERIFIED", "PENDING_VERIFICATION", "VERIFICATION_FAILED"],
      "DISABLED",
      { disabledAt: new Date(this.now()) },
    );
  }
  async reissue(siteId: SiteId, id: string): Promise<DomainVerificationChallenge> {
    const domain = await this.#owned(siteId, id),
      token = randomBytes(32).toString("base64url"),
      expires = new Date(this.now() + this.ttlMs);
    await this.domains.transition(
      id,
      ["PENDING_VERIFICATION", "VERIFICATION_FAILED"],
      "PENDING_VERIFICATION",
      {
        verificationTokenHash: createHash("sha256").update(token).digest("hex"),
        challengeExpiresAt: expires,
      },
    );
    return {
      domainId: id,
      hostname: domain.hostname,
      recordType: "TXT",
      recordName: this.#recordName(domain.hostname),
      recordValue: `sites-verification=${token}`,
      expiresAt: expires,
    };
  }
  list(siteId: SiteId) {
    return this.domains.listForSite(siteId);
  }
  get(id: string) {
    return this.domains.findById(id);
  }
  find(hostname: string) {
    return this.domains.findByHostname(normalizeHostname(hostname));
  }
  async #owned(siteId: SiteId, id: string) {
    const domain = await this.domains.findById(id);
    if (!domain || domain.siteId !== siteId)
      throw new ApplicationError("CUSTOM_DOMAIN_NOT_FOUND", "Custom domain was not found");
    return domain;
  }
  #recordName(hostname: string) {
    return `_sites-verification.${hostname}`;
  }
  #challenge(domain: CustomDomain, token: string): DomainVerificationChallenge {
    return {
      domainId: domain.id,
      hostname: domain.hostname,
      recordType: "TXT",
      recordName: this.#recordName(domain.hostname),
      recordValue: `sites-verification=${token}`,
      expiresAt: domain.challengeExpiresAt,
    };
  }
}
