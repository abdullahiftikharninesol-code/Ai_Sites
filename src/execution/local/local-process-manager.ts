import { spawn, type ChildProcess } from "node:child_process";
import type { CommandRequest, CommandResult } from "../execution-types.js";
interface OwnedProcess {
  readonly child: ChildProcess;
  readonly command: string;
  readonly startedAt: Date;
  status: "RUNNING" | "STOPPED";
}
export class LocalProcessManager {
  readonly #processes = new Map<string, Set<OwnedProcess>>();
  readonly #logs = new Map<string, string>();
  constructor(private readonly maxLogBytes: number) {}
  async run(
    environmentId: string,
    cwd: string,
    request: CommandRequest,
    defaultTimeoutMs: number,
  ): Promise<CommandResult> {
    const startedAt = new Date();
    const child = this.#spawn(environmentId, cwd, request);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = this.#tail(stdout + text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = this.#tail(stderr + text);
    });
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        void this.stopProcess(child).then(() => resolve(null), reject);
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const finishedAt = new Date();
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }
  start(environmentId: string, cwd: string, request: CommandRequest): ChildProcess {
    return this.#spawn(environmentId, cwd, request);
  }
  readLogs(environmentId: string): readonly string[] {
    const value = this.#logs.get(environmentId) ?? "";
    return value ? value.split(/\r?\n/).filter(Boolean) : [];
  }
  processCount(environmentId: string): number {
    return [...(this.#processes.get(environmentId) ?? [])].filter(
      (item) => item.status === "RUNNING",
    ).length;
  }
  async stopAll(environmentId: string): Promise<void> {
    for (const owned of this.#processes.get(environmentId) ?? [])
      await this.stopProcess(owned.child);
    this.#processes.delete(environmentId);
    this.#logs.delete(environmentId);
  }
  async stopProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === "win32" && child.pid) {
      const stopped =
        child.exitCode === null
          ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
          : Promise.resolve();
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
        });
        killer.once("exit", (code) => {
          if (code !== 0) child.kill("SIGKILL");
          resolve();
        });
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
      });
      await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      return;
    }
    if (child.exitCode !== null) return;
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }
  #spawn(environmentId: string, cwd: string, request: CommandRequest): ChildProcess {
    const npmScript = request.executable === "npm" ? process.env.npm_execpath : undefined;
    const executable = npmScript
      ? process.execPath
      : process.platform === "win32" && request.executable === "npm"
        ? "npm.cmd"
        : request.executable;
    const args = npmScript ? [npmScript, ...(request.args ?? [])] : [...(request.args ?? [])];
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: !npmScript && process.platform === "win32" && request.executable === "npm",
      env: safeEnvironment(request.environment),
    });
    const owned: OwnedProcess = {
      child,
      command: `${request.executable} ${(request.args ?? []).join(" ")}`,
      startedAt: new Date(),
      status: "RUNNING",
    };
    const set = this.#processes.get(environmentId) ?? new Set<OwnedProcess>();
    set.add(owned);
    this.#processes.set(environmentId, set);
    const record = (chunk: Buffer) => this.#append(environmentId, chunk.toString());
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);
    const release = () => {
      owned.status = "STOPPED";
      set.delete(owned);
      if (set.size === 0 && this.#processes.get(environmentId) === set)
        this.#processes.delete(environmentId);
    };
    child.once("exit", release);
    child.once("error", release);
    return child;
  }
  #append(environmentId: string, text: string): void {
    const combined = `${this.#logs.get(environmentId) ?? ""}${text}`;
    this.#logs.set(environmentId, this.#tail(combined));
  }
  #tail(value: string): string {
    const bytes = Buffer.from(value);
    if (bytes.length <= this.maxLogBytes) return value;
    let start = Math.max(0, bytes.length - this.maxLogBytes);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  }
}
function safeEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) environment[key] = value;
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key))
      throw new Error(`Sensitive environment variable is not allowed in local execution: ${key}`);
    environment[key] = value;
  }
  return environment;
}
