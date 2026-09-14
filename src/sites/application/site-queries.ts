import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  SiteProjectRepository,
  SiteVersionRepository,
} from "../../persistence/repositories.js";
import type { SiteId, UserId, VersionId } from "../../shared/types.js";
export class SiteQueries {
  constructor(
    private readonly projects: SiteProjectRepository,
    private readonly versions: SiteVersionRepository,
  ) {}
  listProjects(ownerId: UserId) {
    return this.projects.listByOwner(ownerId);
  }
  async getProject(id: SiteId) {
    const project = await this.projects.getById(id);
    if (!project) throw new ApplicationError("SITE_NOT_FOUND", "Site project was not found");
    const latestVersion = project.latestVersionId
      ? await this.versions.getById(project.latestVersionId)
      : undefined;
    return { project, latestVersion };
  }
  async listVersions(siteId: SiteId) {
    const project = await this.projects.getById(siteId);
    if (!project) throw new ApplicationError("SITE_NOT_FOUND", "Site project was not found");
    return this.versions.listBySite(siteId);
  }
  async getVersion(id: VersionId) {
    const version = await this.versions.getById(id);
    if (!version) throw new ApplicationError("VERSION_NOT_FOUND", "Site version was not found");
    return version;
  }
}
