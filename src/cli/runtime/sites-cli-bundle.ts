import { readFile } from "node:fs/promises";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { ApplicationError } from "../../app/errors/application-error.js";
import { SITES_CLI_VERSION } from "../sites-cli.js";

export interface SitesCliBundle {
  readonly version: string;
  readonly entrypoint: string;
  readonly content: string;
}
export async function loadBuiltSitesCliBundle(
  path = "dist/src/cli/sites-cli.js",
): Promise<SitesCliBundle> {
  return {
    version: SITES_CLI_VERSION,
    entrypoint: ".sites-cli/sites-agent.js",
    content: await readFile(path, "utf8"),
  };
}
export class CliBundleInstaller {
  constructor(private readonly execution: ExecutionProvider) {}
  async install(
    environmentId: string,
    bundle: SitesCliBundle,
  ): Promise<{ readonly cliVersion: string; readonly installMs: number }> {
    const started = Date.now();
    await this.execution.writeFile(environmentId, bundle.entrypoint, bundle.content);
    const result = await this.execution.executeCommand(environmentId, {
      executable: "node",
      args: [bundle.entrypoint, "--version"],
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== bundle.version)
      throw new ApplicationError(
        "PROJECT_BOOTSTRAP_FAILED",
        "Sites CLI remote version verification failed",
      );
    return { cliVersion: bundle.version, installMs: Date.now() - started };
  }
}
