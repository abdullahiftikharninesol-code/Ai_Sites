import { Daytona } from "@daytona/sdk";
import type { DaytonaConfig } from "./daytona-config.js";

export interface DaytonaFileInfo {
  readonly name: string;
  readonly path?: string;
  readonly isDir: boolean;
  readonly size: number;
}
export interface DaytonaCommandResponse {
  readonly exitCode?: number;
  readonly result?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly cmdId?: string;
}
export interface DaytonaSandboxClient {
  readonly id: string;
  readonly createdAt?: string;
  readonly autoDestroyAt?: string;
  createFolder(path: string): Promise<void>;
  listFiles(path: string, depth?: number): Promise<readonly DaytonaFileInfo[]>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  execute(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutSeconds: number,
  ): Promise<DaytonaCommandResponse>;
  startSession(
    sessionId: string,
    command: string,
    timeoutSeconds: number,
  ): Promise<DaytonaCommandResponse>;
  sessionLogs(sessionId: string, commandId: string): Promise<DaytonaCommandResponse>;
  signedPreviewUrl(port: number, expiresSeconds: number): Promise<{ readonly url: string }>;
}
export interface DaytonaClient {
  create(input: {
    readonly envVars: Record<string, string>;
    readonly resources: { readonly cpu: number; readonly memory: number; readonly disk: number };
    readonly ttlMinutes: number;
    readonly networkBlockAll?: boolean;
  }): Promise<DaytonaSandboxClient>;
  delete(sandbox: DaytonaSandboxClient): Promise<void>;
}

export function createDaytonaClient(config: DaytonaConfig): DaytonaClient {
  const sdk = new Daytona({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    ...(config.target ? { target: config.target } : {}),
  });
  const native = new Map<string, Awaited<ReturnType<Daytona["create"]>>>();
  return {
    async create(input) {
      const sandbox = await sdk.create({
        image: "node:22-bookworm",
        language: "typescript",
        ephemeral: true,
        public: false,
        autoStopInterval: 15,
        autoDeleteInterval: 0,
        ttlMinutes: input.ttlMinutes,
        envVars: input.envVars,
        resources: input.resources,
        ...(input.networkBlockAll !== undefined ? { networkBlockAll: input.networkBlockAll } : {}),
      });
      native.set(sandbox.id, sandbox);
      return {
        id: sandbox.id,
        ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}),
        ...(sandbox.autoDestroyAt ? { autoDestroyAt: sandbox.autoDestroyAt } : {}),
        createFolder: async (path) => sandbox.fs.createFolder(path, "755"),
        listFiles: (path, depth = 20) => sandbox.fs.listFiles(path, { depth }),
        readFile: (path) => sandbox.fs.downloadFile(path),
        writeFile: (path, content) => sandbox.fs.uploadFile(content, path),
        execute: async (command, cwd, env, timeout) => {
          const result = await sandbox.process.executeCommand(command, cwd, env, timeout);
          return { exitCode: result.exitCode, result: result.result };
        },
        startSession: async (sessionId, command, timeout) => {
          await sandbox.process.createSession(sessionId);
          const result = await sandbox.process.executeSessionCommand(
            sessionId,
            { command, runAsync: true, suppressInputEcho: true },
            timeout,
          );
          return {
            ...(result.cmdId ? { cmdId: result.cmdId } : {}),
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
            ...(result.stdout ? { stdout: result.stdout } : {}),
            ...(result.stderr ? { stderr: result.stderr } : {}),
          };
        },
        sessionLogs: async (sessionId, commandId) =>
          sandbox.process.getSessionCommandLogs(sessionId, commandId),
        signedPreviewUrl: async (port, expiresSeconds) => {
          const result = await sandbox.getSignedPreviewUrl(port, expiresSeconds);
          return { url: result.url };
        },
      };
    },
    async delete(sandbox) {
      const item = native.get(sandbox.id);
      if (item) await sdk.delete(item, 60, true);
      native.delete(sandbox.id);
    },
  };
}
