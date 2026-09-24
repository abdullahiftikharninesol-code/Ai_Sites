import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../execution-provider.js";
import type {
  CommandRequest,
  CommandResult,
  CreateEnvironmentOptions,
  ExecutionCapabilities,
  ExecutionEnvironment,
  ExecutionUsageMetrics,
  PreviewRequest,
  PreviewResult,
} from "../execution-types.js";
import type { LocalExecutionConfig } from "./local-execution.config.js";
import { LocalProcessManager } from "./local-process-manager.js";
import { allocateLocalPort } from "./local-port-allocator.js";
import { LocalWorkspaceManager } from "./local-workspace-manager.js";
interface EnvironmentState {
  readonly createdAt: Date;
  readonly workspace: string;
  readonly metrics: MutableMetrics;
  latestPreview?: PreviewResult;
  lastBuildSuccess?: boolean;
  lastBuildResult?: CommandResult;
}
interface MutableMetrics {
  environmentCreationMs: number;
  filesWritten: number;
  bytesWritten: number;
  commandsExecuted: number;
  commandDurationMs: number;
  installDurationMs: number;
  buildDurationMs: number;
  previewStartupMs: number;
  previewHttpReadyMs: number;
  environmentLifetimeMs?: number;
}
export class LocalExecutionProvider implements ExecutionProvider {
  readonly id = "local";
  readonly #workspace: LocalWorkspaceManager;
  readonly #processes: LocalProcessManager;
  readonly #environments = new Map<string, EnvironmentState>();
  readonly destroyedEnvironmentIds: string[] = [];
  constructor(readonly config: LocalExecutionConfig) {
    this.#workspace = new LocalWorkspaceManager(config.rootDirectory);
    this.#processes = new LocalProcessManager(config.maxLogBytes);
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
      networkControls: false,
      secureIsolation: false,
    };
  }
  async createEnvironment(options: CreateEnvironmentOptions): Promise<ExecutionEnvironment> {
    void options;
    const started = Date.now();
    const id = `env_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const workspace = await this.#workspace.create(id);
    const createdAt = new Date();
    this.#environments.set(id, {
      createdAt,
      workspace,
      metrics: {
        environmentCreationMs: Date.now() - started,
        filesWritten: 0,
        bytesWritten: 0,
        commandsExecuted: 0,
        commandDurationMs: 0,
        installDurationMs: 0,
        buildDurationMs: 0,
        previewStartupMs: 0,
        previewHttpReadyMs: 0,
      },
    });
    return { id, status: "READY", createdAt };
  }
  async destroyEnvironment(id: string): Promise<void> {
    const state = this.#state(id);
    await this.#processes.stopAll(id);
    state.metrics.environmentLifetimeMs = Date.now() - state.createdAt.getTime();
    if (!this.config.keepWorkspace) await this.#workspace.destroy(id);
    this.#environments.delete(id);
    this.destroyedEnvironmentIds.push(id);
  }
  listFiles(id: string, path = "") {
    this.#state(id);
    return this.#workspace.list(id, path);
  }
  readFile(id: string, path: string) {
    this.#state(id);
    return this.#workspace.read(id, path);
  }
  readFileBytes(id: string, path: string) {
    this.#state(id);
    return this.#workspace.readBytes(id, path);
  }
  async writeFileBytes(id: string, path: string, content: Uint8Array) {
    const state = this.#state(id);
    await this.#workspace.write(id, path, content);
    state.metrics.filesWritten++;
    state.metrics.bytesWritten += content.byteLength;
  }
  async writeFile(id: string, path: string, content: string) {
    const state = this.#state(id);
    await this.#workspace.write(id, path, content);
    state.metrics.filesWritten += 1;
    state.metrics.bytesWritten += Buffer.byteLength(content);
  }
  async searchFiles(id: string, query: string): Promise<readonly string[]> {
    const matches: string[] = [];
    for (const entry of await this.listFiles(id)) {
      if (entry.type !== "FILE") continue;
      try {
        if ((await this.readFile(id, entry.path)).includes(query)) matches.push(entry.path);
      } catch {
        /* binary or transient file */
      }
    }
    return matches;
  }
  readLogs(id: string): Promise<readonly string[]> {
    this.#state(id);
    return Promise.resolve(this.#processes.readLogs(id));
  }
  async executeCommand(id: string, command: CommandRequest) {
    const state = this.#state(id);
    this.#validateCommand(command);
    const cwd = command.cwd ? this.#workspace.resolvePath(id, command.cwd) : state.workspace;
    const result = await this.#processes.run(id, cwd, command, this.config.commandTimeoutMs);
    state.metrics.commandsExecuted += 1;
    state.metrics.commandDurationMs += result.durationMs;
    const joined = `${command.executable} ${(command.args ?? []).join(" ")}`;
    if (/npm (ci|install)/.test(joined)) state.metrics.installDurationMs += result.durationMs;
    if (joined === "npm run build") state.metrics.buildDurationMs += result.durationMs;
    if (joined === "npm run build")
      state.lastBuildSuccess = result.exitCode === 0 && !result.timedOut;
    if (joined === "npm run build") state.lastBuildResult = result;
    return result;
  }
  async startPreview(id: string, request: PreviewRequest): Promise<PreviewResult> {
    const state = this.#state(id);
    const port = await allocateLocalPort(this.config.previewHost);
    const command = request.command ?? {
      executable: "npm",
      args: ["run", "dev", "--", "--host", this.config.previewHost, "--port", String(port)],
    };
    this.#validateCommand(command, true);
    const started = Date.now();
    // Spawn Vite directly for the fixed local profile. On Windows an npm wrapper can
    // detach its child, leaving the workspace locked after the wrapper is killed.
    const previewCommand =
      command.executable === "npm" && command.args?.[0] === "run" && command.args[1] === "dev"
        ? {
            executable: process.execPath,
            args: [
              resolve(state.workspace, "node_modules/vite/bin/vite.js"),
              "--host",
              this.config.previewHost,
              "--port",
              String(port),
            ],
          }
        : command;
    const child = this.#processes.start(id, state.workspace, previewCommand);
    const url = `http://${this.config.previewHost}:${port}`;
    const deadline = started + this.config.previewStartTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new ApplicationError(
          "PREVIEW_FAILED",
          `Preview exited before readiness: ${(await this.readLogs(id)).slice(-5).join("\n")}`,
        );
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const ready = Date.now();
          state.metrics.previewStartupMs += ready - started;
          state.metrics.previewHttpReadyMs += ready - started;
          const preview: PreviewResult = {
            mode: "PROVIDER_URL",
            url,
            port,
            startupMs: ready - started,
            httpReadyMs: ready - started,
          };
          state.latestPreview = preview;
          return preview;
        }
      } catch {
        /* retry until bounded deadline */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.#processes.stopProcess(child);
    throw new ApplicationError(
      "PREVIEW_FAILED",
      `Local preview did not become ready within ${this.config.previewStartTimeoutMs}ms`,
    );
  }
  getUsageMetrics(id: string): ExecutionUsageMetrics {
    return { ...this.#state(id).metrics };
  }
  getWorkspacePath(id: string): string {
    return this.#state(id).workspace;
  }
  getLatestPreview(id: string): PreviewResult | undefined {
    return this.#state(id).latestPreview;
  }
  getLastBuildSuccess(id: string): boolean | undefined {
    return this.#state(id).lastBuildSuccess;
  }
  getLastBuildResult(id: string) {
    return this.#state(id).lastBuildResult;
  }
  getActiveEnvironmentCount(): number {
    return this.#environments.size;
  }
  ownedProcessCount(id: string): number {
    return this.#processes.processCount(id);
  }
  async fileExists(id: string, path: string): Promise<boolean> {
    try {
      await access(this.#workspace.resolvePath(id, path));
      return true;
    } catch {
      return false;
    }
  }
  #state(id: string): EnvironmentState {
    const state = this.#environments.get(id);
    if (!state) throw new Error(`Unknown environment: ${id}`);
    return state;
  }
  #validateCommand(command: CommandRequest, preview = false): void {
    const args = [...(command.args ?? [])];
    const key = `${command.executable} ${args.join(" ")}`.trim();
    const exact = new Set([
      "node --version",
      "npm --version",
      "npm ci",
      "npm ci --prefer-offline --no-audit --no-fund",
      "npm install",
      // Installing an approved optional package after generation, with the same
      // flags as the starter install.
      "npm install --prefer-offline --no-audit --no-fund",
      "npm run build",
      "npm test",
      "npx tsc --noEmit",
    ]);
    const allowedPreview =
      command.executable === "npm" &&
      args[0] === "run" &&
      args[1] === "dev" &&
      args[2] === "--" &&
      args[3] === "--host" &&
      args[5] === "--port";
    if (!exact.has(key) && !(preview && allowedPreview))
      throw new ApplicationError("VALIDATION_FAILED", `Local command is not allow-listed: ${key}`);
  }
}
