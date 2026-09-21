/// <reference types="vite/client" />

export interface SiteSummary {
  projectId: string;
  name: string;
  slug: string;
  latestVersion?: number;
  publishedVersionId?: string;
  createdAt: string;
  updatedAt: string;
  hostedUrl?: string;
}
export interface VersionSummary {
  versionId: string;
  versionNumber: number;
  parentVersionId?: string;
  createdAt: string;
  buildStatus: string;
  browserQAStatus?: string;
  runtimeSchemaVersion?: number;
  published: boolean;
}
export interface SiteDetail {
  project: {
    projectId: string;
    name: string;
    slug: string;
    latestVersionId?: string;
    publishedVersionId?: string;
    publishedDeploymentId?: string;
  };
  capabilities: { runtime: boolean; collections: string[]; auth: boolean; actions: string[] };
  plans?: Record<string, unknown>;
  versions: VersionSummary[];
  deployments: Array<{
    deploymentId: string;
    versionId: string;
    status: string;
    published: boolean;
  }>;
  domains: Array<{ id: string; hostname: string; status: string }>;
  activePreview?: { previewSessionId: string; versionId: string; previewUrl: string };
  hostedUrl?: string;
}
export interface JobStatus {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  currentStage: string;
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
    diagnostics?: string;
  };
  intelligence?: IntelligenceTaskStatus[];
}
export const AGENT_TASK_KINDS = [
  "REQUIREMENTS_PLANNING",
  "DESIGN_PLANNING",
  "CAPABILITY_PLANNING",
  "RUNTIME_PLANNING",
  "AUTH_PLANNING",
  "INTEGRATION_PLANNING",
  "CONTENT_GENERATION",
  "CODE_GENERATION",
  "BUILD_REPAIR",
  "TARGETED_EDIT",
] as const;
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];
export type AgentTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "PASS"
  | "FALLBACK"
  | "NOT_NEEDED"
  | "UNSUPPORTED"
  | "DISABLED"
  | "FAILED"
  | "NOT_REACHED";
