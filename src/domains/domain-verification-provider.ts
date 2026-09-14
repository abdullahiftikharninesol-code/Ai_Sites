import type { CustomDomain } from "./custom-domain.js";
export interface DomainVerificationProvider {
  readonly id: string;
  verify(domain: CustomDomain, recordName: string): Promise<boolean>;
}
export interface CertificateProvider {
  readonly id: string;
  readonly tls: boolean;
  provision(
    domain: CustomDomain,
  ): Promise<{ status: "NOT_REQUIRED_LOCAL" | "PENDING" | "ISSUED" | "FAILED" }>;
}
export class LocalNoopCertificateProvider implements CertificateProvider {
  readonly id = "local-noop-certificate";
  readonly tls = false;
  provision() {
    return Promise.resolve({ status: "NOT_REQUIRED_LOCAL" as const });
  }
}
