import { ApplicationError } from "../app/errors/application-error.js";
import type { ExecutionProvider } from "./execution-provider.js";
import type {
  CommandRequest,
  CommandResult,
  CreateEnvironmentOptions,
  ExecutionCapabilities,
  ExecutionEnvironment,
  FileEntry,
  PreviewRequest,
  PreviewResult,
} from "./execution-types.js";

export interface MockExecutionProviderOptions {
  readonly failBuilds?: number;
  readonly failPreview?: boolean;
}
interface Workspace {
  readonly files: Map<string, Buffer>;
  builds: number;
  readonly createdAt: Date;
}

const normalizePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "."))
    throw new Error(`Unsafe workspace path: ${path}`);
  return normalized;
};

export class MockExecutionProvider implements ExecutionProvider {
  readonly id = "mock-execution";
  readonly #workspaces = new Map<string, Workspace>();
  readonly #failBuilds: number;
  readonly #failPreview: boolean;
  #nextId = 1;
  readonly destroyedEnvironmentIds: string[] = [];
  constructor(options: MockExecutionProviderOptions = {}) {
    this.#failBuilds = options.failBuilds ?? 0;
    this.#failPreview = options.failPreview ?? false;
  }
  getCapabilities(): ExecutionCapabilities {
    return {
      filesystem: true,
      commandExecution: true,
      livePreview: true,
      signedPreviewUrl: false,
      snapshots: false,
      pauseResume: false,
      archive: false,
      customImages: false,
      networkControls: true,
      maxCpu: 1,
      maxMemoryMb: 512,
      maxSessionSeconds: 300,
    };
  }
  async createEnvironment(options: CreateEnvironmentOptions): Promise<ExecutionEnvironment> {
    void options;
    const id = `mock-env-${this.#nextId++}`;
    const createdAt = new Date();
    this.#workspaces.set(id, { files: new Map(), builds: 0, createdAt });
    return { id, status: "READY", createdAt };
  }
  async destroyEnvironment(environmentId: string): Promise<void> {
    this.#workspace(environmentId);
    this.#workspaces.delete(environmentId);
    this.destroyedEnvironmentIds.push(environmentId);
  }
  hasEnvironment(environmentId: string): boolean {
    return this.#workspaces.has(environmentId);
  }
  async listFiles(environmentId: string, path = ""): Promise<readonly FileEntry[]> {
    const workspace = this.#workspace(environmentId);
    const prefix = path ? `${normalizePath(path).replace(/\/$/, "")}/` : "";
    return [...workspace.files.entries()]
      .filter(([file]) => file.startsWith(prefix))
      .map(([file, content]): FileEntry => ({
        path: file,
        type: "FILE",
        sizeBytes: content.length,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async readFile(environmentId: string, path: string): Promise<string> {
    const value = this.#workspace(environmentId).files.get(normalizePath(path));
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return value.toString("utf8");
  }
  async readFileBytes(environmentId: string, path: string): Promise<Uint8Array> {
    const value = this.#workspace(environmentId).files.get(normalizePath(path));
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return value;
  }
  async writeFile(environmentId: string, path: string, content: string): Promise<void> {
    this.#workspace(environmentId).files.set(normalizePath(path), Buffer.from(content, "utf8"));
  }
  async writeFileBytes(environmentId: string, path: string, content: Uint8Array): Promise<void> {
    this.#workspace(environmentId).files.set(normalizePath(path), Buffer.from(content));
  }
  async executeCommand(environmentId: string, command: CommandRequest): Promise<CommandResult> {
    const workspace = this.#workspace(environmentId);
    const startedAt = new Date();
    if (command.executable !== "npm" || command.args?.join(" ") !== "run build")
      throw new Error("Mock execution permits only 'npm run build'");
    workspace.builds += 1;
    const configuredFailure = workspace.builds <= this.#failBuilds;
    const sourceFailure = [...workspace.files.values()].some((content) =>
      content.includes("BROKEN"),
    );
    const success = !configuredFailure && !sourceFailure;
    const finishedAt = new Date(startedAt.getTime() + 25);
    return {
      exitCode: success ? 0 : 1,
      stdout: success ? "mock build complete" : "",
      stderr: success ? "" : "TypeScript error: BROKEN marker",
      timedOut: false,
      startedAt,
      finishedAt,
      durationMs: 25,
    };
  }
  async startPreview(environmentId: string, request: PreviewRequest): Promise<PreviewResult> {
    this.#workspace(environmentId);
    if (this.#failPreview) throw new ApplicationError("PREVIEW_FAILED", "Mock preview failed");
    return {
      mode: "PROVIDER_URL",
      url: `http://preview.local/${environmentId}`,
      port: request.port,
    };
  }
  #workspace(id: string): Workspace {
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new Error(`Unknown environment: ${id}`);
    return workspace;
  }
}
