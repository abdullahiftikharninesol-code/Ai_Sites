import { randomUUID } from "node:crypto";
import { platform, arch } from "node:os";
import type {
  BenchmarkMetric,
  BenchmarkProviders,
  BenchmarkResult,
  BenchmarkScenario,
  BenchmarkSecurityCapabilities,
} from "./benchmark-types.js";
export interface BenchmarkWorkloadResult {
  readonly metrics: Omit<BenchmarkMetric, "totalScenarioMs">;
  readonly security: BenchmarkSecurityCapabilities;
}
export class BenchmarkRunner {
  async run(input: {
    scenario: BenchmarkScenario;
    providers: BenchmarkProviders;
    repetition?: number;
    workload: () => Promise<BenchmarkWorkloadResult>;
  }): Promise<BenchmarkResult> {
    const started = Date.now(),
      startedAt = new Date(started).toISOString(),
      runId = randomUUID();
    try {
      const output = await input.workload();
      const completed = Date.now();
      return {
        schemaVersion: 1,
        scenarioId: input.scenario.id,
        scenarioVersion: input.scenario.version,
        tier: input.scenario.tier,
        runId,
        repetition: input.repetition ?? 1,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        status: "PASSED",
        providers: input.providers,
        metrics: { ...output.metrics, totalScenarioMs: completed - started },
        security: output.security,
        reproducibility: {
          nodeVersion: process.version,
          os: platform(),
          architecture: arch(),
          starterVersion: "react-vite-v1@1",
          cliVersion: "sites-cli-v1",
          technicalProfileVersion: "react-vite-v1",
          resourceProfile: "local-default",
        },
      };
    } catch (error) {
      const completed = Date.now(),
        failure = error instanceof Error ? error : new Error("Benchmark failed");
      return {
        schemaVersion: 1,
        scenarioId: input.scenario.id,
        scenarioVersion: input.scenario.version,
        tier: input.scenario.tier,
        runId,
        repetition: input.repetition ?? 1,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        status: "FAILED",
        providers: input.providers,
        metrics: { totalScenarioMs: completed - started },
        security: {
          secureIsolation: false,
          secretFiltering: false,
          networkControls: false,
          cleanupGuarantees: false,
          ttl: false,
          previewExposure: "NONE",
        },
        reproducibility: {
          nodeVersion: process.version,
          os: platform(),
          architecture: arch(),
          starterVersion: "react-vite-v1@1",
          cliVersion: "sites-cli-v1",
          technicalProfileVersion: "react-vite-v1",
          resourceProfile: "local-default",
        },
        failure: { code: "BENCHMARK_FAILED", message: failure.message },
      };
    }
  }
}
