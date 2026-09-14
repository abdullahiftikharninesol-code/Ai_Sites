import { randomUUID } from "node:crypto";
import type { LocalSiteGenerationPipeline } from "../sites/generation/local-site-generation-pipeline.js";
import type { LocalExecutionProvider } from "../execution/local/local-execution.provider.js";
import type { SiteId, VersionId } from "../shared/types.js";

export interface DevelopmentPreviewSession {
  readonly id: string;
  readonly siteId: SiteId;
  readonly versionId: VersionId;
  readonly environmentId: string;
  readonly url: string;
  readonly createdAt: string;
  lastAccessedAt: string;
}
export class DevelopmentPreviewManager {
  readonly #sessions = new Map<string, DevelopmentPreviewSession>();
  readonly #bySite = new Map<string, string>();
  readonly #pending = new Map<string, Promise<unknown>>();
  #closed = false;
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly pipeline: LocalSiteGenerationPipeline,
    private readonly execution: LocalExecutionProvider,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {
    this.#timer = setInterval(
      () =>
        void this.sweep().catch((error: unknown) =>
          console.error("[sites] preview cleanup failed", safeCleanupError(error)),
        ),
      Math.min(ttlMs, 60_000),
    );
    this.#timer.unref();
  }
  list() {
    return [...this.#sessions.values()];
  }
  get(id: string) {
    const session = this.#sessions.get(id);
    if (session) session.lastAccessedAt = new Date().toISOString();
    return session;
  }
  start(siteId: SiteId, versionId: VersionId) {
    if (this.#closed) return Promise.reject(new Error("Preview manager is closed"));
    return this.#serialize(siteId, () => this.#start(siteId, versionId));
  }
  async #start(siteId: SiteId, versionId: VersionId) {
    const old = this.#bySite.get(siteId);
    if (old) await this.#stop(old);
    const restored = await this.pipeline.restoreVersion(versionId);
    try {
      const preview = await this.execution.startPreview(restored.environmentId, { port: 0 });
      if (!preview.url) throw new Error("Preview URL was not created");
      const now = new Date().toISOString();
      const session: DevelopmentPreviewSession = {
        id: randomUUID(),
        siteId,
        versionId,
        environmentId: restored.environmentId,
        url: preview.url,
        createdAt: now,
        lastAccessedAt: now,
      };
      this.#sessions.set(session.id, session);
      this.#bySite.set(siteId, session.id);
      return session;
    } catch (error) {
      await this.pipeline.disposeRestoredEnvironment(restored.environmentId);
      throw error;
    }
  }
  stop(id: string) {
    const session = this.#sessions.get(id);
    return session ? this.#serialize(session.siteId, () => this.#stop(id)) : Promise.resolve(false);
  }
  async #stop(id: string) {
    const session = this.#sessions.get(id);
    if (!session) return false;
    await this.pipeline.disposeRestoredEnvironment(session.environmentId);
    this.#sessions.delete(id);
    if (this.#bySite.get(session.siteId) === id) this.#bySite.delete(session.siteId);
    return true;
  }
  async sweep(now = Date.now()) {
    for (const session of this.#sessions.values())
      if (now - Date.parse(session.lastAccessedAt) >= this.ttlMs) await this.stop(session.id);
  }
  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    await Promise.allSettled([...this.#pending.values()]);
    const results = await Promise.allSettled([...this.#sessions.keys()].map((id) => this.stop(id)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason as unknown),
        "Preview cleanup failed",
      );
  }
  #serialize<T>(siteId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.#pending.get(siteId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#pending.set(siteId, next);
    const cleanup = () => {
      if (this.#pending.get(siteId) === next) this.#pending.delete(siteId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}

function safeCleanupError(error: unknown) {
  const value = error as { code?: unknown; message?: unknown };
  return {
    code: typeof value.code === "string" ? value.code : "PREVIEW_CLEANUP_FAILED",
    message: typeof value.message === "string" ? value.message : "Preview cleanup failed",
  };
}
