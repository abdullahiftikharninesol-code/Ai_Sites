export const SITES_SOCKET_EVENTS = {
  CREATE_JOB: "sitesCreateJob",
  EDIT_JOB: "sitesEditJob",
  CANCEL_JOB: "sitesCancelJob",
  JOB_PROGRESS: "sitesJobProgress",
  JOB_COMPLETED: "sitesJobCompleted",
  JOB_FAILED: "sitesJobFailed",
} as const;

export type SitesJobOperation = "GENERATE" | "EDIT";
export type SitesSocketStage =
  | "QUEUED"
  | "UNDERSTANDING"
  | "PREPARING"
  | "GENERATING"
  | "UPDATING"
  | "BUILDING"
  | "CHECKING"
  | "COMPLETED";

export interface SitesCreateJobRequest {
  readonly requestId?: string;
  readonly prompt: string;
}

export interface SitesEditJobRequest {
  readonly requestId?: string;
  readonly siteId: string;
  readonly prompt: string;
  readonly baseVersionId?: string;
}

export interface SitesCancelJobRequest {
  readonly requestId?: string;
  readonly jobId: string;
}

export interface SitesJobAccepted {
  readonly success: true;
  readonly requestId: string;
  readonly jobId: string;
  readonly status: "accepted";
}

export interface SitesJobRejected {
  readonly success: false;
  readonly requestId: string;
  readonly status: "rejected" | "unsupported";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type SitesJobAck = SitesJobAccepted | SitesJobRejected;

export interface SitesJobProgressPayload {
  readonly requestId: string;
  readonly jobId: string;
  readonly operation: SitesJobOperation;
  readonly stage: SitesSocketStage;
  readonly progress: number;
  readonly message?: string;
}

export interface SitesJobCompletedPayload {
  readonly requestId: string;
  readonly jobId: string;
  readonly operation: SitesJobOperation;
  readonly projectId: string;
  readonly previewUrl?: string;
  readonly status: "completed";
}

export interface SitesJobFailedPayload {
  readonly requestId: string;
  readonly jobId: string;
  readonly operation: SitesJobOperation;
  readonly stage: SitesSocketStage;
  readonly status: "failed";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type SitesClientToServerEvents = {
  [SITES_SOCKET_EVENTS.CREATE_JOB]: (
    request: SitesCreateJobRequest,
    acknowledge: (response: SitesJobAck) => void,
  ) => void;
  [SITES_SOCKET_EVENTS.EDIT_JOB]: (
    request: SitesEditJobRequest,
    acknowledge: (response: SitesJobAck) => void,
  ) => void;
  [SITES_SOCKET_EVENTS.CANCEL_JOB]: (
    request: SitesCancelJobRequest,
    acknowledge: (response: SitesJobAck) => void,
  ) => void;
};

export type SitesServerToClientEvents = {
  [SITES_SOCKET_EVENTS.JOB_PROGRESS]: (payload: SitesJobProgressPayload) => void;
  [SITES_SOCKET_EVENTS.JOB_COMPLETED]: (payload: SitesJobCompletedPayload) => void;
  [SITES_SOCKET_EVENTS.JOB_FAILED]: (payload: SitesJobFailedPayload) => void;
};
