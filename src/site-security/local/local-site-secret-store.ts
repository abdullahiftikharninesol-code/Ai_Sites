import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteId } from "../../shared/types.js";
import type { SiteSecretStore } from "../site-secret-store.js";
type Row = Record<string, unknown>;
export class LocalSiteSecretStore implements SiteSecretStore {
  readonly #db: Database.Database;
  constructor(
    path: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("Secret master key must be 32 bytes");
    const p = path === ":memory:" ? path : resolve(path);
    if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
    this.#db = new Database(p);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS site_secrets(id TEXT PRIMARY KEY,site_id TEXT NOT NULL,name TEXT NOT NULL,ciphertext BLOB NOT NULL,iv BLOB NOT NULL,tag BLOB NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(site_id,name))",
    );
  }
  setSecret(siteId: SiteId, name: string, value: string) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name))
      throw new ApplicationError("RUNTIME_VALIDATION_FAILED", "Invalid secret name");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]),
      tag = cipher.getAuthTag(),
      now = new Date(),
      existing = this.#db
        .prepare("SELECT id,created_at FROM site_secrets WHERE site_id=? AND name=?")
        .get(siteId, name) as Row | undefined,
      id = existing ? String(existing.id) : randomUUID(),
      created = existing ? new Date(String(existing.created_at)) : now;
    this.#db
      .prepare(
        "INSERT INTO site_secrets VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(site_id,name) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,updated_at=excluded.updated_at",
      )
      .run(id, siteId, name, ciphertext, iv, tag, created.toISOString(), now.toISOString());
    return Promise.resolve({ id, siteId, name, createdAt: created, updatedAt: now });
  }
  async getSecret(siteId: SiteId, name: string) {
    await Promise.resolve();
    const r = this.#db
      .prepare("SELECT * FROM site_secrets WHERE site_id=? AND name=?")
      .get(siteId, name) as Row | undefined;
    if (!r) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, r.iv as Buffer);
      decipher.setAuthTag(r.tag as Buffer);
      return Buffer.concat([decipher.update(r.ciphertext as Buffer), decipher.final()]).toString(
        "utf8",
      );
    } catch (cause) {
      throw new ApplicationError("SECRET_DECRYPTION_FAILED", "Unable to decrypt site secret", {
        cause,
      });
    }
  }
  deleteSecret(siteId: SiteId, name: string) {
    this.#db.prepare("DELETE FROM site_secrets WHERE site_id=? AND name=?").run(siteId, name);
    return Promise.resolve();
  }
  listSecretMetadata(siteId: SiteId) {
    return Promise.resolve(
      (
        this.#db
          .prepare("SELECT id,site_id,name,created_at,updated_at FROM site_secrets WHERE site_id=?")
          .all(siteId) as Row[]
      ).map((r) => ({
        id: String(r.id),
        siteId: String(r.site_id) as SiteId,
        name: String(r.name),
        createdAt: new Date(String(r.created_at)),
        updatedAt: new Date(String(r.updated_at)),
      })),
    );
  }
  close() {
    this.#db.close();
  }
}
