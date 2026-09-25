import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { DevJobEvent, DevJobRecord } from "../../dev-server/dev-job-manager.js";
import {
  SITES_SOCKET_EVENTS,
  type SitesCancelJobRequest,
  type SitesClientToServerEvents,
  type SitesCreateJobRequest,
  type SitesEditJobRequest,
  type SitesJobAck,
  type SitesJobOperation,
  type SitesJobProgressPayload,
  type SitesServerToClientEvents,
  type SitesSocketStage,
} from "../../shared/sites-socket-contract.js";

type SitesSocket = Socket<SitesClientToServerEvents, SitesServerToClientEvents>;
type SitesIo = Server<SitesClientToServerEvents, SitesServerToClientEvents>;

export interface SitesSocketService {
  readonly userId: string;
  readonly jobs: {
    get(id: string): DevJobRecord | undefined;
    subscribe(id: string, listener: (event: DevJobEvent) => void): () => void;
  };
  generate(prompt: string): DevJobRecord;
  edit(siteId: string, prompt: string, baseVersionId?: string): Promise<DevJobRecord>;
}

export interface SitesSocketOptions {
  readonly allowedOrigins?: readonly string[];
  readonly resolveOwnerId?: (socket: SitesSocket, service: SitesSocketService) => string;
}

const requestIdFor = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 128
    ? value.trim()
    : randomUUID();

const requirePrompt = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 20_000)
    throw Object.assign(new Error("prompt must contain 3 to 20000 characters"), {
      code: "INVALID_REQUEST",
    });
  return value.trim();
};

const requireIdentifier = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200)
    throw Object.assign(new Error(`${name} is required`), { code: "INVALID_REQUEST" });
  return value.trim();
};

/**
 * Socket.IO only supplies an acknowledgement when the client asked for one, so
 * a client that omits it must not be able to throw inside a handler.
 */
const safeAcknowledge = (acknowledge: unknown, response: SitesJobAck): void => {
  if (typeof acknowledge === "function") (acknowledge as (response: SitesJobAck) => void)(response);
};

/** Emitting without a payload shifts the acknowledgement into the first argument. */
const socketArguments = <TRequest>(request: unknown, acknowledge: unknown) =>
  typeof request === "function"
    ? { request: undefined as Partial<TRequest> | undefined, acknowledge: request as unknown }
    : { request: request as Partial<TRequest> | undefined, acknowledge };

const rejectedAck = (requestId: string, error: unknown): SitesJobAck => {
  const candidate = (error ?? {}) as { code?: unknown; message?: unknown; retryable?: unknown };
  return {
    success: false,
    requestId,
    status: "rejected",
    error: {
      code: typeof candidate.code === "string" ? candidate.code : "DEV_REQUEST_FAILED",
      message:
        typeof candidate.message === "string" ? candidate.message : "Development request failed",
      retryable: candidate.retryable === true,
    },
  };
};

const socketStage = (operation: SitesJobOperation, stage: string): SitesSocketStage => {
  if (stage === "COMPLETED") return "COMPLETED";
  if (stage === "BUILDING") return "BUILDING";
  if (["PREVIEW_READY", "QA_RUNNING", "WAITING_FOR_USER", "SAVING", "DEPLOYING"].includes(stage))
    return "CHECKING";
  if (operation === "EDIT") return "UPDATING";
  if (["PLANNING", "DESIGNING"].includes(stage)) return "UNDERSTANDING";
  if (stage === "CREATING_ENVIRONMENT") return "PREPARING";
  if (stage === "GENERATING") return "GENERATING";
  return "QUEUED";
};

