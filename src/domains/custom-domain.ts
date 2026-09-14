import { domainToASCII } from "node:url";
import type { SiteId } from "../shared/types.js";
import { ApplicationError } from "../app/errors/application-error.js";

export type CustomDomainStatus =
  "PENDING_VERIFICATION" | "VERIFIED" | "ACTIVE" | "DISABLED" | "VERIFICATION_FAILED";
export type CertificateStatus = "NOT_REQUIRED_LOCAL" | "PENDING" | "ISSUED" | "FAILED";
export interface CustomDomain {
  readonly id: string;
  readonly siteId: SiteId;
  readonly hostname: string;
  readonly status: CustomDomainStatus;
  readonly verificationMethod: "DNS_TXT";
  readonly verificationTokenHash: string;
  readonly challengeExpiresAt: Date;
  readonly certificateStatus: CertificateStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly verifiedAt?: Date;
  readonly activatedAt?: Date;
  readonly disabledAt?: Date;
  readonly verificationAttempts: number;
}
export interface DomainVerificationChallenge {
  readonly domainId: string;
  readonly hostname: string;
  readonly recordType: "TXT";
  readonly recordName: string;
  readonly recordValue: string;
  readonly expiresAt: Date;
}
export function normalizeHostname(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed !== input ||
    trimmed.includes("://") ||
    /[/?#\\\s]/.test(trimmed) ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    trimmed.includes(":")
  )
    throw new ApplicationError("CUSTOM_DOMAIN_INVALID", "Invalid custom hostname");
  const ascii = domainToASCII(trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed).toLowerCase();
  if (!ascii || ascii.length > 253)
    throw new ApplicationError("CUSTOM_DOMAIN_INVALID", "Invalid custom hostname");
  const labels = ascii.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  )
    throw new ApplicationError("CUSTOM_DOMAIN_INVALID", "Invalid custom hostname");
  return ascii;
}
export class ReservedHostnamePolicy {
  readonly #reserved: Set<string>;
  constructor(values: readonly string[]) {
    this.#reserved = new Set(values.map((value) => normalizeReserved(value)));
  }
  isReserved(hostname: string): boolean {
    return (
      this.#reserved.has(hostname) ||
      [...this.#reserved].some((value) => hostname.endsWith(`.${value}`))
    );
  }
  assertAvailable(hostname: string): void {
    if (this.isReserved(hostname))
      throw new ApplicationError("CUSTOM_DOMAIN_RESERVED", "Custom hostname is reserved");
  }
}
const normalizeReserved = (value: string) => value.trim().replace(/\.$/, "").toLowerCase();
