import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { LocalProcessManager } from "../../execution/local/local-process-manager.js";
import type { CommandRequest } from "../../execution/execution-types.js";

export interface TemplateBuildResult {
  readonly durationMs: number;
  readonly packageManager: "npm" | "pnpm" | "yarn";
}

export interface TemplateBuildRunner {
  build(directory: string): Promise<TemplateBuildResult>;
}

const BUILD_ENVIRONMENT = {
  DATABASE: "",
  REDIS_URL: "",
  JWTKEY: "",
  GOOGLE_APPLICATION_CREDENTIALS: "",
  SITES_TEMPLATE_GCS_BUCKET: "",
} as const;

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function buildScriptExists(directory: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const scripts = (value as Record<string, unknown>).scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      !Array.isArray(scripts) &&
      typeof (scripts as Record<string, unknown>).build === "string"
    );
  } catch {
    return false;
  }
}

async function commands(directory: string): Promise<{
  readonly packageManager: TemplateBuildResult["packageManager"];
  readonly install: CommandRequest;
  readonly build: CommandRequest;
}> {
  if (!(await buildScriptExists(directory)))
    throw new ApplicationError("MANIFEST_INVALID", "package.json must define a build script");
  if (await exists(join(directory, "package-lock.json")))
    return {
      packageManager: "npm",
      install: {
        executable: "npm",
        args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
        timeoutMs: 300_000,
        environment: BUILD_ENVIRONMENT,
      },
      build: {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: 120_000,
        environment: BUILD_ENVIRONMENT,
      },
    };
  if (await exists(join(directory, "pnpm-lock.yaml")))
    return {
      packageManager: "pnpm",
      install: {
        executable: "pnpm",
        args: ["install", "--frozen-lockfile"],
        timeoutMs: 300_000,
        environment: BUILD_ENVIRONMENT,
      },
      build: {
        executable: "pnpm",
        args: ["run", "build"],
        timeoutMs: 120_000,
        environment: BUILD_ENVIRONMENT,
      },
    };
  if (await exists(join(directory, "yarn.lock")))
    return {
      packageManager: "yarn",
      install: {
        executable: "yarn",
        args: ["install", "--immutable"],
        timeoutMs: 300_000,
        environment: BUILD_ENVIRONMENT,
      },
      build: {
        executable: "yarn",
        args: ["build"],
        timeoutMs: 120_000,
        environment: BUILD_ENVIRONMENT,
      },
    };
  throw new ApplicationError(
    "MANIFEST_INVALID",
    "A supported lockfile is required for deterministic template builds",
  );
}

/**
 * Executes package installation and the production build for trusted, internal
 * developer-authored templates. It is not a sandbox for untrusted uploads.
 */
export class TrustedInternalTemplateBuildRunner implements TemplateBuildRunner {
  async build(directory: string): Promise<TemplateBuildResult> {
    const selected = await commands(directory);
    const processes = new LocalProcessManager(64_000);
    const environmentId = "template-publisher";
    try {
      const install = await processes.run(environmentId, directory, selected.install, 300_000);
      if (install.exitCode !== 0 || install.timedOut)
        throw new ApplicationError("TEMPLATE_BUILD_FAILED", "Template dependency install failed", {
          metadata: { exitCode: install.exitCode, timedOut: install.timedOut },
        });
      const build = await processes.run(environmentId, directory, selected.build, 120_000);
      if (build.exitCode !== 0 || build.timedOut)
        throw new ApplicationError("TEMPLATE_BUILD_FAILED", "Template production build failed", {
          metadata: { exitCode: build.exitCode, timedOut: build.timedOut },
        });
      return {
        durationMs: install.durationMs + build.durationMs,
        packageManager: selected.packageManager,
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("TEMPLATE_BUILD_FAILED", "Unable to execute template build", {
        cause: error,
      });
    } finally {
      await processes.stopAll(environmentId);
    }
  }
}
