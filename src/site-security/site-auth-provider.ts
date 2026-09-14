import type { SiteId } from "../shared/types.js";
export interface SiteUser {
  readonly id: string;
  readonly siteId: SiteId;
  readonly email: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface SiteSession {
  readonly id: string;
  readonly siteId: SiteId;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}
export interface SiteAuthProvider {
  readonly id: string;
  createUser(siteId: SiteId, email: string, password: string): Promise<SiteUser>;
  authenticate(siteId: SiteId, email: string, password: string): Promise<SiteUser>;
  createSession(siteId: SiteId, userId: string): Promise<{ session: SiteSession; token: string }>;
  validateSession(siteId: SiteId, token: string): Promise<SiteUser | undefined>;
  revokeSession(siteId: SiteId, token: string): Promise<void>;
  revokeAllUserSessions(siteId: SiteId, userId: string): Promise<void>;
  close(): void;
}
