import { createHash } from "node:crypto";
import type { AgentToolCall, AgentToolName } from "./agent-types.js";
import type { ExecutionProvider } from "../execution/execution-provider.js";
import { validateToolArguments } from "./tool-catalog.js";
import { normalizeBuildLog } from "../cli/runtime/build-log-normalizer.js";

export interface ToolObservation {
  readonly toolCallId: string;
  readonly name: AgentToolName;
  readonly output: string;
}
export interface SitesToolExecutorOptions {
  readonly maxObservationBytes?: number;
  readonly maxFilesWritten?: number;
  readonly maxTotalWrittenBytes?: number;
  readonly maxBuildAttempts?: number;
  readonly onToolStart?: (name: AgentToolName) => void;
  readonly compactObservations?: boolean;
  readonly maxSearchMatches?: number;
  readonly maxSearchBytes?: number;
}
const stringArg = (args: Readonly<Record<string, unknown>>, name: string): string => {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`Tool argument '${name}' must be a string`);
  return value;
};
const contentEncoding = (args: Readonly<Record<string, unknown>>): "utf8" | "base64" => {
  const value = args.encoding;
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new Error("Tool argument 'encoding' must be 'utf8' or 'base64'");
};
const safePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === ".") ||
    !normalized
  )
    throw new Error(`Unsafe tool path: ${path}`);
  return normalized;
};

