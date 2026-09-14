import type {
  SiteDeployment,
  SiteJob,
  SiteProject,
  SiteVersion,
} from "../sites/domain/entities.js";
import type { DeploymentId, JobId, Page, SiteId, VersionId } from "../shared/types.js";
export interface SiteProjectRepository {
  getById(id: SiteId): Promise<SiteProject | undefined>;
  getBySlug(slug: string): Promise<SiteProject | undefined>;
  save(project: SiteProject): Promise<void>;
  listByOwner(ownerId: string, cursor?: string): Promise<Page<SiteProject>>;
}
export interface SiteVersionRepository {
  getById(id: VersionId): Promise<SiteVersion | undefined>;
  save(version: SiteVersion): Promise<void>;
  listBySite(siteId: SiteId, cursor?: string): Promise<Page<SiteVersion>>;
}
export interface SiteJobRepository {
  getById(id: JobId): Promise<SiteJob | undefined>;
  save(job: SiteJob): Promise<void>;
  listBySite(siteId: SiteId, cursor?: string): Promise<Page<SiteJob>>;
}
export interface SiteDeploymentRepository {
  getById(id: DeploymentId): Promise<SiteDeployment | undefined>;
  save(deployment: SiteDeployment): Promise<void>;
  listBySite(siteId: SiteId, cursor?: string): Promise<Page<SiteDeployment>>;
}
