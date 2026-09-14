import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteId } from "../../shared/types.js";
import type { SiteRuntimeProvider } from "../site-runtime-provider.js";
import {
  SiteRuntimeSpecValidator,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeLimits,
} from "../runtime-validator.js";
import type {
  RuntimeListOptions,
  RuntimeListResult,
  RuntimeStorageMetrics,
  RuntimeUsageMetrics,
  SiteRuntime,
  SiteRuntimeCollectionSpec,
  SiteRuntimeRecord,
  SiteRuntimeSpec,
} from "../runtime-types.js";

type Row = Record<string, unknown>;
const emptyUsage = (): RuntimeUsageMetrics => ({
  reads: 0,
  creates: 0,
  updates: 0,
  deletes: 0,
  denied: 0,
  validationFailures: 0,
});
export class LocalSiteRuntimeProvider implements SiteRuntimeProvider {
  readonly id = "local-runtime";
  readonly databasePath: string;
  readonly #db: Database.Database;
  readonly #validator: SiteRuntimeSpecValidator;
  readonly #usage = new Map<string, RuntimeUsageMetrics>();
  #closed = false;
  constructor(path: string, limits: RuntimeLimits = DEFAULT_RUNTIME_LIMITS) {
    this.databasePath = path === ":memory:" ? path : resolve(path);
    if (this.databasePath !== ":memory:")
      mkdirSync(dirname(this.databasePath), { recursive: true });
    this.#db = new Database(this.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS site_runtimes (id TEXT PRIMARY KEY, site_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, provider TEXT NOT NULL, schema_version INTEGER NOT NULL, spec_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_schemas (runtime_id TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(runtime_id,version), FOREIGN KEY(runtime_id) REFERENCES site_runtimes(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS runtime_records (runtime_id TEXT NOT NULL, collection_name TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(runtime_id,collection_name,id), FOREIGN KEY(runtime_id) REFERENCES site_runtimes(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_runtime_records_collection ON runtime_records(runtime_id,collection_name,created_at,id);
    `);
    const columns = this.#db.prepare("PRAGMA table_info(runtime_records)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "owner_user_id"))
      this.#db.exec("ALTER TABLE runtime_records ADD COLUMN owner_user_id TEXT");
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runtime_records_owner ON runtime_records(runtime_id,collection_name,owner_user_id)",
    );
    this.#validator = new SiteRuntimeSpecValidator(limits);
  }
  provisionRuntime(siteId: SiteId, input: SiteRuntimeSpec): Promise<SiteRuntime> {
    const spec = this.#validator.validate(input);
    const existing = this.#runtimeRow(siteId);
    if (existing) return Promise.resolve(this.#mapRuntime(existing));
    const now = new Date().toISOString();
    const runtime = {
      id: randomUUID(),
      siteId,
      status: spec.enabled ? "ACTIVE" : "DISABLED",
      provider: this.id,
      schemaVersion: 1,
      spec,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    } satisfies SiteRuntime;
    try {
      this.#db.transaction(() => {
        this.#db
          .prepare(
            "INSERT INTO site_runtimes (id,site_id,status,provider,schema_version,spec_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            runtime.id,
            siteId,
            runtime.status,
            runtime.provider,
            1,
            JSON.stringify(spec),
            now,
            now,
          );
        this.#db
          .prepare(
            "INSERT INTO runtime_schemas (runtime_id,version,spec_json,created_at) VALUES (?,?,?,?)",
          )
          .run(runtime.id, 1, JSON.stringify(spec), now);
      })();
      return Promise.resolve(runtime);
    } catch (cause) {
      throw this.#providerError("Runtime provisioning failed", cause);
    }
  }
  getRuntime(siteId: SiteId): Promise<SiteRuntime | undefined> {
    const found = this.#runtimeRow(siteId);
    return Promise.resolve(found ? this.#mapRuntime(found) : undefined);
  }
  deleteRuntime(siteId: SiteId): Promise<void> {
    this.#db.prepare("DELETE FROM site_runtimes WHERE site_id=?").run(siteId);
    return Promise.resolve();
  }
  async applySchema(
    siteId: SiteId,
    expectedVersion: number,
    input: SiteRuntimeSpec,
  ): Promise<SiteRuntime> {
    await Promise.resolve();
    const next = this.#validator.validate(input);
    const currentRow = this.#runtimeRow(siteId);
    if (!currentRow)
      throw new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Site runtime was not found");
    const current = this.#mapRuntime(currentRow);
    if (current.schemaVersion !== expectedVersion)
      throw new ApplicationError("RUNTIME_MIGRATION_FAILED", "Runtime schema version conflict");
    this.#assertAdditive(current.spec, next);
    const version = expectedVersion + 1;
    const now = new Date().toISOString();
    try {
      this.#db.transaction(() => {
        this.#db
          .prepare(
            "INSERT INTO runtime_schemas (runtime_id,version,spec_json,created_at) VALUES (?,?,?,?)",
          )
          .run(current.id, version, JSON.stringify(next), now);
        this.#db
          .prepare(
            "UPDATE site_runtimes SET schema_version=?,spec_json=?,status=?,updated_at=? WHERE id=?",
          )
          .run(
            version,
            JSON.stringify(next),
            next.enabled ? "ACTIVE" : "DISABLED",
            now,
            current.id,
          );
      })();
    } catch (cause) {
      throw new ApplicationError("RUNTIME_MIGRATION_FAILED", "Runtime migration failed", { cause });
    }
    return {
      ...current,
      schemaVersion: version,
      spec: next,
      status: next.enabled ? "ACTIVE" : "DISABLED",
      updatedAt: new Date(now),
    };
  }
  createRecord(
    siteId: SiteId,
    collectionName: string,
    data: unknown,
    ownerUserId?: string,
  ): Promise<SiteRuntimeRecord> {
    const { runtime, collection } = this.#context(siteId, collectionName);
    const normalized = this.#validate(runtime, collection, data);
    const now = new Date();
    const id = randomUUID();
    const json = JSON.stringify(normalized);
    this.#db
      .prepare(
        "INSERT INTO runtime_records (runtime_id,collection_name,id,data_json,size_bytes,created_at,updated_at,owner_user_id) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        runtime.id,
        collectionName,
        id,
        json,
        Buffer.byteLength(json),
        now.toISOString(),
        now.toISOString(),
        ownerUserId ?? null,
      );
    this.#increment(siteId, "creates");
    return Promise.resolve({
      id,
      ...(ownerUserId ? { ownerUserId } : {}),
      createdAt: now,
      updatedAt: now,
      data: normalized,
    });
  }
  getRecord(
    siteId: SiteId,
    collection: string,
    id: string,
  ): Promise<SiteRuntimeRecord | undefined> {
    const context = this.#context(siteId, collection);
    const found = this.#db
      .prepare("SELECT * FROM runtime_records WHERE runtime_id=? AND collection_name=? AND id=?")
      .get(context.runtime.id, collection, id) as Row | undefined;
    this.#increment(siteId, "reads");
    return Promise.resolve(found ? this.#mapRecord(found) : undefined);
  }
  listRecords(
    siteId: SiteId,
    collectionName: string,
    options: RuntimeListOptions = {},
  ): Promise<RuntimeListResult> {
    const { runtime, collection } = this.#context(siteId, collectionName);
    const limit = Math.min(
      Math.max(1, options.limit ?? this.#validator.limits.defaultPageSize),
      this.#validator.limits.maxPageSize,
    );
    const offset = Math.max(0, options.offset ?? 0);
    const allowed = new Set(collection.fields.map((field) => field.name));
    for (const key of Object.keys(options.filters ?? {}))
      if (!allowed.has(key))
        throw new ApplicationError("RUNTIME_VALIDATION_FAILED", `Unknown filter field: ${key}`);
    if (
      options.orderBy &&
      !allowed.has(options.orderBy) &&
      !["createdAt", "updatedAt"].includes(options.orderBy)
    )
      throw new ApplicationError("RUNTIME_VALIDATION_FAILED", "Invalid order field");
    let items = (
      this.#db
        .prepare("SELECT * FROM runtime_records WHERE runtime_id=? AND collection_name=?")
        .all(runtime.id, collectionName) as Row[]
    ).map((row) => this.#mapRecord(row));
    items = items.filter((item) =>
      Object.entries(options.filters ?? {}).every(([key, value]) => item.data[key] === value),
    );
    if (options.ownerUserId)
      items = items.filter((item) => item.ownerUserId === options.ownerUserId);
    const key = options.orderBy ?? "createdAt";
    const direction = options.direction === "asc" ? 1 : -1;
    items.sort(
      (a, b) =>
        String(key in a ? a[key as "createdAt"] : a.data[key]).localeCompare(
          String(key in b ? b[key as "createdAt"] : b.data[key]),
        ) * direction,
    );
    this.#increment(siteId, "reads");
    return Promise.resolve({
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    });
  }
  updateRecord(
    siteId: SiteId,
    collectionName: string,
    id: string,
    data: unknown,
  ): Promise<SiteRuntimeRecord> {
    const { runtime, collection } = this.#context(siteId, collectionName);
    const current = this.#record(runtime.id, collectionName, id);
    if (!current)
      throw new ApplicationError("RUNTIME_RECORD_NOT_FOUND", "Runtime record was not found");
    const patch = this.#validate(runtime, collection, data, true);
    const merged = this.#validate(runtime, collection, { ...current.data, ...patch });
    const now = new Date();
    const json = JSON.stringify(merged);
    this.#db
      .prepare(
        "UPDATE runtime_records SET data_json=?,size_bytes=?,updated_at=? WHERE runtime_id=? AND collection_name=? AND id=?",
      )
      .run(json, Buffer.byteLength(json), now.toISOString(), runtime.id, collectionName, id);
    this.#increment(siteId, "updates");
    return Promise.resolve({ ...current, data: merged, updatedAt: now });
  }
  deleteRecord(siteId: SiteId, collection: string, id: string): Promise<void> {
    const { runtime } = this.#context(siteId, collection);
    const result = this.#db
      .prepare("DELETE FROM runtime_records WHERE runtime_id=? AND collection_name=? AND id=?")
      .run(runtime.id, collection, id);
    if (!result.changes)
      throw new ApplicationError("RUNTIME_RECORD_NOT_FOUND", "Runtime record was not found");
    this.#increment(siteId, "deletes");
    return Promise.resolve();
  }
  storageMetrics(siteId: SiteId): Promise<RuntimeStorageMetrics> {
    const runtime = this.#requireRuntime(siteId);
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) records,COALESCE(SUM(size_bytes),0) bytes FROM runtime_records WHERE runtime_id=?",
      )
      .get(runtime.id) as { records: number; bytes: number };
    return Promise.resolve({
      collections: runtime.spec.collections.length,
      records: row.records,
      bytes: row.bytes,
    });
  }
  usageMetrics(siteId: SiteId): RuntimeUsageMetrics {
    return { ...(this.#usage.get(siteId) ?? emptyUsage()) };
  }
  recordDenied(siteId: SiteId): void {
    this.#increment(siteId, "denied");
  }
  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
  #runtimeRow(siteId: SiteId): Row | undefined {
    return this.#db.prepare("SELECT * FROM site_runtimes WHERE site_id=?").get(siteId) as
      Row | undefined;
  }
  #requireRuntime(siteId: SiteId): SiteRuntime {
    const row = this.#runtimeRow(siteId);
    if (!row) throw new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Site runtime was not found");
    return this.#mapRuntime(row);
  }
  #context(
    siteId: SiteId,
    collectionName: string,
  ): { runtime: SiteRuntime; collection: SiteRuntimeCollectionSpec } {
    const runtime = this.#requireRuntime(siteId);
    const collection = runtime.spec.collections.find((item) => item.name === collectionName);
    if (!collection)
      throw new ApplicationError(
        "RUNTIME_COLLECTION_NOT_FOUND",
        "Runtime collection was not found",
      );
    return { runtime, collection };
  }
  #record(runtimeId: string, collection: string, id: string): SiteRuntimeRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM runtime_records WHERE runtime_id=? AND collection_name=? AND id=?")
      .get(runtimeId, collection, id) as Row | undefined;
    return row ? this.#mapRecord(row) : undefined;
  }
  #validate(
    runtime: SiteRuntime,
    collection: SiteRuntimeCollectionSpec,
    data: unknown,
    partial = false,
  ) {
    try {
      return this.#validator.validateRecord(collection, data, partial);
    } catch (cause) {
      this.#increment(runtime.siteId, "validationFailures");
      throw cause;
    }
  }
  #assertAdditive(current: SiteRuntimeSpec, next: SiteRuntimeSpec): void {
    if (!next.enabled)
      throw new ApplicationError(
        "RUNTIME_MIGRATION_FAILED",
        "Disabling runtime is not an additive migration",
      );
    for (const oldCollection of current.collections) {
      const collection = next.collections.find((item) => item.name === oldCollection.name);
      if (!collection)
        throw new ApplicationError(
          "RUNTIME_MIGRATION_FAILED",
          `Collection removal is unsupported: ${oldCollection.name}`,
        );
      for (const oldField of oldCollection.fields) {
        const field = collection.fields.find((item) => item.name === oldField.name);
        if (!field || JSON.stringify(field) !== JSON.stringify(oldField))
          throw new ApplicationError(
            "RUNTIME_MIGRATION_FAILED",
            `Field removal/change is unsupported: ${oldCollection.name}.${oldField.name}`,
          );
      }
      for (const field of collection.fields.filter(
        (item) => !oldCollection.fields.some((old) => old.name === item.name),
      ))
        if (field.required && field.defaultValue === undefined)
          throw new ApplicationError(
            "RUNTIME_MIGRATION_FAILED",
            `New required field needs a default: ${field.name}`,
          );
    }
  }
  #mapRuntime(row: Row): SiteRuntime {
    return {
      id: String(row.id),
      siteId: String(row.site_id) as SiteId,
      status: String(row.status) as SiteRuntime["status"],
      provider: String(row.provider),
      schemaVersion: Number(row.schema_version),
      spec: JSON.parse(String(row.spec_json)) as SiteRuntimeSpec,
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }
  #mapRecord(row: Row): SiteRuntimeRecord {
    return {
      id: String(row.id),
      ...(typeof row.owner_user_id === "string" ? { ownerUserId: row.owner_user_id } : {}),
      data: JSON.parse(String(row.data_json)) as Readonly<
        Record<string, string | number | boolean>
      >,
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }
  #increment(siteId: string, key: keyof RuntimeUsageMetrics): void {
    const value = this.#usage.get(siteId) ?? emptyUsage();
    this.#usage.set(siteId, { ...value, [key]: value[key] + 1 });
  }
  #providerError(message: string, cause: unknown): ApplicationError {
    return new ApplicationError("RUNTIME_PROVIDER_FAILED", message, { cause });
  }
}