export class SitesToolExecutor {
  #filesWritten = 0;
  #bytesWritten = 0;
  #buildAttempts = 0;
  constructor(
    private readonly execution: ExecutionProvider,
    private readonly options: SitesToolExecutorOptions = {},
  ) {}
  get filesWritten(): number {
    return this.#filesWritten;
  }
  get bytesWritten(): number {
    return this.#bytesWritten;
  }
  get buildAttempts(): number {
    return this.#buildAttempts;
  }
  get executionProvider(): ExecutionProvider {
    return this.execution;
  }
  async execute(environmentId: string, call: AgentToolCall): Promise<ToolObservation> {
    const args = validateToolArguments(call.name, call.arguments);
    this.options.onToolStart?.(call.name);
    let output: string;
    switch (call.name) {
      case "list_files":
        output = JSON.stringify(
          await this.execution.listFiles(
            environmentId,
            typeof args.path === "string" ? args.path : undefined,
          ),
        );
        break;
      case "read_file": {
        const path = safePath(stringArg(args, "path"));
        if (contentEncoding(args) === "base64") {
          if (!this.execution.readFileBytes)
            throw new Error("Binary file reads are not supported by this execution provider");
          output = Buffer.from(await this.execution.readFileBytes(environmentId, path)).toString(
            "base64",
          );
        } else output = await this.execution.readFile(environmentId, path);
        break;
      }
      case "write_file": {
        const path = safePath(stringArg(args, "path"));
        const content = stringArg(args, "content");
        let bytesWritten = 0;
        let sha256 = "";
        if (contentEncoding(args) === "base64") {
          if (!this.execution.writeFileBytes)
            throw new Error("Binary file writes are not supported by this execution provider");
          const bytes = Buffer.from(content, "base64");
          bytesWritten = bytes.byteLength;
          sha256 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
          this.#recordWrite(bytesWritten);
          await this.execution.writeFileBytes(environmentId, path, bytes);
        } else {
          bytesWritten = Buffer.byteLength(content, "utf8");
          sha256 = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
          this.#recordWrite(bytesWritten);
          await this.execution.writeFile(environmentId, path, content);
        }
        if (this.options.compactObservations) {
          output = `WROTE ${path}\nbytes: ${bytesWritten}\nsha256: ${sha256}`;
        } else {
          output = "written";
        }
        break;
      }
      case "apply_patch": {
        const path = safePath(stringArg(args, "path"));
        const current = await this.execution.readFile(environmentId, path);
        const find = stringArg(args, "find");
        if (!current.includes(find)) throw new Error(`Patch target not found in ${path}`);
        const replacement = current.replace(find, stringArg(args, "replace"));
        this.#recordWrite(Buffer.byteLength(replacement));
        await this.execution.writeFile(environmentId, path, replacement);
        if (this.options.compactObservations) {
          output = `PATCHED ${path}\nreplacements: 1`;
        } else {
          output = "patched";
        }
        break;
      }
      case "search_files": {
        const query = stringArg(args, "query");
        const maxMatches = this.options.maxSearchMatches ?? 10;
        const maxBytes = this.options.maxSearchBytes ?? 2_000;
        let matches: readonly string[] = [];
        if (this.execution.searchFiles) {
          matches = await this.execution.searchFiles(environmentId, query);
        } else {
          const files = await this.execution.listFiles(environmentId);
          const found: string[] = [];
          for (const file of files) {
            if ((await this.execution.readFile(environmentId, file.path)).includes(query)) {
              found.push(file.path);
            }
          }
          matches = found;
        }
        const boundedMatches = matches.slice(0, maxMatches);
        let serialized = JSON.stringify(boundedMatches);
        if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
          serialized = JSON.stringify(boundedMatches.slice(0, Math.max(1, Math.floor(maxMatches / 2))));
        }
        output = serialized;
        break;
      }
      case "run_build": {
        this.#buildAttempts += 1;
        if (this.#buildAttempts > (this.options.maxBuildAttempts ?? Number.POSITIVE_INFINITY))
          throw new Error("CLI exceeded maximum build repair attempts");
        const buildResult = await this.execution.executeCommand(environmentId, {
          executable: "npm",
          args: ["run", "build"],
          timeoutMs: 30_000,
        });
        if (this.options.compactObservations) {
          if (buildResult.exitCode === 0 && !buildResult.timedOut) {
            output = JSON.stringify({ exitCode: 0, status: "SUCCESS" });
          } else {
            const normalized = normalizeBuildLog(buildResult.stderr, buildResult.stdout);
            output = JSON.stringify({
              exitCode: buildResult.exitCode,
              timedOut: buildResult.timedOut,
              diagnostics: normalized,
            });
          }
        } else {
          if (this.#filesWritten === 0) {
            output = JSON.stringify({
              ...buildResult,
              warning:
                "Build ran on untouched starter template. NO site code has been written yet! You must overwrite src/App.tsx with the user's requested site code using write_file.",
            });
          } else {
            output = JSON.stringify(buildResult);
          }
        }
        break;
      }
      case "start_preview":
        output = JSON.stringify(
          await this.execution.startPreview(environmentId, {
            port: typeof args.port === "number" ? args.port : 4173,
          }),
        );
        break;
      case "read_logs":
        output = JSON.stringify(
          this.execution.readLogs ? await this.execution.readLogs(environmentId) : [],
        );
        break;
      case "run_command": {
        const executable = stringArg(args, "executable");
        const commandArgs =
          Array.isArray(args.args) && args.args.every((value) => typeof value === "string")
            ? args.args
            : [];
        if (executable !== "npm" || commandArgs.join(" ") !== "run build")
          throw new Error("Command is not allow-listed");
        output = JSON.stringify(
          await this.execution.executeCommand(environmentId, { executable, args: commandArgs }),
        );
        break;
      }
      case "finalize_generation": {
        throw new Error(
          "finalize_generation is a control tool that must be intercepted and evaluated by the agent loop, not executed by SitesToolExecutor directly",
        );
      }
    }
    const maximum = this.options.maxObservationBytes;
    if (maximum && Buffer.byteLength(output) > maximum)
      output = `[truncated to last ${maximum} bytes]\n${Buffer.from(output).subarray(-maximum).toString()}`;
    return { toolCallId: call.id, name: call.name, output };
  }
  async executeSafe(environmentId: string, call: AgentToolCall): Promise<ToolObservation> {
    try {
      return await this.execute(environmentId, call);
    } catch (error) {
      return {
        toolCallId: call.id,
        name: call.name,
        output: JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "Tool execution failed",
        }),
      };
    }
  }
  #recordWrite(bytes: number): void {
    if (this.#filesWritten + 1 > (this.options.maxFilesWritten ?? Number.POSITIVE_INFINITY))
      throw new Error("CLI exceeded maximum files written");
    if (
      this.#bytesWritten + bytes >
      (this.options.maxTotalWrittenBytes ?? Number.POSITIVE_INFINITY)
    )
      throw new Error("CLI exceeded maximum written bytes");
    this.#filesWritten += 1;
    this.#bytesWritten += bytes;
  }
}