const forwardJob = (
  io: SitesIo,
  ownerId: string,
  service: SitesSocketService,
  requestId: string,
  job: DevJobRecord,
): void => {
  let terminalSent = false;
  let lastStage = socketStage(job.operation, job.currentStage);
  // The job manager's JOB_STARTED/JOB_COMPLETED markers restate the pipeline's
  // own QUEUED and COMPLETED updates at the same public stage and percentage.
  let lastProgress: { stage: SitesSocketStage; progress: number; message?: string; lifecycle: boolean } | undefined;
  let completedProgressSent = false;
  let unsubscribe: () => void = () => undefined;
  const emit = <TEvent extends keyof SitesServerToClientEvents>(
    event: TEvent,
    ...args: Parameters<SitesServerToClientEvents[TEvent]>
  ) => io.to(ownerId).emit(event, ...args);
  const terminal = () => {
    if (terminalSent) return;
    const current = service.jobs.get(job.id) ?? job;
    if (current.status === "SUCCEEDED") {
      terminalSent = true;
      emit(SITES_SOCKET_EVENTS.JOB_COMPLETED, {
        requestId,
        jobId: current.id,
        operation: current.operation,
        projectId: current.projectId ?? "",
        ...(current.preview?.url ? { previewUrl: current.preview.url } : {}),
        status: "completed",
      });
      console.info(`[sites][socket] completed requestId=${requestId} jobId=${current.id}`);
      unsubscribe();
    } else if (current.status === "FAILED") {
      terminalSent = true;
      emit(SITES_SOCKET_EVENTS.JOB_FAILED, {
        requestId,
        jobId: current.id,
        operation: current.operation,
        stage: lastStage,
        status: "failed",
        code: current.error?.code ?? "DEV_OPERATION_FAILED",
        message: current.error?.message ?? "Development operation failed",
        retryable: current.error?.retryable === true,
      });
      console.info(
        `[sites][socket] failed requestId=${requestId} jobId=${current.id} code=${current.error?.code ?? "DEV_OPERATION_FAILED"}`,
      );
      unsubscribe();
    }
  };
  const onEvent = (event: DevJobEvent) => {
    if (terminalSent || event.type === "INTELLIGENCE_TASK_UPDATED") return;
    if (event.type === "JOB_FAILED") return terminal();
    lastStage = socketStage(job.operation, event.stage);
    const progress: SitesJobProgressPayload = {
      requestId,
      jobId: job.id,
      operation: job.operation,
      stage: lastStage,
      progress: event.progress ?? (lastStage === "COMPLETED" ? 100 : 0),
      ...(event.message ? { message: event.message } : {}),
    };
    const lifecycle = event.type === "JOB_STARTED" || event.type === "JOB_COMPLETED";
    const redundant =
      (progress.stage === "COMPLETED" && completedProgressSent) ||
      (lastProgress?.stage === progress.stage &&
        lastProgress.progress === progress.progress &&
        (lastProgress.message === progress.message || lifecycle || lastProgress.lifecycle));
    if (!redundant) {
      emit(SITES_SOCKET_EVENTS.JOB_PROGRESS, progress);
      lastProgress = { stage: progress.stage, progress: progress.progress, lifecycle, ...(progress.message ? { message: progress.message } : {}) };
      if (progress.stage === "COMPLETED") completedProgressSent = true;
    }
    if (event.type === "JOB_COMPLETED") terminal();
  };
  unsubscribe = service.jobs.subscribe(job.id, onEvent);
  for (const event of job.events) onEvent(event);
  terminal();
};

export const registerSitesSocketHandlers = (
  io: SitesIo,
  service: SitesSocketService,
  options: SitesSocketOptions = {},
): void => {
  io.on("connection", (socket) => {
    const ownerId =
      options.resolveOwnerId?.(socket, service) ?? String(service.userId);
    void socket.join(ownerId);

    socket.on(SITES_SOCKET_EVENTS.CREATE_JOB, (...args: unknown[]) => {
      const { request, acknowledge } = socketArguments<SitesCreateJobRequest>(args[0], args[1]);
      const requestId = requestIdFor(request?.requestId);
      let job: DevJobRecord;
      try {
        job = service.generate(requirePrompt(request?.prompt));
      } catch (error) {
        safeAcknowledge(acknowledge, rejectedAck(requestId, error));
        return;
      }
      safeAcknowledge(acknowledge, { success: true, requestId, jobId: job.id, status: "accepted" });
      console.info(`[sites][socket] accepted requestId=${requestId} jobId=${job.id}`);
      forwardJob(io, ownerId, service, requestId, job);
    });

    socket.on(SITES_SOCKET_EVENTS.EDIT_JOB, (...args: unknown[]) => {
      const { request, acknowledge } = socketArguments<SitesEditJobRequest>(args[0], args[1]);
      const requestId = requestIdFor(request?.requestId);
      void (async () => {
        let job: DevJobRecord;
        try {
          const siteId = requireIdentifier(request?.siteId, "siteId");
          const prompt = requirePrompt(request?.prompt);
          const baseVersionId =
            request?.baseVersionId === undefined
              ? undefined
              : requireIdentifier(request.baseVersionId, "baseVersionId");
          job = await service.edit(siteId, prompt, baseVersionId);
        } catch (error) {
          safeAcknowledge(acknowledge, rejectedAck(requestId, error));
          return;
        }
        safeAcknowledge(acknowledge, { success: true, requestId, jobId: job.id, status: "accepted" });
        console.info(`[sites][socket] accepted requestId=${requestId} jobId=${job.id}`);
        forwardJob(io, ownerId, service, requestId, job);
      })();
    });

    socket.on(SITES_SOCKET_EVENTS.CANCEL_JOB, (...args: unknown[]) => {
      const { request, acknowledge } = socketArguments<SitesCancelJobRequest>(args[0], args[1]);
      const requestId = requestIdFor(request?.requestId);
      safeAcknowledge(acknowledge, {
        success: false,
        requestId,
        status: "unsupported",
        error: {
          code: "CANCELLATION_NOT_SUPPORTED",
          message: "Sites jobs do not currently support cancellation",
          retryable: false,
        },
      });
    });
  });
};

export const attachSitesSocketServer = (
  server: HttpServer,
  service: SitesSocketService,
  options: SitesSocketOptions = {},
): SitesIo => {
  const io = new Server<SitesClientToServerEvents, SitesServerToClientEvents>(server, {
    ...(options.allowedOrigins?.length
      ? { cors: { origin: [...options.allowedOrigins] } }
      : {}),
  });
  registerSitesSocketHandlers(io, service, options);
  return io;
};
