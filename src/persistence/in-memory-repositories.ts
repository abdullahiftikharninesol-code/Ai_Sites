import type {
  SiteDeployment,
  SiteJob,
  SiteProject,
  SiteVersion,
} from "../sites/domain/entities.js";
import type { DeploymentId, JobId, Page, SiteId, VersionId } from "../shared/types.js";
import type {
  SiteDeploymentRepository,
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "./repositories.js";

const page = <T>(items: readonly T[]): Page<T> => ({ items });
export class InMemorySiteProjectRepository implements SiteProjectRepository {
  readonly #items = new Map<SiteId, SiteProject>();
  async getById(id: SiteId) {
    return this.#items.get(id);
  }
  async getBySlug(slug: string) {
    return [...this.#items.values()].find((item) => item.slug === slug);
  }
  async save(project: SiteProject) {
    this.#items.set(project.id, structuredClone(project));
  }
  async listByOwner(ownerId: string) {
    return page([...this.#items.values()].filter((item) => item.ownerId === ownerId));
  }
  async setPublication(
    siteId: SiteId,
    publication?: { readonly versionId: VersionId; readonly deploymentId: DeploymentId },
  ) {
    const project = this.#items.get(siteId);
    if (!project) return;
    if (publication)
      this.#items.set(siteId, {
        ...project,
        publishedVersionId: publication.versionId,
        publishedDeploymentId: publication.deploymentId,
        updatedAt: new Date(),
      });
    else {
      const { publishedVersionId: _version, publishedDeploymentId: _deployment, ...current } =
        project;
      this.#items.set(siteId, { ...current, updatedAt: new Date() });
    }
  }
}
export class InMemorySiteVersionRepository implements SiteVersionRepository {
  readonly #items = new Map<VersionId, SiteVersion>();
  async getById(id: VersionId) {
    return this.#items.get(id);
  }
  async save(version: SiteVersion) {
    if (this.#items.has(version.id)) throw new Error(`Version '${version.id}' is immutable`);
    this.#items.set(version.id, structuredClone(version));
  }
  async listBySite(siteId: SiteId) {
    return page(
      [...this.#items.values()]
        .filter((item) => item.siteId === siteId)
        .sort((a, b) => a.versionNumber - b.versionNumber),
    );
  }
}
export class InMemorySiteJobRepository implements SiteJobRepository {
  readonly #items = new Map<JobId, SiteJob>();
  async getById(id: JobId) {
    return this.#items.get(id);
  }
  async save(job: SiteJob) {
    this.#items.set(job.id, structuredClone(job));
  }
  async listBySite(siteId: SiteId) {
    return page([...this.#items.values()].filter((item) => item.siteId === siteId));
  }
}
export class InMemorySiteDeploymentRepository implements SiteDeploymentRepository {
  readonly #items = new Map<DeploymentId, SiteDeployment>();
  async getById(id: DeploymentId) {
    return this.#items.get(id);
  }
  async save(deployment: SiteDeployment) {
    this.#items.set(deployment.id, structuredClone(deployment));
  }
  async listBySite(siteId: SiteId) {
    return page([...this.#items.values()].filter((item) => item.siteId === siteId));
  }
}
