#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { CliResult, CliTask } from "./protocol/cli-task.js";
export interface SitesCliIo {
  out(value: string): void;
  error(value: string): void;
}
export interface SitesCliDependencies {
  readonly runAgentTask?: (
    task: CliTask,
    workspace: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
}
export const SITES_CLI_VERSION = "0.1.0";
export async function runSitesCli(
  argv: readonly string[],
  io: SitesCliIo = { out: console.log, error: console.error },
  dependencies: SitesCliDependencies = {},
): Promise<number> {
  const started = Date.now();
  const json = argv.includes("--json");
  const clean = argv.filter((item) => item !== "--json");
  const workspaceIndex = clean.indexOf("--workspace");
  const workspaceArg = workspaceIndex >= 0 ? clean[workspaceIndex + 1] : undefined;
  const args = clean.filter(
    (_, index) => workspaceIndex < 0 || (index !== workspaceIndex && index !== workspaceIndex + 1),
  );
  const command = args[0];
  try {
    const workspace = resolve(workspaceArg ?? process.cwd());
    let result: CliResult;
    if (command === "--version" || command === "version") {
      io.out(SITES_CLI_VERSION);
      return 0;
    } else if (command === "inspect") {
      const files = await inspect(workspace);
      result = success("inspect", started, { workspace, files });
    } else if (command === "status")
      result = success("status", started, { workspace, runtime: "LOCAL_CLI" });
    else if (command === "build") {
      const execution = await run(workspace, "npm", ["run", "build"]);
      result = {
        success: execution.exitCode === 0,
        operation: "build",
        durationMs: Date.now() - started,
        exitCode: execution.exitCode,
        details: { stdout: execution.stdout, stderr: execution.stderr },
      };
    } else if (command === "preview")
      result = success("preview", started, {
        instruction: "Preview lifecycle is owned by ExecutionProvider.startPreview",
      });
    else if (command === "apply-task") {
      const taskFile = args[1];
      if (!taskFile) throw new Error("apply-task requires a task JSON file");
      const task = JSON.parse(await readFile(safe(workspace, taskFile), "utf8")) as CliTask;
      if (!task.target) throw new Error("REPLACE_TEXT task requires target");
      const target = safe(workspace, task.target.path);
      const current = await readFile(target, "utf8");
      if (!current.includes(task.target.find))
        throw new Error(`Task target text was not found in ${task.target.path}`);
      await writeFile(target, current.replace(task.target.find, task.target.replace), "utf8");
      result = success("apply-task", started, {
        path: task.target.path,
        jobId: task.jobId,
        siteId: task.siteId,
      });
    } else if (command === "run-task") {
      const taskFile = args[1];
      if (!taskFile) throw new Error("run-task requires a task JSON file");
      if (!dependencies.runAgentTask) throw new Error("run-task requires an AgentGateway runtime");
      const task = JSON.parse(await readFile(safe(workspace, taskFile), "utf8")) as CliTask;
      const report = await dependencies.runAgentTask(task, workspace);
      result = success("run-task", started, report);
    } else
      throw new Error(
        "Usage: sites-agent <--version|inspect|status|build|preview|apply-task|run-task> [task-file] [--workspace path] [--json]",
      );
    io.out(
      json
        ? JSON.stringify(result)
        : `${result.success ? "SUCCESS" : "FAILED"} ${result.operation} (${result.durationMs}ms)`,
    );
    return result.success ? 0 : 1;
  } catch (error) {
    const result: CliResult = {
      success: false,
      operation: command ?? "unknown",
      durationMs: Date.now() - started,
      exitCode: 1,
      details: { error: error instanceof Error ? error.message : "CLI failed" },
    };
    if (json) io.out(JSON.stringify(result));
    else io.error(JSON.stringify(result));
    return 1;
  }
}
function success(
  operation: string,
  started: number,
  details: Readonly<Record<string, unknown>>,
): CliResult {
  return { success: true, operation, durationMs: Date.now() - started, exitCode: 0, details };
}
function safe(workspace: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Unsafe workspace path: ${path}`);
  const target = resolve(workspace, path);
  const rel = relative(workspace, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Unsafe workspace path: ${path}`);
  return target;
}
async function inspect(workspace: string): Promise<readonly string[]> {
  const output: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
      const full = resolve(dir, entry.name);
      const path = relative(workspace, full).split(sep).join("/");
      output.push(path);
      if (entry.isDirectory()) await walk(full);
      else await stat(full);
    }
  };
  await walk(workspace);
  return output.sort();
}
async function run(
  cwd: string,
  executable: string,
  args: readonly string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const npmScript = executable === "npm" ? process.env.npm_execpath : undefined;
  const name = npmScript
    ? process.execPath
    : process.platform === "win32" && executable === "npm"
      ? "npm.cmd"
      : executable;
  const childArgs = npmScript ? [npmScript, ...args] : [...args];
  const child = spawn(name, childArgs, {
    cwd,
    shell: !npmScript && process.platform === "win32" && executable === "npm",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (value: Buffer) => {
    stdout += value.toString();
  });
  child.stderr.on("data", (value: Buffer) => {
    stderr += value.toString();
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href
)
  process.exitCode = await runSitesCli(process.argv.slice(2));
