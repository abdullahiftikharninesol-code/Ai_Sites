import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { argon2id, argon2Verify } from "hash-wasm";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteId } from "../../shared/types.js";
import type { SiteAuthProvider, SiteUser } from "../site-auth-provider.js";
type Row = Record<string, unknown>;
export class LocalSiteAuthProvider implements SiteAuthProvider {
  readonly id = "local-auth";
  readonly #db: Database.Database;
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
    private readonly sessionTtlMs = 7 * 86400000,
  ) {
    const p = path === ":memory:" ? path : resolve(path);
    if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
    this.#db = new Database(p);
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS site_users(id TEXT PRIMARY KEY,site_id TEXT NOT NULL,email TEXT NOT NULL,password_hash TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(site_id,email));CREATE TABLE IF NOT EXISTS site_sessions(id TEXT PRIMARY KEY,site_id TEXT NOT NULL,user_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,FOREIGN KEY(user_id) REFERENCES site_users(id));`,
    );
  }
  async createUser(siteId: SiteId, email: string, password: string) {
    const normalized = this.#email(email);
    if (password.length < 10 || password.length > 256)
      throw new ApplicationError("AUTH_PASSWORD_INVALID", "Password must be 10 to 256 characters");
    const id = randomUUID(),
      now = new Date(this.now()),
      passwordHash = await argon2id({
        password,
        salt: randomBytes(16),
        memorySize: 19456,
        iterations: 2,
        parallelism: 1,
        hashLength: 32,
        outputType: "encoded",
      });
    try {
      this.#db
        .prepare("INSERT INTO site_users VALUES (?,?,?,?,?,?,?)")
        .run(id, siteId, normalized, passwordHash, "ACTIVE", now.toISOString(), now.toISOString());
    } catch {
      throw new ApplicationError("AUTH_EMAIL_TAKEN", "An account already exists for this email");
    }
    return {
      id,
      siteId,
      email: normalized,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    } as SiteUser;
  }
  async authenticate(siteId: SiteId, email: string, password: string) {
    const row = this.#db
      .prepare("SELECT * FROM site_users WHERE site_id=? AND email=? AND status='ACTIVE'")
      .get(siteId, this.#email(email)) as Row | undefined;
    if (!row || !(await argon2Verify({ hash: String(row.password_hash), password })))
      throw new ApplicationError("AUTH_INVALID_CREDENTIALS", "Invalid email or password");
    return this.#user(row);
  }
  createSession(siteId: SiteId, userId: string) {
    const token = randomBytes(32).toString("base64url"),
      createdAt = new Date(this.now()),
      expiresAt = new Date(this.now() + this.sessionTtlMs),
      id = randomUUID();
    this.#db
      .prepare("INSERT INTO site_sessions VALUES (?,?,?,?,?,?,NULL)")
      .run(
        id,
        siteId,
        userId,
        this.#token(token),
        createdAt.toISOString(),
        expiresAt.toISOString(),
      );
    return Promise.resolve({ session: { id, siteId, userId, createdAt, expiresAt }, token });
  }
  validateSession(siteId: SiteId, token: string) {
    const row = this.#db
      .prepare(
        "SELECT u.* FROM site_sessions s JOIN site_users u ON u.id=s.user_id WHERE s.site_id=? AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?",
      )
      .get(siteId, this.#token(token), new Date(this.now()).toISOString()) as Row | undefined;
    return Promise.resolve(row ? this.#user(row) : undefined);
  }
  revokeSession(siteId: SiteId, token: string) {
    this.#db
      .prepare("UPDATE site_sessions SET revoked_at=? WHERE site_id=? AND token_hash=?")
      .run(new Date(this.now()).toISOString(), siteId, this.#token(token));
    return Promise.resolve();
  }
  revokeAllUserSessions(siteId: SiteId, userId: string) {
    this.#db
      .prepare("UPDATE site_sessions SET revoked_at=? WHERE site_id=? AND user_id=?")
      .run(new Date(this.now()).toISOString(), siteId, userId);
    return Promise.resolve();
  }
  close() {
    this.#db.close();
  }
  #email(value: string) {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ApplicationError("AUTH_INVALID_CREDENTIALS", "Invalid email or password");
    return email;
  }
  #token(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  #user(row: Row): SiteUser {
    return {
      id: String(row.id),
      siteId: String(row.site_id) as SiteId,
      email: String(row.email),
      status: String(row.status) as SiteUser["status"],
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }
}
