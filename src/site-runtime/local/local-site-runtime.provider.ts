import { randomUUID } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteId } from "../../shared/types.js";
import type { SiteRuntimeProvider } from "../site-runtime-provider.js";
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
import {
  DEFAULT_RUNTIME_LIMITS,
  SiteRuntimeSpecValidator,
  type RuntimeLimits,
} from "../runtime-validator.js";

interface RuntimeMemoryState {
  readonly runtimes: Map<string, SiteRuntime>;
  readonly records: Map<string, SiteRuntimeRecord>;
}

const namedStates = new Map<string, RuntimeMemoryState>();
const emptyState = (): RuntimeMemoryState => ({ runtimes: new Map(), records: new Map() });
const emptyUsage = (): RuntimeUsageMetrics => ({
  reads: 0,
  creates: 0,
  updates: 0,
  deletes: 0,
  denied: 0,
  validationFailures: 0,
});
const recordKey = (runtimeId: string, collection: string, id: string) =>
  `${runtimeId}\u0000${collection}\u0000${id}`;
const recordPrefix = (runtimeId: string, collection?: string) =>
  `${runtimeId}\u0000${collection ? `${collection}\u0000` : ""}`;

/** Execution-only provider for tests and local, non-persistent workflows. */
export class LocalSiteRuntimeProvider implements SiteRuntimeProvider {
  readonly id = "memory-runtime";
  readonly #validator: SiteRuntimeSpecValidator;
  readonly #usage = new Map<string, RuntimeUsageMetrics>();
  readonly #state: RuntimeMemoryState;

  constructor(namespace = ":memory:", limits: RuntimeLimits = DEFAULT_RUNTIME_LIMITS) {
    this.#validator = new SiteRuntimeSpecValidator(limits);
    if (namespace === ":memory:") this.#state = emptyState();
    else {
      const existing = namedStates.get(namespace);
      this.#state = existing ?? emptyState();
      namedStates.set(namespace, this.#state);
    }
  }

  async provisionRuntime(siteId: SiteId, input: SiteRuntimeSpec): Promise<SiteRuntime> {
    const existing = this.#state.runtimes.get(siteId);
    if (existing) return structuredClone(existing);
    const spec = this.#validator.validate(input);
    const now = new Date();
    const runtime: SiteRuntime = {
      id: randomUUID(),
      siteId,
      status: spec.enabled ? "ACTIVE" : "DISABLED",
      provider: this.id,
      schemaVersion: 1,
      spec,
      createdAt: now,
      updatedAt: now,
    };
    this.#state.runtimes.set(siteId, structuredClone(runtime));
    return runtime;
  }

  async getRuntime(siteId: SiteId): Promise<SiteRuntime | undefined> {
    const runtime = this.#state.runtimes.get(siteId);
    return runtime ? structuredClone(runtime) : undefined;
  }

  async deleteRuntime(siteId: SiteId): Promise<void> {
    const runtime = this.#state.runtimes.get(siteId);
    if (runtime)
      for (const key of this.#state.records.keys())
        if (key.startsWith(recordPrefix(runtime.id))) this.#state.records.delete(key);
    this.#state.runtimes.delete(siteId);
  }

  async applySchema(
    siteId: SiteId,
    expectedVersion: number,
    input: SiteRuntimeSpec,
  ): Promise<SiteRuntime> {
    const next = this.#validator.validate(input);
    const current = this.#requireRuntime(siteId);
    if (current.schemaVersion !== expectedVersion)
      throw new ApplicationError("RUNTIME_MIGRATION_FAILED", "Runtime schema version conflict");
    this.#assertAdditive(current.spec, next);
    const updated: SiteRuntime = {
      ...current,
      status: next.enabled ? "ACTIVE" : "DISABLED",
      schemaVersion: expectedVersion + 1,
      spec: next,
      updatedAt: new Date(),
    };
    this.#state.runtimes.set(siteId, structuredClone(updated));
    return updated;
  }

  createRecord(
    siteId: SiteId,
    collectionName: string,
    data: unknown,
    ownerUserId?: string,
  ): Promise<SiteRuntimeRecord> {
    const { runtime, collection } = this.#context(siteId, collectionName);
    const now = new Date();
    const record: SiteRuntimeRecord = {
      id: randomUUID(),
      ...(ownerUserId ? { ownerUserId } : {}),
      data: this.#validate(runtime, collection, data),
      createdAt: now,
      updatedAt: now,
    };
    this.#state.records.set(
      recordKey(runtime.id, collectionName, record.id),
      structuredClone(record),
    );
    this.#increment(siteId, "creates");
    return Promise.resolve(record);
  }

  async getRecord(
    siteId: SiteId,
    collectionName: string,
    id: string,
  ): Promise<SiteRuntimeRecord | undefined> {
    const { runtime } = this.#context(siteId, collectionName);
    const record = this.#state.records.get(recordKey(runtime.id, collectionName, id));
    this.#increment(siteId, "reads");
    return record ? structuredClone(record) : undefined;
  }

  async listRecords(
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
    let items = [...this.#state.records.entries()]
      .filter(([key]) => key.startsWith(recordPrefix(runtime.id, collectionName)))
      .map(([, value]) => structuredClone(value))
      .filter((item) =>
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
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }

  async updateRecord(
    siteId: SiteId,
    collectionName: string,
    id: string,
    data: unknown,
  ): Promise<SiteRuntimeRecord> {
    const { runtime, collection } = this.#context(siteId, collectionName);
    const key = recordKey(runtime.id, collectionName, id);
    const current = this.#state.records.get(key);
    if (!current)
      throw new ApplicationError("RUNTIME_RECORD_NOT_FOUND", "Runtime record was not found");
    const patch = this.#validate(runtime, collection, data, true);
    const updated: SiteRuntimeRecord = {
      ...current,
      data: this.#validate(runtime, collection, { ...current.data, ...patch }),
      updatedAt: new Date(),
    };
    this.#state.records.set(key, structuredClone(updated));
    this.#increment(siteId, "updates");
    return updated;
  }

  deleteRecord(siteId: SiteId, collectionName: string, id: string): Promise<void> {
    const { runtime } = this.#context(siteId, collectionName);
    if (!this.#state.records.delete(recordKey(runtime.id, collectionName, id)))
      throw new ApplicationError("RUNTIME_RECORD_NOT_FOUND", "Runtime record was not found");
    this.#increment(siteId, "deletes");
    return Promise.resolve();
  }

  async storageMetrics(siteId: SiteId): Promise<RuntimeStorageMetrics> {
    const runtime = this.#requireRuntime(siteId);
    const records = [...this.#state.records.entries()]
      .filter(([key]) => key.startsWith(recordPrefix(runtime.id)))
      .map(([, value]) => value);
    return {
      collections: runtime.spec.collections.length,
      records: records.length,
      bytes: records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.data)), 0),
    };
  }

  usageMetrics(siteId: SiteId): RuntimeUsageMetrics {
    return { ...(this.#usage.get(siteId) ?? emptyUsage()) };
  }

  recordDenied(siteId: SiteId): void {
    this.#increment(siteId, "denied");
  }

  close(): void {}

  #requireRuntime(siteId: SiteId): SiteRuntime {
    const runtime = this.#state.runtimes.get(siteId);
    if (!runtime)
      throw new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Site runtime was not found");
    return structuredClone(runtime);
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

  #increment(siteId: string, key: keyof RuntimeUsageMetrics): void {
    const value = this.#usage.get(siteId) ?? emptyUsage();
    this.#usage.set(siteId, { ...value, [key]: value[key] + 1 });
  }
}
