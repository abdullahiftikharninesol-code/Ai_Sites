/* eslint-disable @typescript-eslint/require-await -- SQLite adapter is synchronous behind async contract */
import { ApplicationError } from "../app/errors/application-error.js";
import type { SqliteDatabase } from "../persistence/sqlite/sqlite-database.js";
import type { SiteId } from "../shared/types.js";
import type { CustomDomain, CustomDomainStatus } from "./custom-domain.js";
import type { CustomDomainRepository } from "./custom-domain-repository.js";
type Row = Record<string, unknown>;
export class SqliteCustomDomainRepository implements CustomDomainRepository {
  constructor(private readonly db: SqliteDatabase) {}
  async create(value: CustomDomain) {
    try {
      this.db.connection
        .prepare(
          "INSERT INTO custom_domains (id,site_id,hostname,status,verification_method,verification_token_hash,challenge_expires_at,certificate_status,verification_attempts,created_at,updated_at,verified_at,activated_at,disabled_at) VALUES (@id,@site,@hostname,@status,@method,@hash,@expires,@certificate,@attempts,@created,@updated,@verified,@activated,@disabled)",
        )
        .run(this.#params(value));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (message.includes("UNIQUE"))
        throw new ApplicationError(
          "CUSTOM_DOMAIN_ALREADY_EXISTS",
          "Custom hostname is already registered",
        );
      throw new ApplicationError("PERSISTENCE_WRITE_FAILED", "Unable to register custom domain", {
        cause,
      });
    }
  }
  async findById(id: string) {
    return this.#one("id", id);
  }
  async findByHostname(hostname: string) {
    return this.#one("hostname", hostname);
  }
  async listForSite(siteId: SiteId) {
    return (
      this.db.connection
        .prepare("SELECT * FROM custom_domains WHERE site_id=? ORDER BY created_at")
        .all(siteId) as Row[]
    ).map((row) => this.#map(row));
  }
  async transition(
    id: string,
    from: readonly CustomDomainStatus[],
    next: CustomDomainStatus,
    changes = {},
  ) {
    const current = await this.findById(id);
    if (!current)
      throw new ApplicationError("CUSTOM_DOMAIN_NOT_FOUND", "Custom domain was not found");
    if (!from.includes(current.status))
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Invalid custom-domain transition");
    const updated: CustomDomain = { ...current, ...changes, status: next, updatedAt: new Date() };
    const result = this.db.connection
      .prepare(
        "UPDATE custom_domains SET status=@status,verification_token_hash=@hash,challenge_expires_at=@expires,certificate_status=@certificate,verification_attempts=@attempts,updated_at=@updated,verified_at=@verified,activated_at=@activated,disabled_at=@disabled WHERE id=@id AND status=@expected",
      )
      .run({ ...this.#params(updated), expected: current.status });
    if (!result.changes)
      throw new ApplicationError(
        "PERSISTENCE_TRANSACTION_FAILED",
        "Custom-domain transition conflict",
      );
    return updated;
  }
  async #one(field: "id" | "hostname", value: string) {
    const row = this.db.connection
      .prepare(`SELECT * FROM custom_domains WHERE ${field}=?`)
      .get(value) as Row | undefined;
    return row ? this.#map(row) : undefined;
  }
  #params(value: CustomDomain) {
    return {
      id: value.id,
      site: value.siteId,
      hostname: value.hostname,
      status: value.status,
      method: value.verificationMethod,
      hash: value.verificationTokenHash,
      expires: value.challengeExpiresAt.toISOString(),
      certificate: value.certificateStatus,
      attempts: value.verificationAttempts,
      created: value.createdAt.toISOString(),
      updated: value.updatedAt.toISOString(),
      verified: value.verifiedAt?.toISOString() ?? null,
      activated: value.activatedAt?.toISOString() ?? null,
      disabled: value.disabledAt?.toISOString() ?? null,
    };
  }
  #map(row: Row): CustomDomain {
    return {
      id: String(row.id),
      siteId: String(row.site_id) as SiteId,
      hostname: String(row.hostname),
      status: String(row.status) as CustomDomainStatus,
      verificationMethod: "DNS_TXT",
      verificationTokenHash: String(row.verification_token_hash),
      challengeExpiresAt: new Date(String(row.challenge_expires_at)),
      certificateStatus: String(row.certificate_status) as CustomDomain["certificateStatus"],
      verificationAttempts: Number(row.verification_attempts),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
      ...(typeof row.verified_at === "string" ? { verifiedAt: new Date(row.verified_at) } : {}),
      ...(typeof row.activated_at === "string" ? { activatedAt: new Date(row.activated_at) } : {}),
      ...(typeof row.disabled_at === "string" ? { disabledAt: new Date(row.disabled_at) } : {}),
    };
  }
}