export interface IntelligenceTaskStatus {
  taskKind: AgentTaskKind;
  provider: string;
  model: string;
  status: AgentTaskStatus;
  attempted: boolean;
  supported: boolean;
  success: boolean;
  fallbackUsed: boolean;
  latencyMs: number;
  turns: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCategory?: string;
}
export interface ProgressEvent {
  type: string;
  stage: string;
  message: string;
  timestamp: string;
  progress?: number;
}
export interface LocalInstanceStatus {
  previewSessionId: string;
  siteId: string;
  versionId: string;
  environmentId: string;
  workspacePath: string;
  previewUrl: string;
  status: "RUNNING";
  processCount: number;
  createdAt: string;
  lastAccessedAt: string;
  logs: string[];
}
export interface SourceFile {
  path: string;
  sizeBytes: number;
  encoding?: "base64";
}
export interface SourceFileContent extends SourceFile {
  content: string;
}
const configuredApiUrl: unknown = import.meta.env.VITE_SITES_DEV_API_URL;
export const DEFAULT_SITES_DEV_API_URL = "http://127.0.0.1:4310";
export const formatProviderName = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);
export class PlaygroundApiConnectionError extends Error {
  constructor(readonly apiUrl: string) {
    super(
      `Cannot reach Sites development API at ${apiUrl}. Check that npm run dev:server is running and the playground origin is allowed.`,
    );
    this.name = "PlaygroundApiConnectionError";
  }
}
export class PlaygroundApiClient {
  constructor(
    readonly baseUrl = typeof configuredApiUrl === "string"
      ? configuredApiUrl
      : DEFAULT_SITES_DEV_API_URL,
  ) {}
  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      });
    } catch {
      throw new PlaygroundApiConnectionError(this.baseUrl);
    }
    let value: T & { error?: { message: string } };
    try {
      value = (await response.json()) as T & { error?: { message: string } };
    } catch {
      throw new Error(`Invalid API response (HTTP ${response.status})`);
    }
    if (!response.ok)
      throw new Error(value?.error?.message ?? `Request failed (${response.status})`);
    return value;
  }
  health() {
    return this.#request<{
      status: string;
      mode: string;
      agentProvider: string;
      agentModel: string;
      executionProvider: string;
    }>("/api/dev/health");
  }
  async sites() {
    return (await this.#request<{ sites: SiteSummary[] }>("/api/dev/sites")).sites;
  }
  site(id: string) {
    return this.#request<SiteDetail>(`/api/dev/sites/${encodeURIComponent(id)}`);
  }
  deleteSite(id: string) {
    return this.#request<{ deleted: boolean }>(`/api/dev/sites/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  async generate(prompt: string) {
    return this.#request<{ jobId: string }>("/api/dev/sites", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
  }
  async edit(siteId: string, prompt: string, baseVersionId?: string) {
    return this.#request<{ jobId: string }>(`/api/dev/sites/${encodeURIComponent(siteId)}/edit`, {
      method: "POST",
      body: JSON.stringify({ prompt, ...(baseVersionId ? { baseVersionId } : {}) }),
    });
  }
  job(id: string, signal?: AbortSignal) {
    return this.#request<JobStatus>(
      `/api/dev/jobs/${encodeURIComponent(id)}`,
      signal ? { signal } : undefined,
    );
  }
  events(
    id: string,
    onEvent: (event: ProgressEvent) => void,
    onIntelligence: (task: IntelligenceTaskStatus) => void,
  ) {
    const source = new EventSource(`${this.baseUrl}/api/dev/jobs/${encodeURIComponent(id)}/events`);
    const seen = new Set<string>();
    source.addEventListener("progress", (event) => {
      const data = (event as MessageEvent<string>).data;
      if (seen.has(data)) return;
      seen.add(data);
      if (seen.size > 500) seen.delete(seen.values().next().value!);
      onEvent(JSON.parse(data) as ProgressEvent);
    });
    source.addEventListener("intelligence", (event) => {
      const update = JSON.parse((event as MessageEvent<string>).data) as {
        intelligence: IntelligenceTaskStatus;
      };
      onIntelligence(update.intelligence);
    });
    return () => source.close();
  }
  preview(siteId: string, versionId: string) {
    return this.#request<{
      previewSessionId: string;
      previewUrl: string;
      environmentId: string;
      workspacePath: string;
    }>(`/api/dev/sites/${siteId}/versions/${versionId}/preview`, { method: "POST" });
  }
  previewInstance(id: string) {
    return this.#request<LocalInstanceStatus>(`/api/dev/previews/${encodeURIComponent(id)}`);
  }
  sourceFiles(siteId: string, versionId: string): Promise<{ siteId: string; versionId: string; files: SourceFile[] }> {
    return this.#request(
      `/api/dev/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/files`,
    );
  }
  sourceFile(siteId: string, versionId: string, path: string): Promise<SourceFileContent> {
    return this.#request(
      `/api/dev/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/files?path=${encodeURIComponent(path)}`,
    );
  }
  stopPreview(id: string) {
    return this.#request<{ stopped: boolean }>(`/api/dev/previews/${id}`, { method: "DELETE" });
  }
  publish(siteId: string, versionId: string) {
    return this.#request<{ deploymentId: string; hostedUrl: string }>(
      `/api/dev/sites/${siteId}/versions/${versionId}/publish`,
      { method: "POST" },
    );
  }
  rollback(siteId: string, deploymentId: string) {
    return this.#request<SiteDetail>(`/api/dev/sites/${siteId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ deploymentId }),
    });
  }
  unpublish(siteId: string) {
    return this.#request<{ unpublished: boolean }>(`/api/dev/sites/${siteId}/unpublish`, {
      method: "POST",
    });
  }
}
