import type {
  CommandRequest,
  CommandResult,
  CreateEnvironmentOptions,
  ExecutionCapabilities,
  ExecutionEnvironment,
  FileEntry,
  PreviewRequest,
  PreviewResult,
  ExecutionUsageMetrics,
} from "./execution-types.js";
export interface ExecutionProvider {
  readonly id: string;
  getCapabilities(): ExecutionCapabilities;
  createEnvironment(options: CreateEnvironmentOptions): Promise<ExecutionEnvironment>;
  destroyEnvironment(environmentId: string): Promise<void>;
  listFiles(environmentId: string, path?: string): Promise<readonly FileEntry[]>;
  readFile(environmentId: string, path: string): Promise<string>;
  writeFile(environmentId: string, path: string, content: string): Promise<void>;
  readFileBytes?(environmentId: string, path: string): Promise<Uint8Array>;
  writeFileBytes?(environmentId: string, path: string, content: Uint8Array): Promise<void>;
  searchFiles?(environmentId: string, query: string): Promise<readonly string[]>;
  readLogs?(environmentId: string): Promise<readonly string[]>;
  executeCommand(environmentId: string, command: CommandRequest): Promise<CommandResult>;
  startPreview(environmentId: string, request: PreviewRequest): Promise<PreviewResult>;
  snapshot?(environmentId: string): Promise<string>;
  restore?(snapshotId: string): Promise<ExecutionEnvironment>;
  pause?(environmentId: string): Promise<void>;
  resume?(environmentId: string): Promise<void>;
  archive?(environmentId: string): Promise<string>;
  getUsageMetrics?(environmentId: string): ExecutionUsageMetrics;
}
