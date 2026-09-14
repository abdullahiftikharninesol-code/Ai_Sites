import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { CliTask } from "../protocol/cli-task.js";
import type { SitesCliBundle } from "./sites-cli-bundle.js";
import { CliBundleInstaller } from "./sites-cli-bundle.js";
import { ApplicationError } from "../../app/errors/application-error.js";

export interface SandboxCliReport {
  readonly runtime: "SANDBOX_CLI";
  readonly cliVersion: string;
  readonly cliInstallMs: number;
  readonly taskExitCode: number | null;
}
export class SandboxCliAgentRuntime {
  constructor(
    private readonly execution: ExecutionProvider,
    private readonly bundle: SitesCliBundle,
  ) {}
  async run(environmentId: string, task: CliTask, signal?: AbortSignal): Promise<SandboxCliReport> {
    if (task.runtime !== "SANDBOX_CLI")
      throw new ApplicationError("VALIDATION_FAILED", "Agent task runtime must be SANDBOX_CLI");
    if (signal?.aborted)
      throw new ApplicationError("JOB_CANCELLED", "Sandbox CLI task was cancelled");
    const serialized = JSON.stringify(task);
    if (/(API_KEY|DATABASE_URL|SQLITE|HOSTING_SECRET)/i.test(serialized))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Sandbox CLI task contains forbidden backend credential fields",
      );
    const installed = await new CliBundleInstaller(this.execution).install(
      environmentId,
      this.bundle,
    );
    await this.execution.writeFile(environmentId, ".sites-cli/task.json", serialized);
    const result = await this.execution.executeCommand(environmentId, {
      executable: "node",
      args: [
        this.bundle.entrypoint,
        "run-task",
        ".sites-cli/task.json",
        "--workspace",
        ".",
        "--json",
      ],
      timeoutMs: task.limits?.timeoutMs ?? 180_000,
      environment: {
        SITES_JOB_ID: task.jobId,
        SITES_SITE_ID: task.siteId,
        SITES_CLI_VERSION: installed.cliVersion,
      },
    });
    return {
      runtime: "SANDBOX_CLI",
      cliVersion: installed.cliVersion,
      cliInstallMs: installed.installMs,
      taskExitCode: result.exitCode,
    };
  }
}
