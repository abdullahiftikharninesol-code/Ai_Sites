/* eslint-disable @typescript-eslint/require-await -- better-sqlite3 is synchronous behind async repository contracts */
import { ApplicationError } from "../../app/errors/application-error.js";
import type {
  SiteDeployment,
  SiteJob,
  SiteProject,
  SiteVersion,
} from "../../sites/domain/entities.js";
import type { DeploymentId, JobId, SiteId, VersionId } from "../../shared/types.js";
import type {
  SiteDeploymentRepository,
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../repositories.js";
import type { SiteVersionCommitter, UnnumberedSiteVersion } from "../version-committer.js";
import type { SqliteDatabase } from "./sqlite-database.js";
import { SqliteMappers } from "./sqlite-mappers.js";
type Row = Record<string, unknown>;
const rows = (value: unknown) => value as Row[];
const row = (value: unknown) => value as Row | undefined;
const writeError = (message: string, cause: unknown): never => {
  throw new ApplicationError("PERSISTENCE_WRITE_FAILED", message, { cause });
};
export class SqliteSiteProjectRepository implements SiteProjectRepository {
  constructor(private readonly db: SqliteDatabase) {}
  async getById(id: SiteId) {
    return this.#get("id", id);
  }
  async getBySlug(slug: string) {
    return this.#get("slug", slug);
  }
  async #get(field: "id" | "slug", value: string) {
    try {
      const found = row(
        this.db.connection.prepare(`SELECT * FROM site_projects WHERE ${field} = ?`).get(value),
      );
      return found ? SqliteMappers.project(found) : undefined;
    } catch (cause) {
      throw new ApplicationError("PERSISTENCE_READ_FAILED", "Unable to read site project", {
        cause,
      });
    }
  }
  async save(project: SiteProject) {
    try {
      this.db.connection
        .prepare(
          `INSERT INTO site_projects (id,owner_id,name,slug,status,latest_version_id,published_version_id,published_deployment_id,created_at,updated_at) VALUES (@id,@owner,@name,@slug,@status,@latest,@published,@publishedDeployment,@created,@updated) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,name=excluded.name,slug=excluded.slug,status=excluded.status,latest_version_id=excluded.latest_version_id,published_version_id=excluded.published_version_id,published_deployment_id=excluded.published_deployment_id,updated_at=excluded.updated_at`,
        )
        .run({
          id: project.id,
          owner: project.ownerId,
          name: project.name,
          slug: project.slug,
          status: project.status,
          latest: project.latestVersionId ?? null,
          published: project.publishedVersionId ?? null,
          publishedDeployment: project.publishedDeploymentId ?? null,
          created: project.createdAt.toISOString(),
          updated: project.updatedAt.toISOString(),
        });
    } catch (cause) {
      writeError("Unable to save site project", cause);
    }
  }
  async listByOwner(ownerId: string) {
    try {
      return {
        items: rows(
          this.db.connection
            .prepare("SELECT * FROM site_projects WHERE owner_id = ? ORDER BY updated_at DESC")
            .all(ownerId),
        ).map((item) => SqliteMappers.project(item)),
      };
    } catch (cause) {
      throw new ApplicationError("PERSISTENCE_READ_FAILED", "Unable to list site projects", {
        cause,
      });
    }
  }
}
export class SqliteSiteVersionRepository implements SiteVersionRepository {
  constructor(private readonly db: SqliteDatabase) {}
  async getById(id: VersionId) {
    try {
      const found = row(
        this.db.connection.prepare("SELECT * FROM site_versions WHERE id = ?").get(id),
      );
      return found ? SqliteMappers.version(found) : undefined;
    } catch (cause) {
      throw new ApplicationError("PERSISTENCE_READ_FAILED", "Unable to read site version", {
        cause,
      });
    }
  }
  async save(version: SiteVersion) {
    try {
      insertVersion(this.db, version);
    } catch (cause) {
      writeError("Unable to create immutable site version", cause);
    }
  }
  async listBySite(siteId: SiteId) {
    try {
      return {
        items: rows(
          this.db.connection
            .prepare("SELECT * FROM site_versions WHERE site_id = ? ORDER BY version_number ASC")
            .all(siteId),
        ).map((item) => SqliteMappers.version(item)),
      };
    } catch (cause) {
      throw new ApplicationError("PERSISTENCE_READ_FAILED", "Unable to list site versions", {
        cause,
      });
    }
  }
}
export class SqliteSiteJobRepository implements SiteJobRepository {
  constructor(private readonly db: SqliteDatabase) {}
  async getById(id: JobId) {
    const found = row(this.db.connection.prepare("SELECT * FROM site_jobs WHERE id = ?").get(id));
    return found ? SqliteMappers.job(found) : undefined;
  }
  async save(job: SiteJob) {
    try {
      this.db.connection
        .prepare(
          `INSERT INTO site_jobs (id,site_id,user_id,type,status,progress,error_json,created_at,started_at,completed_at) VALUES (@id,@site,@user,@type,@status,@progress,@error,@created,@started,@completed) ON CONFLICT(id) DO UPDATE SET status=excluded.status,progress=excluded.progress,error_json=excluded.error_json,started_at=excluded.started_at,completed_at=excluded.completed_at`,
        )
        .run({
          id: job.id,
          site: job.siteId,
          user: job.userId,
          type: job.type,
          status: job.status,
          progress: job.progress,
          error: SqliteMappers.json(job.error),
          created: job.createdAt.toISOString(),
          started: job.startedAt?.toISOString() ?? null,
          completed: job.completedAt?.toISOString() ?? null,
        });
    } catch (cause) {
      writeError("Unable to save site job", cause);
    }
  }
  async listBySite(siteId: SiteId) {
    return {
      items: rows(
        this.db.connection
          .prepare("SELECT * FROM site_jobs WHERE site_id = ? ORDER BY created_at ASC")
          .all(siteId),
      ).map((item) => SqliteMappers.job(item)),
    };
  }
}
export class SqliteSiteDeploymentRepository implements SiteDeploymentRepository {
  constructor(private readonly db: SqliteDatabase) {}
  async getById(id: DeploymentId) {
    const found = row(
      this.db.connection.prepare("SELECT * FROM site_deployments WHERE id = ?").get(id),
    );
    return found ? SqliteMappers.deployment(found) : undefined;
  }
  async save(value: SiteDeployment) {
    try {
      this.db.connection
        .prepare(
          "INSERT INTO site_deployments (id,site_id,version_id,hostname,status,hosting_provider,deployment_artifact_ref,deployment_manifest_ref,created_at,completed_at,published_at,failure,metrics_json) VALUES (@id,@site,@version,@hostname,@status,@provider,@artifact,@manifest,@created,@completed,@published,@failure,@metrics) ON CONFLICT(id) DO NOTHING",
        )
        .run({
          id: value.id,
          site: value.siteId,
          version: value.versionId,
          hostname: value.hostname,
          status: value.status,
          provider: value.hostingProvider ?? null,
          artifact: value.deploymentArtifactRef ?? null,
          manifest: value.deploymentManifestRef ?? null,
          created: value.createdAt.toISOString(),
          completed: value.completedAt?.toISOString() ?? null,
          published: value.publishedAt?.toISOString() ?? null,
          failure: value.failure ?? null,
          metrics: SqliteMappers.json(value.metrics),
        });
    } catch (cause) {
      writeError("Unable to save deployment metadata", cause);
    }
  }
  async listBySite(siteId: SiteId) {
    return {
      items: rows(
        this.db.connection
          .prepare("SELECT * FROM site_deployments WHERE site_id = ? ORDER BY created_at ASC")
          .all(siteId),
      ).map((item) => SqliteMappers.deployment(item)),
    };
  }
}
export class SqliteSiteVersionCommitter implements SiteVersionCommitter {
  constructor(private readonly db: SqliteDatabase) {}
  async commit(project: SiteProject, draft: UnnumberedSiteVersion): Promise<SiteVersion> {
    try {
      return this.db.connection.transaction(() => {
        const found = this.db.connection
          .prepare(
            "SELECT COALESCE(MAX(version_number),0) AS value FROM site_versions WHERE site_id = ?",
          )
          .get(project.id) as { value: number };
        const version: SiteVersion = { ...draft, versionNumber: found.value + 1 };
        insertVersion(this.db, version);
        this.db.connection
          .prepare("UPDATE site_projects SET latest_version_id = ?, updated_at = ? WHERE id = ?")
          .run(version.id, new Date().toISOString(), project.id);
        return version;
      })();
    } catch (cause) {
      throw new ApplicationError(
        "PERSISTENCE_TRANSACTION_FAILED",
        "Unable to atomically create version and update project",
        { cause },
      );
    }
  }
}
function insertVersion(db: SqliteDatabase, version: SiteVersion): void {
  db.connection
    .prepare(
      `INSERT INTO site_versions (id,site_id,version_number,parent_version_id,source_artifact_ref,source_manifest_ref,build_artifact_ref,build_status,site_spec_json,site_spec_schema_version,technical_profile_id,template_id,template_version,change_summary_json,visual_qa_status,visual_qa_score,visual_qa_artifact_ref,final_screenshot_refs_json,usage_summary_json,runtime_schema_version,created_at) VALUES (@id,@site,@number,@parent,@source,@manifest,@build,@buildStatus,@spec,@specVersion,@profile,@template,@templateVersion,@changes,@qaStatus,@qaScore,@qaArtifact,@screenshots,@usage,@runtimeSchemaVersion,@created)`,
    )
    .run({
      id: version.id,
      site: version.siteId,
      number: version.versionNumber,
      parent: version.parentVersionId ?? null,
      source: version.sourceArtifactRef,
      manifest: version.sourceManifestRef ?? null,
      build: version.buildArtifactRef ?? null,
      buildStatus: version.buildStatus,
      spec: SqliteMappers.json(version.siteSpec),
      specVersion: version.siteSpec ? 1 : null,
      profile: version.technicalProfileId ?? null,
      template: version.templateId ?? null,
      templateVersion: version.templateVersion ?? null,
      changes: SqliteMappers.json(version.changeSummary),
      qaStatus: version.visualQAStatus ?? null,
      qaScore: version.visualQAScore ?? null,
      qaArtifact: version.visualQAArtifactRef ?? null,
      screenshots: SqliteMappers.json(version.finalScreenshotRefs),
      usage: SqliteMappers.json(version.usageSummary),
      runtimeSchemaVersion: version.runtimeSchemaVersion ?? null,
      created: version.createdAt.toISOString(),
    });
}
