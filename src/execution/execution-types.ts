export interface ExecutionCapabilities {
  readonly filesystem: boolean;
  readonly commandExecution: boolean;
  readonly livePreview: boolean;
  readonly signedPreviewUrl: boolean;
  readonly snapshots: boolean;
  readonly pauseResume: boolean;
  readonly archive: boolean;
  readonly customImages: boolean;
  readonly networkControls: boolean;
  readonly secureIsolation?: boolean;
  readonly maxCpu?: number;
  readonly maxMemoryMb?: number;
  readonly maxSessionSeconds?: number;
}
export interface CreateEnvironmentOptions {
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly timeoutSeconds?: number;
  readonly image?: string;
  readonly networkPolicy?: "DENY_ALL" | "ALLOW_LIST" | "UNRESTRICTED";
}
export interface ExecutionEnvironment {
  readonly id: string;
  readonly status: "CREATING" | "READY" | "PAUSED" | "FAILED";
  readonly createdAt: Date;
  readonly expiresAt?: Date;
}
export interface FileEntry {
  readonly path: string;
  readonly type: "FILE" | "DIRECTORY";
  readonly sizeBytes?: number;
}
export interface CommandRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
}
export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
}
export type PreviewMode = "PROVIDER_URL" | "GETCHATLY_PROXY" | "NOT_SUPPORTED";
export interface PreviewRequest {
  readonly port: number;
  readonly command?: CommandRequest;
}
export interface PreviewResult {
  readonly mode: PreviewMode;
  readonly url?: string;
  readonly port: number;
  readonly expiresAt?: Date;
  readonly startupMs?: number;
  readonly httpReadyMs?: number;
}
export interface ExecutionUsageMetrics {
  readonly environmentCreationMs: number;
  readonly filesWritten: number;
  readonly bytesWritten: number;
  readonly commandsExecuted: number;
  readonly commandDurationMs: number;
  readonly installDurationMs: number;
  readonly buildDurationMs: number;
  readonly previewStartupMs: number;
  readonly previewHttpReadyMs: number;
  readonly environmentLifetimeMs?: number;
}
export interface PreviewSession {
  readonly environmentId: string;
  readonly url?: string;
  readonly port: number;
  readonly status: "STARTING" | "READY" | "STOPPED" | "FAILED";
  readonly previewMode: PreviewMode;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
}
export type BuildFailureKind =
  | "TIMEOUT"
  | "OUT_OF_MEMORY"
  | "DEPENDENCY_FAILURE"
  | "TYPESCRIPT_FAILURE"
  | "TEST_FAILURE"
  | "UNKNOWN";
export interface BuildResult {
  readonly success: boolean;
  readonly command: CommandRequest;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failureKind?: BuildFailureKind;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
}
