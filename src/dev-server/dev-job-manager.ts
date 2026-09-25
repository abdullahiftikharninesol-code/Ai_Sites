import { randomUUID } from "node:crypto";
import type { SiteProgressEvent, InMemoryProgressBus } from "../sites/application/progress.js";
import type { AgentTaskTelemetry } from "../agents/intelligence/intelligence-types.js";

export type DevJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export interface DevJobEvent {
  readonly type: string;
  readonly stage: string;
  readonly message: string;
  readonly timestamp: string;
  readonly progress?: number;
  readonly intelligence?: AgentTaskTelemetry;
}
export interface DevJobRecord {
  readonly id: string;
  readonly operation: "GENERATE" | "EDIT";
  status: DevJobStatus;
  currentStage: string;
  readonly createdAt: string;
  updatedAt: string;
  projectId?: string;
  versionId?: string;
  preview?: { sessionId: string; url: string };
  error?: {
    code: string;
    message: string;
    status?: number;
    providerCode?: string;
    providerParam?: string;
    requestId?: string;
    retryable?: boolean;
    quotaCategory?: string;
    retryAfterSeconds?: number;
    diagnostics?: string;
  };
  intelligence?: readonly AgentTaskTelemetry[];
  readonly events: DevJobEvent[];
}
export class DevJobManager {
  readonly #jobs = new Map<string, DevJobRecord>();
  readonly #listeners = new Map<string, Set<(event: DevJobEvent) => void>>();
  #mutationRunning = false;
  constructor(private readonly progress: InMemoryProgressBus) {}
  start(
    operation: DevJobRecord["operation"],
    execute: (onIntelligence: (updates: readonly AgentTaskTelemetry[]) => void) => Promise<{
      projectId: string;
      versionId: string;
      preview?: { sessionId: string; url: string };
      intelligence?: readonly AgentTaskTelemetry[];
    }>,
  ): DevJobRecord {
    if (this.#mutationRunning)
      throw Object.assign(new Error("Another generation or edit is already running"), {
        code: "DEV_JOB_BUSY",
      });
    for (const [id, job] of this.#jobs) {
      if (job.status === "SUCCEEDED" || job.status === "FAILED") {
        if (this.#jobs.size >= 100 || Date.now() - Date.parse(job.updatedAt) > 86_400_000) {
          this.#jobs.delete(id);
          this.#listeners.delete(id);
        }
      }
    }
    const now = new Date().toISOString();
    const job: DevJobRecord = {
      id: randomUUID(),
      operation,
      status: "QUEUED",
      currentStage: "QUEUED",
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.#jobs.set(job.id, job);
    console.info(`[sites] job=${job.id} operation=${operation} status=QUEUED`);
    this.#emit(job, {
      type: "JOB_STARTED",
      stage: "QUEUED",
      message: `${operation.toLowerCase()} queued`,
      timestamp: now,
      progress: 0,
    });
    this.#mutationRunning = true;
    let workflowJobId: string | undefined;
    const unsubscribe = this.progress.subscribe((event: SiteProgressEvent) => {
      if (!workflowJobId) workflowJobId = event.jobId;
      if (event.jobId !== workflowJobId) return;
      job.projectId = event.siteId;
      job.currentStage = event.state;
      job.updatedAt = event.timestamp.toISOString();
      console.info(
        `[sites] job=${job.id} operation=${operation} stage=${event.state} progress=${event.progress}`,
      );
      this.#emit(job, {
        type: `WORKFLOW_${event.state}`,
        stage: event.state,
        message: event.message,
        timestamp: event.timestamp.toISOString(),
        progress: event.progress,
      });
    });
    const onIntelligence = (updates: readonly AgentTaskTelemetry[]) => {
      const tasks = new Map((job.intelligence ?? []).map((task) => [task.taskKind, task]));
      for (const task of updates) {
        tasks.set(task.taskKind, task);
        const timestamp = new Date().toISOString();
        job.updatedAt = timestamp;
        this.#emit(job, {
          type: "INTELLIGENCE_TASK_UPDATED",
          stage: "INTELLIGENCE",
          message: `${task.taskKind} ${task.status}`,
          timestamp,
          intelligence: task,
        });
      }
      job.intelligence = [...tasks.values()];
    };
    void Promise.resolve()
      .then(() => {
        job.status = "RUNNING";
        return execute(onIntelligence);
      })
      .then(({ projectId, versionId, preview, intelligence }) => {
        job.projectId = projectId;
        job.versionId = versionId;
        if (preview) job.preview = preview;
        if (intelligence) job.intelligence = intelligence;
        job.status = "SUCCEEDED";
        job.currentStage = "COMPLETED";
        job.updatedAt = new Date().toISOString();
        console.info(
          `[sites] job=${job.id} operation=${operation} status=SUCCEEDED project=${projectId} version=${versionId}`,
        );
        this.#emit(job, {
          type: "JOB_COMPLETED",
          stage: "COMPLETED",
          message: `${operation.toLowerCase()} completed`,
          timestamp: job.updatedAt,
          progress: 100,
        });
      })
      .catch((error: unknown) => {
        const candidate = (error ?? {}) as {
          code?: string;
          message?: string;
          retryable?: boolean;
          metadata?: Readonly<Record<string, unknown>>;
        };
        const metadata = candidate.metadata ?? {};
        // A failed job cannot leave a task mid-flight; keep its provider and
        // token fields and only settle the status.
        const unsettled = (job.intelligence ?? []).filter((task) => task.status === "RUNNING");
        if (unsettled.length)
          onIntelligence(unsettled.map((task) => ({ ...task, status: "FAILED", success: false })));
        job.status = "FAILED";
        job.currentStage = "FAILED";
        job.updatedAt = new Date().toISOString();
        job.error = {
          code: candidate.code ?? "DEV_OPERATION_FAILED",
          message: candidate.message ?? "Development operation failed",
          ...(typeof metadata.status === "number" ? { status: metadata.status } : {}),
          ...(typeof metadata.quotaCategory === "string"
            ? { quotaCategory: metadata.quotaCategory }
            : {}),
          ...(typeof metadata.retryAfterSeconds === "number"
            ? { retryAfterSeconds: metadata.retryAfterSeconds }
            : {}),
          ...(typeof metadata.providerCode === "string"
            ? { providerCode: metadata.providerCode }
            : {}),
          ...(typeof metadata.providerParam === "string"
            ? { providerParam: metadata.providerParam }
            : {}),
          ...(typeof metadata.requestId === "string" ? { requestId: metadata.requestId } : {}),
          ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
          ...(typeof metadata.diagnostics === "string"
            ? { diagnostics: metadata.diagnostics.slice(-8_000) }
            : {}),
        };
        console.error(
          `[sites] job=${job.id} operation=${operation} status=FAILED code=${job.error.code} message=${job.error.message}`,
          {
            ...(job.error.status !== undefined ? { status: job.error.status } : {}),
            ...(job.error.providerCode ? { providerCode: job.error.providerCode } : {}),
            ...(job.error.providerParam ? { providerParam: job.error.providerParam } : {}),
            ...(job.error.requestId ? { requestId: job.error.requestId } : {}),
            ...(job.error.retryable !== undefined ? { retryable: job.error.retryable } : {}),
          },
        );
        this.#emit(job, {
          type: "JOB_FAILED",
          stage: "FAILED",
          message: job.error.message,
          timestamp: job.updatedAt,
        });
      })
      .finally(() => {
        unsubscribe();
        this.#mutationRunning = false;
      });
    return job;
  }
  get(id: string) {
    return this.#jobs.get(id);
  }
  hasActiveProject(projectId: string) {
    return [...this.#jobs.values()].some(
      (job) => job.projectId === projectId && job.status !== "SUCCEEDED" && job.status !== "FAILED",
    );
  }
  subscribe(id: string, listener: (event: DevJobEvent) => void) {
    const set = this.#listeners.get(id) ?? new Set();
    set.add(listener);
    this.#listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(id);
    };
  }
  #emit(job: DevJobRecord, event: DevJobEvent) {
    job.events.push(event);
    if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    for (const listener of this.#listeners.get(job.id) ?? []) {
      try {
        listener(event);
      } catch {
        // A disconnected progress consumer must not change the workflow outcome.
      }
    }
  }
}
