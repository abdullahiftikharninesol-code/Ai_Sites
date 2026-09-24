import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteId } from "../../shared/types.js";
import type { SiteSecretMetadata, SiteSecretStore } from "../site-secret-store.js";

interface StoredSecret extends SiteSecretMetadata {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

const namedStates = new Map<string, Map<string, StoredSecret>>();
const secretKey = (siteId: SiteId, name: string) => `${siteId}\u0000${name}`;

/** Execution-only encrypted secret store for tests and local workflows. */
export class LocalSiteSecretStore implements SiteSecretStore {
  readonly #secrets: Map<string, StoredSecret>;

  constructor(
    namespace = ":memory:",
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("Secret master key must be 32 bytes");
    if (namespace === ":memory:") this.#secrets = new Map();
    else {
      const existing = namedStates.get(namespace);
      this.#secrets = existing ?? new Map();
      namedStates.set(namespace, this.#secrets);
    }
  }

  async setSecret(siteId: SiteId, name: string, value: string): Promise<SiteSecretMetadata> {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name))
      throw new ApplicationError("RUNTIME_VALIDATION_FAILED", "Invalid secret name");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const existing = this.#secrets.get(secretKey(siteId, name));
    const now = new Date();
    const stored: StoredSecret = {
      id: existing?.id ?? randomUUID(),
      siteId,
      name,
      ciphertext: Buffer.concat([cipher.update(value, "utf8"), cipher.final()]),
      iv,
      tag: cipher.getAuthTag(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#secrets.set(secretKey(siteId, name), stored);
    return this.#metadata(stored);
  }

  async getSecret(siteId: SiteId, name: string): Promise<string | undefined> {
    const stored = this.#secrets.get(secretKey(siteId, name));
    if (!stored) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, stored.iv);
      decipher.setAuthTag(stored.tag);
      return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]).toString("utf8");
    } catch (cause) {
      throw new ApplicationError("SECRET_DECRYPTION_FAILED", "Unable to decrypt site secret", {
        cause,
      });
    }
  }

  async deleteSecret(siteId: SiteId, name: string): Promise<void> {
    this.#secrets.delete(secretKey(siteId, name));
  }

  async listSecretMetadata(siteId: SiteId): Promise<readonly SiteSecretMetadata[]> {
    return [...this.#secrets.values()]
      .filter((stored) => stored.siteId === siteId)
      .map((stored) => this.#metadata(stored));
  }

  close(): void {}

  #metadata(stored: StoredSecret): SiteSecretMetadata {
    const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...metadata } = stored;
    return structuredClone(metadata);
  }
}
