import { fileURLToPath } from "node:url";
import { captureWorkerEnv, createSandboxCliRunner, runCloudBuildWorker } from "./cloud-build-worker.js";

/**
 * Cloud Run job entry point: `node dist/src/publishing/cloud/worker/main.js build|probe`.
 * The job template defines no environment; per-build inputs arrive as
 * execution overrides and are removed from process.env immediately.
 */
const env = captureWorkerEnv(process.env);
process.exitCode = await runCloudBuildWorker(process.argv[2] ?? "build", {
  env,
  fetch: globalThis.fetch,
  sandbox: createSandboxCliRunner(process.env.SITES_SANDBOX_CLI || "sandbox"),
  workRoot: "/work",
  selfCheckScript: fileURLToPath(new URL("./sandbox-self-check.js", import.meta.url)),
});
