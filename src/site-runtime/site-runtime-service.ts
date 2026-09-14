import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteProjectRepository } from "../persistence/repositories.js";
import type { SiteId } from "../shared/types.js";
import type { SiteRuntimeProvider } from "./site-runtime-provider.js";
import type { RuntimeListOptions, RuntimeOperation } from "./runtime-types.js";
import { LocalRuntimeRateLimiter } from "./runtime-rate-limiter.js";

export type RuntimeActor =
  | { readonly kind: "PUBLIC"; readonly clientId: string }
  | { readonly kind: "AUTHENTICATED"; readonly clientId: string; readonly userId: string }
  | { readonly kind: "INTERNAL"; readonly ownerId?: string };
export class SiteRuntimeService {
  constructor(
    private readonly projects: SiteProjectRepository,
    private readonly provider: SiteRuntimeProvider,
    private readonly limiter = new LocalRuntimeRateLimiter(),
  ) {}
  async listCollections(siteId: SiteId, actor: RuntimeActor) {
    const runtime = await this.#runtime(siteId, actor);
    return runtime.spec.collections.map((collection) => ({
      name: collection.name,
      fields: collection.fields,
      access: collection.access ?? {},
    }));
  }
  async describeCollection(siteId: SiteId, collection: string, actor: RuntimeActor) {
    const runtime = await this.#runtime(siteId, actor);
    const found = runtime.spec.collections.find((item) => item.name === collection);
    if (!found)
      throw new ApplicationError(
        "RUNTIME_COLLECTION_NOT_FOUND",
        "Runtime collection was not found",
      );
    return found;
  }
  async create(siteId: SiteId, collection: string, data: unknown, actor: RuntimeActor) {
    const policy = await this.#authorize(siteId, collection, "create", actor);
    return this.provider.createRecord(
      siteId,
      collection,
      data,
      policy === "OWNER" && actor.kind === "AUTHENTICATED" ? actor.userId : undefined,
    );
  }
  async get(siteId: SiteId, collection: string, id: string, actor: RuntimeActor) {
    const policy = await this.#authorize(siteId, collection, "read", actor);
    const record = await this.provider.getRecord(siteId, collection, id);
    if (!record)
      throw new ApplicationError("RUNTIME_RECORD_NOT_FOUND", "Runtime record was not found");
    this.#assertOwner(policy, actor, record.ownerUserId);
    return record;
  }
  async list(siteId: SiteId, collection: string, options: RuntimeListOptions, actor: RuntimeActor) {
    const policy = await this.#authorize(siteId, collection, "read", actor);
    return this.provider.listRecords(siteId, collection, {
      ...options,
      ...(policy === "OWNER" && actor.kind === "AUTHENTICATED"
        ? { ownerUserId: actor.userId }
        : {}),
    });
  }
  async update(siteId: SiteId, collection: string, id: string, data: unknown, actor: RuntimeActor) {
    const policy = await this.#authorize(siteId, collection, "update", actor);
    if (policy === "OWNER")
      this.#assertOwner(
        policy,
        actor,
        (await this.provider.getRecord(siteId, collection, id))?.ownerUserId,
      );
    return this.provider.updateRecord(siteId, collection, id, data);
  }
  async delete(siteId: SiteId, collection: string, id: string, actor: RuntimeActor) {
    const policy = await this.#authorize(siteId, collection, "delete", actor);
    if (policy === "OWNER")
      this.#assertOwner(
        policy,
        actor,
        (await this.provider.getRecord(siteId, collection, id))?.ownerUserId,
      );
    return this.provider.deleteRecord(siteId, collection, id);
  }
  async #runtime(siteId: SiteId, actor: RuntimeActor) {
    const project = await this.projects.getById(siteId);
    if (!project)
      throw new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Site runtime was not found");
    if (actor.kind === "INTERNAL" && actor.ownerId && project.ownerId !== actor.ownerId)
      throw new ApplicationError("RUNTIME_OPERATION_FORBIDDEN", "Runtime operation is forbidden");
    const runtime = await this.provider.getRuntime(siteId);
    if (!runtime || runtime.status !== "ACTIVE")
      throw new ApplicationError("SITE_RUNTIME_NOT_FOUND", "Site runtime was not found");
    return runtime;
  }
  async #authorize(
    siteId: SiteId,
    collectionName: string,
    operation: RuntimeOperation,
    actor: RuntimeActor,
  ): Promise<"PUBLIC" | "AUTHENTICATED" | "OWNER" | "INTERNAL"> {
    if (actor.kind === "PUBLIC") this.limiter.consume(`${siteId}:${actor.clientId}:${operation}`);
    const runtime = await this.#runtime(siteId, actor);
    const collection = runtime.spec.collections.find((item) => item.name === collectionName);
    if (!collection)
      throw new ApplicationError(
        "RUNTIME_COLLECTION_NOT_FOUND",
        "Runtime collection was not found",
      );
    if (actor.kind === "INTERNAL") return "INTERNAL";
    if (actor.kind === "PUBLIC" && collection.access?.public?.[operation] === true) return "PUBLIC";
    if (actor.kind === "AUTHENTICATED" && collection.access?.owner?.[operation] === true)
      return "OWNER";
    if (actor.kind === "AUTHENTICATED" && collection.access?.authenticated?.[operation] === true)
      return "AUTHENTICATED";
    {
      const local = this.provider as SiteRuntimeProvider & { recordDenied?(siteId: SiteId): void };
      local.recordDenied?.(siteId);
      throw new ApplicationError("RUNTIME_OPERATION_FORBIDDEN", "Runtime operation is forbidden");
    }
  }
  #assertOwner(policy: string, actor: RuntimeActor, ownerUserId?: string): void {
    if (
      policy === "OWNER" &&
      (actor.kind !== "AUTHENTICATED" || !ownerUserId || ownerUserId !== actor.userId)
    ) {
      throw new ApplicationError("RUNTIME_OPERATION_FORBIDDEN", "Runtime operation is forbidden");
    }
  }
}
