import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type {
  ProductAcceptanceResult,
  ProductAcceptanceRunOutput,
  ProductAcceptanceScenario,
} from "./product-acceptance-types.js";

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ProductAcceptanceRunner {
  constructor(private readonly resultRoot = join(".sites-runtime", "acceptance", "results")) {}

  async run(input: {
    scenario: ProductAcceptanceScenario;
    execute: (scenario: ProductAcceptanceScenario) => Promise<ProductAcceptanceRunOutput>;
  }): Promise<{ readonly result: ProductAcceptanceResult; readonly path: string }> {
    const started = Date.now();
    const runId = randomUUID();
    let result: ProductAcceptanceResult;
    try {
      const output = await input.execute(input.scenario);
      const failed = output.checks.some((check) => check.status === "FAIL");
      const warnings =
        output.checks.some((check) => check.status === "WARNING") ||
        (output.issues?.length ?? 0) > 0;
      result = {
        schemaVersion: 1,
        scenarioId: input.scenario.id,
        scenarioVersion: input.scenario.version,
        runId,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        status: failed ? "FAILED" : warnings ? "PASS_WITH_WARNINGS" : "PASS",
        prompt: input.scenario.prompt,
        expectedCapabilities: input.scenario.expected,
        actualSpecs: {
          requirements: output.requirements,
          design: output.design,
          ...(output.siteSpec ? { siteSpec: output.siteSpec } : {}),
        },
        checks: output.checks,
        issues: output.issues ?? [],
        artifacts: output.artifacts ?? {},
        cleanup: { passed: output.cleanupPassed },
        reproducibility: this.#reproducibility(input.scenario),
        totalMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Acceptance execution failed";
      result = {
        schemaVersion: 1,
        scenarioId: input.scenario.id,
        scenarioVersion: input.scenario.version,
        runId,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        status: "FAILED",
        prompt: input.scenario.prompt,
        expectedCapabilities: input.scenario.expected,
        checks: [{ dimension: "cleanup", status: "FAIL", detail: message }],
        issues: [],
        artifacts: {},
        cleanup: { passed: false },
        reproducibility: this.#reproducibility(input.scenario),
        totalMs: Date.now() - started,
      };
    }
    const directory = join(this.resultRoot, input.scenario.id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${runId}.json`);
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return { result, path };
  }

  #reproducibility(scenario: ProductAcceptanceScenario) {
    return {
      sourceFingerprint: fingerprint({
        prompt: scenario.prompt,
        expected: scenario.expected,
        edits: scenario.edits,
      }),
      configFingerprint: fingerprint({
        agent: "mock",
        execution: "local",
        profile: "react-vite-v1@1",
      }),
      nodeVersion: process.version,
      platform: platform(),
      architecture: arch(),
    };
  }
}
