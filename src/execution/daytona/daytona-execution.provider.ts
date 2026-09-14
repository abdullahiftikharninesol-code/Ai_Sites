import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionProvider } from "../execution-provider.js";
import type {
  CommandRequest,
  CommandResult,
  CreateEnvironmentOptions,
  ExecutionCapabilities,
  ExecutionEnvironment,
  ExecutionUsageMetrics,
  FileEntry,
  PreviewRequest,
  PreviewResult,
} from "../execution-types.js";
import type { DaytonaConfig } from "./daytona-config.js";
import {
  createDaytonaClient,
  type DaytonaClient,
  type DaytonaSandboxClient,
} from "./daytona-client.js";
import { DaytonaExecutionError } from "./daytona-errors.js";

const WORKSPACE = "/workspace/project";
const ALLOWED_ENV = new Set([
  "SITES_JOB_ID",
  "SITES_SITE_ID",
  "SITES_AGENT_GATEWAY_URL",
  "SITES_JOB_TOKEN",
  "SITES_CLI_VERSION",
  "NODE_ENV",
]);
type CleanupStatus = "CREATED" | "ACTIVE" | "CLEANUP_REQUESTED" | "CLEANED" | "CLEANUP_FAILED";
interface State {
  readonly sandbox: DaytonaSandboxClient;
  readonly createdAt: Date;
  readonly metrics: MutableMetrics;
  cleanupStatus: CleanupStatus;
  preview?: PreviewResult;
  previewSession?: { readonly id: string; readonly commandId: string };
  lastBuild?: CommandResult;
}
type MutableMetrics = {
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
};

