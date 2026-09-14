import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { ApplicationError } from "../../app/errors/application-error.js";
const migrations = [
  {
    version: 1,
    sql: `
    CREATE TABLE site_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, latest_version_id TEXT, published_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE site_versions (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, version_number INTEGER NOT NULL, parent_version_id TEXT, source_artifact_ref TEXT NOT NULL, source_manifest_ref TEXT, build_artifact_ref TEXT, build_status TEXT NOT NULL, site_spec_json TEXT, site_spec_schema_version INTEGER, technical_profile_id TEXT, template_id TEXT, template_version INTEGER, change_summary_json TEXT, visual_qa_status TEXT, visual_qa_score REAL, visual_qa_artifact_ref TEXT, final_screenshot_refs_json TEXT, usage_summary_json TEXT, created_at TEXT NOT NULL, UNIQUE(site_id, version_number), FOREIGN KEY(site_id) REFERENCES site_projects(id));
    CREATE TABLE site_jobs (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL, error_json TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, FOREIGN KEY(site_id) REFERENCES site_projects(id));
    CREATE TABLE site_deployments (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, version_id TEXT NOT NULL, hostname TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(site_id) REFERENCES site_projects(id));
    CREATE INDEX idx_projects_owner ON site_projects(owner_id, updated_at DESC);
    CREATE INDEX idx_versions_site ON site_versions(site_id, version_number);
    CREATE INDEX idx_jobs_site ON site_jobs(site_id, created_at);
    CREATE TRIGGER site_versions_immutable_update BEFORE UPDATE ON site_versions BEGIN SELECT RAISE(ABORT, 'site versions are immutable'); END;
    CREATE TRIGGER site_versions_immutable_delete BEFORE DELETE ON site_versions BEGIN SELECT RAISE(ABORT, 'site versions are immutable'); END;
  `,
  },
  {
    version: 2,
    sql: `CREATE TABLE artifact_records (storage_key TEXT PRIMARY KEY, kind TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, site_id TEXT, version_id TEXT, created_at TEXT NOT NULL); CREATE INDEX idx_artifacts_site ON artifact_records(site_id);`,
  },
  {
    version: 3,
    sql: `ALTER TABLE site_projects ADD COLUMN published_deployment_id TEXT; ALTER TABLE site_deployments ADD COLUMN hosting_provider TEXT; ALTER TABLE site_deployments ADD COLUMN deployment_artifact_ref TEXT; ALTER TABLE site_deployments ADD COLUMN deployment_manifest_ref TEXT; ALTER TABLE site_deployments ADD COLUMN completed_at TEXT; ALTER TABLE site_deployments ADD COLUMN published_at TEXT; ALTER TABLE site_deployments ADD COLUMN failure TEXT; ALTER TABLE site_deployments ADD COLUMN metrics_json TEXT;`,
  },
  {
    version: 4,
    sql: `ALTER TABLE site_versions ADD COLUMN runtime_schema_version INTEGER;`,
  },
  {
    version: 5,
    sql: `CREATE TABLE custom_domains (id TEXT PRIMARY KEY,site_id TEXT NOT NULL,hostname TEXT NOT NULL UNIQUE,status TEXT NOT NULL,verification_method TEXT NOT NULL,verification_token_hash TEXT NOT NULL,challenge_expires_at TEXT NOT NULL,certificate_status TEXT NOT NULL,verification_attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,verified_at TEXT,activated_at TEXT,disabled_at TEXT,FOREIGN KEY(site_id) REFERENCES site_projects(id)); CREATE INDEX idx_custom_domains_site ON custom_domains(site_id,created_at); CREATE INDEX idx_custom_domains_active_host ON custom_domains(hostname,status);`,
  },
  {
    version: 6,
    sql: `CREATE TABLE site_deletion_context (site_id TEXT PRIMARY KEY); DROP TRIGGER site_versions_immutable_delete; CREATE TRIGGER site_versions_immutable_delete BEFORE DELETE ON site_versions WHEN NOT EXISTS (SELECT 1 FROM site_deletion_context WHERE site_id=OLD.site_id) BEGIN SELECT RAISE(ABORT, 'site versions are immutable'); END;`,
  },
];
export class SqliteDatabase {
  readonly connection: Database.Database;
  readonly path: string;
  #closed = false;
  constructor(path: string) {
    this.path = path === ":memory:" ? path : resolve(path);
    try {
      if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
      this.connection = new Database(this.path);
      this.connection.pragma("foreign_keys = ON");
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("busy_timeout = 5000");
      this.#migrate();
    } catch (cause) {
      throw new ApplicationError(
        "PERSISTENCE_INITIALIZATION_FAILED",
        "Unable to initialize SQLite metadata store",
        { cause },
      );
    }
  }
  get migrationVersion(): number {
    return Number(
      (this.connection.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
  }
  close(): void {
    if (!this.#closed) {
      this.connection.close();
      this.#closed = true;
    }
  }
  deleteSite(siteId: string): readonly string[] {
    try {
      return this.connection.transaction(() => {
        const artifactKeys = (
          this.connection
            .prepare("SELECT storage_key FROM artifact_records WHERE site_id=?")
            .all(siteId) as Array<{ storage_key: string }>
        ).map(({ storage_key }) => storage_key);
        this.connection
          .prepare("INSERT INTO site_deletion_context (site_id) VALUES (?)")
          .run(siteId);
        this.connection
          .prepare(
            "UPDATE site_projects SET latest_version_id=NULL,published_version_id=NULL,published_deployment_id=NULL WHERE id=?",
          )
          .run(siteId);
        this.connection.prepare("DELETE FROM custom_domains WHERE site_id=?").run(siteId);
        this.connection.prepare("DELETE FROM site_deployments WHERE site_id=?").run(siteId);
        this.connection.prepare("DELETE FROM site_jobs WHERE site_id=?").run(siteId);
        this.connection.prepare("DELETE FROM site_versions WHERE site_id=?").run(siteId);
        this.connection.prepare("DELETE FROM artifact_records WHERE site_id=?").run(siteId);
        this.connection.prepare("DELETE FROM site_projects WHERE id=?").run(siteId);
        this.connection.prepare("DELETE FROM site_deletion_context WHERE site_id=?").run(siteId);
        return artifactKeys;
      })();
    } catch (cause) {
      throw new ApplicationError(
        "PERSISTENCE_TRANSACTION_FAILED",
        "Unable to delete site project",
        {
          cause,
        },
      );
    }
  }
  #migrate(): void {
    const current = Number(
      (this.connection.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    for (const migration of migrations
      .filter((item) => item.version > current)
      .sort((a, b) => a.version - b.version))
      this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection.pragma(`user_version = ${migration.version}`);
      })();
  }
}
