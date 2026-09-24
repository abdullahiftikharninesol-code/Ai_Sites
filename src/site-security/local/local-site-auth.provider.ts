import { createHash, randomBytes, randomUUID } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteId } from "../../shared/types.js";
import type { SiteAuthProvider, SiteSession, SiteUser } from "../site-auth-provider.js";

interface StoredUser extends SiteUser {
  readonly passwordHash: string;
}
interface StoredSession extends SiteSession {
  readonly tokenHash: string;
  readonly revokedAt?: Date;
}
interface AuthMemoryState {
  readonly users: Map<string, StoredUser>;
  readonly sessions: Map<string, StoredSession>;
}

const namedStates = new Map<string, AuthMemoryState>();
const emptyState = (): AuthMemoryState => ({ users: new Map(), sessions: new Map() });

/** Execution-only authentication provider for tests and local workflows. */
export class LocalSiteAuthProvider implements SiteAuthProvider {
  readonly id = "memory-auth";
  readonly #state: AuthMemoryState;

  constructor(
    namespace = ":memory:",
    private readonly now: () => number = Date.now,
    private readonly sessionTtlMs = 7 * 86_400_000,
  ) {
    if (namespace === ":memory:") this.#state = emptyState();
    else {
      const existing = namedStates.get(namespace);
      this.#state = existing ?? emptyState();
      namedStates.set(namespace, this.#state);
    }
  }

  async createUser(siteId: SiteId, email: string, password: string): Promise<SiteUser> {
    const normalized = this.#email(email);
    if (password.length < 10 || password.length > 256)
      throw new ApplicationError("AUTH_PASSWORD_INVALID", "Password must be 10 to 256 characters");
    if ([...this.#state.users.values()].some((user) => user.siteId === siteId && user.email === normalized))
      throw new ApplicationError("AUTH_EMAIL_TAKEN", "An account already exists for this email");
    const now = new Date(this.now());
    const user: StoredUser = {
      id: randomUUID(),
      siteId,
      email: normalized,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      passwordHash: await argon2id({
        password,
        salt: randomBytes(16),
        memorySize: 19_456,
        iterations: 2,
        parallelism: 1,
        hashLength: 32,
        outputType: "encoded",
      }),
    };
    this.#state.users.set(user.id, user);
    return this.#publicUser(user);
  }

  async authenticate(siteId: SiteId, email: string, password: string): Promise<SiteUser> {
    const normalized = this.#email(email);
    const user = [...this.#state.users.values()].find(
      (item) => item.siteId === siteId && item.email === normalized && item.status === "ACTIVE",
    );
    if (!user || !(await argon2Verify({ hash: user.passwordHash, password })))
      throw new ApplicationError("AUTH_INVALID_CREDENTIALS", "Invalid email or password");
    return this.#publicUser(user);
  }

  async createSession(
    siteId: SiteId,
    userId: string,
  ): Promise<{ session: SiteSession; token: string }> {
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date(this.now());
    const stored: StoredSession = {
      id: randomUUID(),
      siteId,
      userId,
      tokenHash: this.#token(token),
      createdAt,
      expiresAt: new Date(this.now() + this.sessionTtlMs),
    };
    this.#state.sessions.set(stored.id, stored);
    const { tokenHash: _tokenHash, revokedAt: _revokedAt, ...session } = stored;
    return { session, token };
  }

  async validateSession(siteId: SiteId, token: string): Promise<SiteUser | undefined> {
    const hash = this.#token(token);
    const session = [...this.#state.sessions.values()].find(
      (item) =>
        item.siteId === siteId &&
        item.tokenHash === hash &&
        !item.revokedAt &&
        item.expiresAt.getTime() > this.now(),
    );
    const user = session ? this.#state.users.get(session.userId) : undefined;
    return user?.status === "ACTIVE" ? this.#publicUser(user) : undefined;
  }

  async revokeSession(siteId: SiteId, token: string): Promise<void> {
    const hash = this.#token(token);
    for (const [id, session] of this.#state.sessions)
      if (session.siteId === siteId && session.tokenHash === hash)
        this.#state.sessions.set(id, { ...session, revokedAt: new Date(this.now()) });
  }

  async revokeAllUserSessions(siteId: SiteId, userId: string): Promise<void> {
    for (const [id, session] of this.#state.sessions)
      if (session.siteId === siteId && session.userId === userId)
        this.#state.sessions.set(id, { ...session, revokedAt: new Date(this.now()) });
  }

  close(): void {}

  #email(value: string): string {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ApplicationError("AUTH_INVALID_CREDENTIALS", "Invalid email or password");
    return email;
  }

  #token(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  #publicUser(user: StoredUser): SiteUser {
    const { passwordHash: _passwordHash, ...value } = user;
    return structuredClone(value);
  }
}