export class DaytonaExecutionProvider implements ExecutionProvider {
  readonly id = "daytona";
  readonly #states = new Map<string, State>();
  readonly #client: DaytonaClient;
  constructor(
    readonly config: DaytonaConfig,
    client?: DaytonaClient,
  ) {
    this.#client = client ?? createDaytonaClient(config);
  }
  getCapabilities(): ExecutionCapabilities {
    return {
      filesystem: true,
      commandExecution: true,
      livePreview: true,
      signedPreviewUrl: true,
      snapshots: false,
      pauseResume: false,
      archive: false,
      customImages: false,
      networkControls: true,
      secureIsolation: true,
      maxCpu: this.config.cpu,
      maxMemoryMb: this.config.memoryGb * 1024,
      maxSessionSeconds: this.config.sandboxTtlMinutes * 60,
    };
  }
  async createEnvironment(options: CreateEnvironmentOptions): Promise<ExecutionEnvironment> {
    const started = Date.now();
    try {
      const sandbox = await this.#client.create({
        envVars: {},
        resources: {
          cpu: options.cpu ?? this.config.cpu,
          memory: options.memoryMb ? options.memoryMb / 1024 : this.config.memoryGb,
          disk: this.config.diskGb,
        },
        ttlMinutes: Math.ceil((options.timeoutSeconds ?? this.config.sandboxTtlMinutes * 60) / 60),
        ...(options.networkPolicy === "DENY_ALL" ? { networkBlockAll: true } : {}),
      });
      await sandbox.createFolder(WORKSPACE);
      const createdAt = sandbox.createdAt ? new Date(sandbox.createdAt) : new Date();
      this.#states.set(sandbox.id, {
        sandbox,
        createdAt,
        cleanupStatus: "ACTIVE",
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
      return {
        id: sandbox.id,
        status: "READY",
        createdAt,
        ...(sandbox.autoDestroyAt ? { expiresAt: new Date(sandbox.autoDestroyAt) } : {}),
      };
    } catch (cause) {
      throw new DaytonaExecutionError(
        "ENVIRONMENT_CREATION_FAILED",
        "Daytona sandbox creation failed",
        cause,
      );
    }
  }
  async destroyEnvironment(id: string): Promise<void> {
    const state = this.#state(id);
    state.cleanupStatus = "CLEANUP_REQUESTED";
    try {
      await this.#client.delete(state.sandbox);
      state.cleanupStatus = "CLEANED";
      state.metrics.environmentLifetimeMs = Date.now() - state.createdAt.getTime();
      this.#states.delete(id);
    } catch (cause) {
      state.cleanupStatus = "CLEANUP_FAILED";
      throw new DaytonaExecutionError(
        "ENVIRONMENT_CREATION_FAILED",
        `Daytona cleanup failed for ${id}`,
        cause,
      );
    }
  }
  async listFiles(id: string, path = ""): Promise<readonly FileEntry[]> {
    const state = this.#state(id);
    const base = this.#path(path);
    const files = await state.sandbox.listFiles(base);
    return files.map((file) => {
      const absolute = file.path ?? posix.join(base, file.name);
      const relative = posix.relative(WORKSPACE, absolute);
      return {
        path: relative,
        type: file.isDir ? "DIRECTORY" : "FILE",
        ...(!file.isDir ? { sizeBytes: file.size } : {}),
      };
    });
  }
  async readFile(id: string, path: string): Promise<string> {
    return (await this.#state(id).sandbox.readFile(this.#path(path))).toString("utf8");
  }
  async readFileBytes(id: string, path: string): Promise<Uint8Array> {
    return this.#state(id).sandbox.readFile(this.#path(path));
  }
  async writeFile(id: string, path: string, content: string): Promise<void> {
    await this.#writeBytes(id, path, Buffer.from(content, "utf8"));
  }
  async writeFileBytes(id: string, path: string, content: Uint8Array): Promise<void> {
    await this.#writeBytes(id, path, Buffer.from(content));
  }
  async #writeBytes(id: string, path: string, data: Buffer): Promise<void> {
    const state = this.#state(id);
    const target = this.#path(path);
    const parent = posix.dirname(target);
    if (parent !== WORKSPACE) await state.sandbox.createFolder(parent);
    await state.sandbox.writeFile(target, data);
    state.metrics.filesWritten += 1;
    state.metrics.bytesWritten += data.length;
  }
  async searchFiles(id: string, query: string): Promise<readonly string[]> {
    if (!query || query.length > 256)
      throw new DaytonaExecutionError("VALIDATION_FAILED", "Invalid search query");
    const matches: string[] = [];
    for (const file of (await this.listFiles(id)).filter((entry) => entry.type === "FILE")) {
      if ((await this.readFile(id, file.path)).includes(query)) matches.push(file.path);
    }
    return matches;
  }
  async executeCommand(id: string, command: CommandRequest): Promise<CommandResult> {
    const state = this.#state(id);
    const shell = this.#allowedCommand(command);
    const startedAt = new Date();
    try {
      const result = await state.sandbox.execute(
        shell,
        command.cwd ? this.#path(command.cwd) : WORKSPACE,
        this.#filterEnvironment(command.environment),
        Math.ceil((command.timeoutMs ?? this.config.commandTimeoutMs) / 1000),
      );
      const finishedAt = new Date();
      const normalized: CommandResult = {
        exitCode: result.exitCode ?? null,
        stdout: result.stdout ?? result.result ?? "",
        stderr: result.stderr ?? "",
        timedOut: false,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
      this.#recordCommand(state, shell, normalized);
      return normalized;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Daytona command failed";
      if (/timeout/i.test(message)) {
        const finishedAt = new Date();
        const normalized: CommandResult = {
          exitCode: null,
          stdout: "",
          stderr: message,
          timedOut: true,
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        };
        this.#recordCommand(state, shell, normalized);
        return normalized;
      }
      throw new DaytonaExecutionError("BUILD_FAILED", "Daytona command execution failed", cause);
    }
  }
  async startPreview(id: string, request: PreviewRequest): Promise<PreviewResult> {
    const state = this.#state(id);
    const started = Date.now();
    const command = request.command ?? {
      executable: "npm",
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(request.port)],
    };
    const shell = this.#allowedCommand(command, true);
    const sessionId = `preview-${randomUUID()}`;
    const launched = await state.sandbox.startSession(
      sessionId,
      `cd ${WORKSPACE} && ${shell}`,
      Math.ceil(this.config.commandTimeoutMs / 1000),
    );
    if (!launched.cmdId)
      throw new DaytonaExecutionError(
        "PREVIEW_FAILED",
        "Daytona preview returned no process identity",
      );
    state.previewSession = { id: sessionId, commandId: launched.cmdId };
    const acquiredAt = Date.now();
    const preview = await state.sandbox.signedPreviewUrl(
      request.port,
      this.config.previewUrlTtlSeconds,
    );
    const deadline = Date.now() + this.config.previewStartTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(preview.url, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const ready = Date.now();
          const result: PreviewResult = {
            mode: "PROVIDER_URL",
            url: preview.url,
            port: request.port,
            expiresAt: new Date(Date.now() + this.config.previewUrlTtlSeconds * 1000),
            startupMs: acquiredAt - started,
            httpReadyMs: ready - acquiredAt,
          };
          state.preview = result;
          state.metrics.previewStartupMs += result.startupMs ?? 0;
          state.metrics.previewHttpReadyMs += result.httpReadyMs ?? 0;
          return result;
        }
      } catch {
        /* bounded readiness retry */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new DaytonaExecutionError(
      "PREVIEW_FAILED",
      "Daytona preview did not become HTTP-ready before timeout",
    );
  }
  async readLogs(id: string): Promise<readonly string[]> {
    const state = this.#state(id);
    if (!state.previewSession) return [];
    const logs = await state.sandbox.sessionLogs(
      state.previewSession.id,
      state.previewSession.commandId,
    );
    const text = `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`.slice(-this.config.maxLogBytes);
    return text.split(/\r?\n/).filter(Boolean);
  }
  getUsageMetrics(id: string): ExecutionUsageMetrics {
    return { ...this.#state(id).metrics };
  }
  getLatestPreview(id: string): PreviewResult | undefined {
    return this.#state(id).preview;
  }
  getLastBuildResult(id: string): CommandResult | undefined {
    return this.#state(id).lastBuild;
  }
  getLastBuildSuccess(id: string): boolean | undefined {
    const result = this.#state(id).lastBuild;
    return result ? result.exitCode === 0 && !result.timedOut : undefined;
  }
  getCleanupStatus(id: string): CleanupStatus {
    return this.#state(id).cleanupStatus;
  }
  getActiveEnvironmentCount(): number {
    return this.#states.size;
  }
  #state(id: string): State {
    const state = this.#states.get(id);
    if (!state)
      throw new DaytonaExecutionError(
        "ENVIRONMENT_CREATION_FAILED",
        `Unknown Daytona environment: ${id}`,
      );
    return state;
  }
  #path(path: string): string {
    if (path.includes("\\") || posix.isAbsolute(path))
      throw new DaytonaExecutionError("VALIDATION_FAILED", `Unsafe workspace path: ${path}`);
    const normalized = posix.normalize(path || ".");
    if (normalized === ".." || normalized.startsWith("../"))
      throw new DaytonaExecutionError("VALIDATION_FAILED", `Unsafe workspace path: ${path}`);
    return normalized === "." ? WORKSPACE : posix.join(WORKSPACE, normalized);
  }
  #allowedCommand(command: CommandRequest, preview = false): string {
    const args = [...(command.args ?? [])];
    if (
      !["node", "npm", "npx"].includes(command.executable) ||
      args.some((arg) => /[;&|`$<>\n\r]/.test(arg))
    )
      throw new DaytonaExecutionError(
        "VALIDATION_FAILED",
        "Command is outside the Sites allow-list",
      );
    const key = `${command.executable} ${args.join(" ")}`.trim();
    const allowed = new Set([
      "node --version",
      "npm --version",
      "npm ci",
      "npm install",
      "npm run build",
      "npm test",
      "npx tsc --noEmit",
    ]);
    const cliAllowed =
      /^node \.sites-cli\/sites-agent\.js (--version|inspect|status|build|run-task [A-Za-z0-9._/-]+)( --workspace [A-Za-z0-9._/-]+)?( --json)?$/.test(
        key,
      );
    const previewAllowed = preview && /^npm run dev -- --host 0\.0\.0\.0 --port \d+$/.test(key);
    if (!allowed.has(key) && !previewAllowed && !cliAllowed)
      throw new DaytonaExecutionError("VALIDATION_FAILED", `Command is not allow-listed: ${key}`);
    return key;
  }
  #filterEnvironment(environment?: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(environment ?? {}).filter(([key]) => ALLOWED_ENV.has(key)),
    );
  }
  #recordCommand(state: State, command: string, result: CommandResult): void {
    state.metrics.commandsExecuted += 1;
    state.metrics.commandDurationMs += result.durationMs;
    if (/^npm (ci|install)$/.test(command)) state.metrics.installDurationMs += result.durationMs;
    if (command === "npm run build") {
      state.metrics.buildDurationMs += result.durationMs;
      state.lastBuild = result;
    }
  }
}
