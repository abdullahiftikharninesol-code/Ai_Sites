export interface SiteDatabaseProvider {
  readonly id: string;
  provision(siteId: string): Promise<{ readonly databaseRef: string }>;
}
export interface SiteObjectStorageProvider {
  readonly id: string;
  provision(siteId: string): Promise<{ readonly bucketRef: string }>;
}
export interface SiteAuthProvider {
  readonly id: string;
  provision(siteId: string): Promise<{ readonly authRef: string }>;
}
export interface SiteSecretsProvider {
  readonly id: string;
  set(siteId: string, name: string, value: string): Promise<void>;
  delete(siteId: string, name: string): Promise<void>;
}
export interface SiteExternalActionProvider {
  readonly id: string;
  invoke(siteId: string, action: string, input: unknown): Promise<unknown>;
}
