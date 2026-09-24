import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { DevJobEvent, DevJobRecord } from "../../dev-server/dev-job-manager.js";
import {
  SITES_SOCKET_EVENTS,
  type SitesClientToServerEvents,
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
    emit(SITES_SOCKET_EVENTS.JOB_PROGRESS, progress);
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

    socket.on(SITES_SOCKET_EVENTS.CREATE_JOB, (request, acknowledge) => {
      const requestId = requestIdFor(request?.requestId);
      try {
        const prompt = requirePrompt(request?.prompt);
        const job = service.generate(prompt);
        acknowledge({ success: true, requestId, jobId: job.id, status: "accepted" });
        console.info(`[sites][socket] accepted requestId=${requestId} jobId=${job.id}`);
        forwardJob(io, ownerId, service, requestId, job);
      } catch (error) {
        acknowledge(rejectedAck(requestId, error));
      }
    });

    socket.on(SITES_SOCKET_EVENTS.EDIT_JOB, (request, acknowledge) => {
      const requestId = requestIdFor(request?.requestId);
      void (async () => {
        try {
          const siteId = requireIdentifier(request?.siteId, "siteId");
          const prompt = requirePrompt(request?.prompt);
          const baseVersionId =
            request?.baseVersionId === undefined
              ? undefined
              : requireIdentifier(request.baseVersionId, "baseVersionId");
          const job = await service.edit(siteId, prompt, baseVersionId);
          acknowledge({ success: true, requestId, jobId: job.id, status: "accepted" });
          console.info(`[sites][socket] accepted requestId=${requestId} jobId=${job.id}`);
          forwardJob(io, ownerId, service, requestId, job);
        } catch (error) {
          acknowledge(rejectedAck(requestId, error));
        }
      })();
    });

    socket.on(SITES_SOCKET_EVENTS.CANCEL_JOB, (request, acknowledge) => {
      const requestId = requestIdFor(request?.requestId);
      acknowledge({
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
