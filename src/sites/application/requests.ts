import type { SiteId, UserId, VersionId } from "../../shared/types.js";

export interface SiteRequestContext {
  readonly locale?: string;
  readonly notes?: readonly string[];
}
export interface CreateSiteRequest {
  readonly userId: UserId;
  readonly prompt: string;
  readonly projectName?: string;
  readonly context?: SiteRequestContext;
  readonly signal?: AbortSignal;
}
export type GenerateSiteRequest = CreateSiteRequest;
export interface EditSiteRequest {
  readonly userId: UserId;
  readonly siteId: SiteId;
  readonly prompt: string;
  readonly baseVersionId?: VersionId;
  readonly context?: SiteRequestContext;
  readonly signal?: AbortSignal;
}
export interface BuildSiteRequest {
  readonly siteId: SiteId;
  readonly environmentId: string;
}
export interface SaveSiteRequest {
  readonly siteId: SiteId;
  readonly environmentId: string;
  readonly parentVersionId?: VersionId;
}
