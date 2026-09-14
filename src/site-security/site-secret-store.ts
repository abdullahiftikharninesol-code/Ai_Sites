import type { SiteId } from "../shared/types.js";
export interface SiteSecretMetadata {
  readonly id: string;
  readonly siteId: SiteId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface SiteSecretStore {
  setSecret(siteId: SiteId, name: string, value: string): Promise<SiteSecretMetadata>;
  getSecret(siteId: SiteId, name: string): Promise<string | undefined>;
  deleteSecret(siteId: SiteId, name: string): Promise<void>;
  listSecretMetadata(siteId: SiteId): Promise<readonly SiteSecretMetadata[]>;
  close(): void;
}
