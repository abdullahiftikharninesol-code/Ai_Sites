import { createHash, timingSafeEqual } from "node:crypto";
import type { CustomDomain } from "./custom-domain.js";
import type { DomainVerificationProvider } from "./domain-verification-provider.js";
export class LocalDnsRegistry {
  readonly #txt = new Map<string, Set<string>>();
  setTxtRecord(host: string, value: string): void {
    const values = this.#txt.get(host) ?? new Set<string>();
    values.add(value);
    this.#txt.set(host, values);
  }
  getTxtRecords(host: string): readonly string[] {
    return [...(this.#txt.get(host) ?? [])];
  }
  clear(): void {
    this.#txt.clear();
  }
}
export class LocalDomainVerificationProvider implements DomainVerificationProvider {
  readonly id = "local-dns-verification";
  constructor(private readonly dns: LocalDnsRegistry) {}
  verify(domain: CustomDomain, recordName: string): Promise<boolean> {
    const prefix = "sites-verification=";
    const found = this.dns.getTxtRecords(recordName).some((value) => {
      if (!value.startsWith(prefix)) return false;
      const actual = Buffer.from(
          createHash("sha256").update(value.slice(prefix.length)).digest("hex"),
        ),
        expected = Buffer.from(domain.verificationTokenHash);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    return Promise.resolve(found);
  }
}
