import type { SiteProject, SiteVersion } from "../sites/domain/entities.js";
export type UnnumberedSiteVersion = Omit<SiteVersion, "versionNumber">;
export interface SiteVersionCommitter {
  commit(project: SiteProject, version: UnnumberedSiteVersion): Promise<SiteVersion>;
}
