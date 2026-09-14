export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SiteId = Brand<string, "SiteId">;
export type VersionId = Brand<string, "VersionId">;
export type JobId = Brand<string, "JobId">;
export type DeploymentId = Brand<string, "DeploymentId">;
export type UserId = Brand<string, "UserId">;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
