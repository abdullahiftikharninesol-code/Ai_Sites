import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteId } from "../shared/types.js";
import type { SiteAuthProvider, SiteUser } from "./site-auth-provider.js";

export interface AuthResult {
  readonly user: SiteUser;
  readonly token: string;
  readonly cookie: string;
}

export class SiteAuthService {
  constructor(
    private readonly provider: SiteAuthProvider,
    private readonly secureCookies = false,
  ) {}
  async signup(siteId: SiteId, email: string, password: string): Promise<AuthResult> {
    const user = await this.provider.createUser(siteId, email, password);
    return this.#result(user, (await this.provider.createSession(siteId, user.id)).token);
  }
  async login(siteId: SiteId, email: string, password: string): Promise<AuthResult> {
    const user = await this.provider.authenticate(siteId, email, password);
    return this.#result(user, (await this.provider.createSession(siteId, user.id)).token);
  }
  async me(siteId: SiteId, token?: string): Promise<SiteUser> {
    const user = token ? await this.provider.validateSession(siteId, token) : undefined;
    if (!user) throw new ApplicationError("AUTH_UNAUTHENTICATED", "Authentication is required");
    return user;
  }
  async logout(siteId: SiteId, token?: string): Promise<void> {
    if (token) await this.provider.revokeSession(siteId, token);
  }
  clearCookie(): string {
    return `sites_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookies ? "; Secure" : ""}`;
  }
  #result(user: SiteUser, token: string): AuthResult {
    return {
      user,
      token,
      cookie: `sites_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${this.secureCookies ? "; Secure" : ""}`,
    };
  }
}
