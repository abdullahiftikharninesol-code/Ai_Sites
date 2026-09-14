import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { LocalExecutionProvider } from "./execution/local/local-execution.provider.js";
import { BenchmarkRunner } from "./benchmarks/benchmark-runner.js";
import { BENCHMARK_SCENARIOS } from "./benchmarks/canonical-scenarios.js";
const root = resolve(".sites-runtime", "benchmarks"),
  provider = new LocalExecutionProvider({
    rootDirectory: join(root, "workspaces"),
    keepWorkspace: false,
    previewHost: "127.0.0.1",
    previewStartTimeoutMs: 10000,
    commandTimeoutMs: 30000,
    maxLogBytes: 64000,
  }),
  scenario = BENCHMARK_SCENARIOS.find((item) => item.id === "EXECUTION_PRIMITIVES")!,
  runner = new BenchmarkRunner();
let environmentId = "";
const result = await runner.run({
  scenario,
  providers: {
    agentProvider: "mock",
    executionProvider: "local",
    hostingProvider: "local",
    runtimeProvider: "local",
    authProvider: "local",
    artifactStore: "local",
  },
  workload: async () => {
    const created = Date.now(),
      environment = await provider.createEnvironment({ timeoutSeconds: 60 });
    environmentId = environment.id;
    const environmentCreationMs = Date.now() - created;
    await provider.writeFile(
      environment.id,
      "package.json",
      JSON.stringify({ scripts: { build: "node build.mjs" } }),
    );
    await provider.writeFile(environment.id, "build.mjs", 'import "./missing.mjs";');
    const first = await provider.executeCommand(environment.id, {
      executable: "npm",
      args: ["run", "build"],
    });
    await provider.writeFile(environment.id, "missing.mjs", 'console.log("benchmark build ready")');
    const repairStarted = Date.now(),
      second = await provider.executeCommand(environment.id, {
        executable: "npm",
        args: ["run", "build"],
      }),
      repairMs = Date.now() - repairStarted,
      usage = provider.getUsageMetrics(environment.id);
    await provider.destroyEnvironment(environment.id);
    environmentId = "";
    if (first.exitCode === 0 || second.exitCode !== 0)
      throw new Error("Controlled repair workload did not behave as expected");
    return {
      metrics: {
        environmentCreationMs,
        filesWritten: usage.filesWritten,
        buildAttempts: 2,
        buildMs: usage.buildDurationMs,
        repairMs,
        firstBuildSuccess: false,
        buildRepairCount: 1,
      },
      security: {
        secureIsolation: false,
        secretFiltering: true,
        networkControls: false,
        cleanupGuarantees: true,
        ttl: false,
        previewExposure: "LOCAL",
      },
    };
  },
});
if (environmentId) await provider.destroyEnvironment(environmentId);
const directory = join(root, "benchmark-results", "local");
await mkdir(directory, { recursive: true });
const path = join(directory, `${result.runId}.json`);
await writeFile(path, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      status: result.status,
      scenario: result.scenarioId,
      runId: result.runId,
      totalMs: result.metrics.totalScenarioMs,
      result: path,
    },
    null,
    2,
  ),
);
if (result.status !== "PASSED") process.exitCode = 1;
