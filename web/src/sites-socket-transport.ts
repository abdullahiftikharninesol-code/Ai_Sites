import { io, type Socket } from "socket.io-client";
import {
  SITES_SOCKET_EVENTS,
  type SitesClientToServerEvents,
  type SitesCreateJobRequest,
  type SitesEditJobRequest,
  type SitesJobAck,
  type SitesJobCompletedPayload,
  type SitesJobFailedPayload,
  type SitesJobProgressPayload,
  type SitesServerToClientEvents,
} from "../../src/shared/sites-socket-contract.js";

export type SitesSocketConnection = Socket<
  SitesServerToClientEvents,
  SitesClientToServerEvents
>;

export class SitesSocketTransport {
  constructor(private readonly socket: SitesSocketConnection) {}

  createSite(request: SitesCreateJobRequest): Promise<SitesJobAck> {
    return this.socket.emitWithAck(SITES_SOCKET_EVENTS.CREATE_JOB, request);
  }

  editSite(request: SitesEditJobRequest): Promise<SitesJobAck> {
    return this.socket.emitWithAck(SITES_SOCKET_EVENTS.EDIT_JOB, request);
  }

  cancelSite(jobId: string, requestId?: string): Promise<SitesJobAck> {
    return this.socket.emitWithAck(SITES_SOCKET_EVENTS.CANCEL_JOB, {
      jobId,
      ...(requestId ? { requestId } : {}),
    });
  }

  subscribeToProgress(listener: (payload: SitesJobProgressPayload) => void): () => void {
    this.socket.on(SITES_SOCKET_EVENTS.JOB_PROGRESS, listener);
    return () => this.socket.off(SITES_SOCKET_EVENTS.JOB_PROGRESS, listener);
  }

  subscribeToCompleted(listener: (payload: SitesJobCompletedPayload) => void): () => void {
    this.socket.on(SITES_SOCKET_EVENTS.JOB_COMPLETED, listener);
    return () => this.socket.off(SITES_SOCKET_EVENTS.JOB_COMPLETED, listener);
  }

  subscribeToFailed(listener: (payload: SitesJobFailedPayload) => void): () => void {
    this.socket.on(SITES_SOCKET_EVENTS.JOB_FAILED, listener);
    return () => this.socket.off(SITES_SOCKET_EVENTS.JOB_FAILED, listener);
  }
}

export const createLocalSitesSocket = (baseUrl: string): SitesSocketConnection =>
  io(baseUrl, { autoConnect: true });
