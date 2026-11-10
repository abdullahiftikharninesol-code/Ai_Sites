import type { SiteProject, SiteVersion } from "../sites/domain/entities.js";
export type UnnumberedSiteVersion = Omit<SiteVersion, "versionNumber">;
export interface SiteVersionCommitOptions {
  /** Records why the current version changed; generation/edit are inferred. */
  readonly operation?: "ROLLBACK";
}
export interface SiteVersionCommitter {
  commit(project: SiteProject, version: UnnumberedSiteVersion, expectedNumber?: number, options?: SiteVersionCommitOptions): Promise<SiteVersion>;
}
