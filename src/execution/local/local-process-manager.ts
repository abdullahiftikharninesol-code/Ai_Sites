import { spawn, type ChildProcess } from "node:child_process";
import type { CommandRequest, CommandResult } from "../execution-types.js";
interface OwnedProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly command: string;
  readonly startedAt: Date;
  readonly posix: boolean;
  closed: boolean;
  exited: boolean;
  groupGone: boolean;
  stopping?: Promise<void>;
  status: "RUNNING" | "STOPPING" | "STOPPED";
}
const STOP_GRACE_MS = 2_000;
const STOP_FORCE_MS = 2_000;
const STOP_POLL_MS = 25;
export class LocalProcessManager {
  readonly #processes = new Map<string, Set<OwnedProcess>>();
  readonly #owned = new WeakMap<ChildProcess, OwnedProcess>();
  readonly #stoppedEnvironments = new Set<string>();
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
        // close can arrive while a timeout/cancellation is still stopping descendants.
        // Do not let the caller clean the workspace until the shared stop has finished.
        void this.stopProcess(child).then(() => resolve(timedOut ? null : code), reject);
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
      (item) => item.status !== "STOPPED",
    ).length;
  }
  async stopAll(environmentId: string): Promise<void> {
    this.#stoppedEnvironments.add(environmentId);
    const stops = await Promise.allSettled(
      [...(this.#processes.get(environmentId) ?? [])].map((owned) => this.stopProcess(owned.child)),
    );
    const failed = stops.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (this.#processes.get(environmentId)?.size)
      throw new Error("Local processes are still active; workspace cleanup was refused");
    this.#processes.delete(environmentId);
    this.#logs.delete(environmentId);
  }
  stopProcess(child: ChildProcess): Promise<void> {
    const owned = this.#owned.get(child);
    // Ownership is the ChildProcess object, never just a supplied/reused numeric PID.
    if (!owned || !owned.pid) return Promise.resolve();
    if (owned.stopping) return owned.stopping;
    owned.status = "STOPPING";
    // Publish the shared promise before signaling: a synchronous close callback must join it too.
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    owned.stopping = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    void this.#stopOwned(owned).then(() => { this.#release(owned); complete(); }, fail);
    return owned.stopping;
  }
  async #stopOwned(owned: OwnedProcess): Promise<void> {
    if (owned.posix) {
      if (owned.pid! <= 1 || owned.pid === process.pid)
        throw new Error("Refusing an unsafe local process group");
      const live = this.#groupExists(owned);
      // Once the leader exited, an unclaimed numeric group may have been reused.
      // Never adopt it for a new stop; retain the workspace if ownership is uncertain.
      if (live && this.#exited(owned))
        throw new Error("Local process leader already exited; group ownership is uncertain and workspace cleanup was refused");
      if (live) this.#signalGroup(owned, "SIGTERM");
      if (!(await this.#waitFor(() => !this.#groupExists(owned) && owned.closed, STOP_GRACE_MS))) {
        this.#signalGroup(owned, "SIGKILL");
        if (!(await this.#waitFor(() => !this.#groupExists(owned) && owned.closed, STOP_FORCE_MS)))
          throw new Error("Local process group did not terminate; workspace cleanup was refused");
      }
      return;
    }
    // Keep Windows tree termination and its direct-child fallback.
    if (!this.#exited(owned)) {
      const killer = spawn("taskkill.exe", ["/pid", String(owned.pid), "/t", "/f"], { windowsHide: true });
      const succeeded = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          killer.kill("SIGKILL");
          resolve(false);
        }, STOP_GRACE_MS);
        killer.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
        killer.once("error", () => { clearTimeout(timer); resolve(false); });
      });
      if (!succeeded && !this.#exited(owned)) owned.child.kill("SIGKILL");
    }
    if (!(await this.#waitFor(() => owned.closed, STOP_FORCE_MS)))
      throw new Error("Local process did not close; workspace cleanup was refused");
  }
  #exited(owned: OwnedProcess) {
    return owned.exited || owned.child.exitCode !== null || owned.child.signalCode !== null;
  }
  #groupExists(owned: OwnedProcess): boolean {
    if (owned.groupGone) return false;
    try {
      process.kill(-owned.pid!, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      owned.groupGone = true; // Never signal this numeric group again after observing its disappearance.
      return false;
    }
  }
  #signalGroup(owned: OwnedProcess, signal: NodeJS.Signals) {
    if (owned.groupGone) return;
    try {
      process.kill(-owned.pid!, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      owned.groupGone = true;
    }
  }
  async #waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(STOP_POLL_MS, deadline - Date.now())));
    }
    return true;
  }
  #release(owned: OwnedProcess) {
    owned.status = "STOPPED";
    this.#owned.delete(owned.child);
    for (const [environmentId, set] of this.#processes) {
      if (!set.delete(owned)) continue;
      if (!set.size) this.#processes.delete(environmentId);
      break;
    }
  }
  #spawn(environmentId: string, cwd: string, request: CommandRequest): ChildProcess {
    if (this.#stoppedEnvironments.has(environmentId)) throw new Error("Local environment is stopping or stopped");
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
      // setsid on POSIX: this child's PID is its private process-group ID.
      // Windows retains taskkill /t, without a detached console/process group.
      detached: process.platform !== "win32",
      shell: !npmScript && process.platform === "win32" && request.executable === "npm",
      env: safeEnvironment(request.environment, request.isolatedEnvironment === true),
    });
    const owned: OwnedProcess = {
      child,
      pid: child.pid,
      command: `${request.executable} ${(request.args ?? []).join(" ")}`,
      startedAt: new Date(),
      posix: process.platform !== "win32",
      closed: false,
      exited: false,
      groupGone: false,
      status: "RUNNING",
    };
    const set = this.#processes.get(environmentId) ?? new Set<OwnedProcess>();
    set.add(owned);
    this.#processes.set(environmentId, set);
    this.#owned.set(child, owned);
    const record = (chunk: Buffer) => this.#append(environmentId, chunk.toString());
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);
    child.once("exit", () => { owned.exited = true; });
    child.once("close", () => {
      owned.closed = true;
      if (owned.status === "STOPPING") return;
      try {
        if (!owned.pid || !owned.posix || !this.#groupExists(owned)) this.#release(owned);
      } catch { /* Unknown ownership keeps the workspace protected until an explicit stop reports the failure. */ }
    });
    child.once("error", () => { if (!owned.pid) this.#release(owned); });
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
/**
 * What a command with `isolatedEnvironment` may inherit: OS process plumbing
 * and the npm cache location only. Server credentials (JWTKEY, database/Redis
 * URIs, encryption keys, provider keys) are never passed through. This limits
 * environment variables only; it is not filesystem or network isolation.
 */
const ISOLATED_ENVIRONMENT_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "OS", "LANG", "LC_ALL", "TZ", "NPM_CONFIG_CACHE",
]);
export function safeEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
  isolated = false,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      isolated
        ? ISOLATED_ENVIRONMENT_KEYS.has(key.toUpperCase())
        : !/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)
    )
      environment[key] = value;
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key))
      throw new Error(`Sensitive environment variable is not allowed in local execution: ${key}`);
    environment[key] = value;
  }
  return environment;
}
