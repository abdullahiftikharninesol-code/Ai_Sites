import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
function sourceDigest() {
  const hash = createHash("sha256");
  const visit = path => {
    for (const item of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, item.name);
      if (item.isDirectory() && !["node_modules", "dist", "build", ".next", ".sites-runtime"].includes(item.name)) visit(file);
      else if (item.isFile()) { hash.update(file.replaceAll("\\", "/")); hash.update("\0"); hash.update(readFileSync(join(root, file))); }
    }
  };
  for (const path of ["src", "tests", "scripts"]) visit(path);
  for (const path of ["package.json", "package-lock.json", "vitest.config.ts", "tsconfig.json", "tsconfig.build.json"]) {
    if (existsSync(join(root, path))) { hash.update(path); hash.update(readFileSync(join(root, path))); }
  }
  return hash.digest("hex");
}
const initialSourceDigest = sourceDigest();
const dir = join(root, ".sites-runtime", "complex-release", new Date().toISOString().replace(/[:.]/g, "-"));
for (const name of ["tmp", "node-cache", "npm-logs"]) mkdirSync(join(dir, name), { recursive: true });
const suites = ["tests/usable-generation-policy.test.ts", "tests/complex-generation-reliability.test.ts", "tests/complex-generation-pipeline.test.ts", "tests/build-repair-reliability.test.ts", "tests/build-repair-pipeline.test.ts",
  "tests/universal-generation-reliability.test.ts", "tests/route-aware-functional-contract.test.ts", "tests/production-functional-behavior.test.ts",
  "tests/targeted-edit-ambiguity.test.ts", "tests/targeted-edit-scope.test.ts", "tests/sites-credit-billing.test.ts"];
const outcomes = new Map(), runs = [];
for (let index = 1; index <= 2; index++) {
  const output = join(dir, `run-${index}.json`), metrics = join(dir, `metrics-${index}.jsonl`);
  const child = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...suites,
    "--maxWorkers=1", "--testTimeout=300000", "--reporter=json", `--outputFile=${output}`], {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TEMP: join(dir, "tmp"), TMP: join(dir, "tmp"), NODE_COMPILE_CACHE: join(dir, "node-cache"),
      npm_config_logs_dir: join(dir, "npm-logs"), npm_config_offline: "true", SITES_COMPLEX_METRICS_FILE: metrics,
      SITES_DEV_AGENT_PROVIDER: "mock", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "",
      DATABASE: "mongodb://127.0.0.1:1/disabled-offline-release", REDIS_URL: "redis://127.0.0.1:1" },
  });
  writeFileSync(join(dir, `run-${index}.log`), (child.stdout ?? "") + (child.stderr ?? ""), { mode: 0o600 });
  let report;
  try { report = JSON.parse(readFileSync(output, "utf8")); } catch { process.stderr.write(`Release run ${index} produced no valid test report. See ${dir}\n`); process.exitCode = 1; break; }
  let rows = [];
  try { rows = readFileSync(metrics, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { process.stderr.write(`Release run ${index} produced missing or invalid fixture metrics. See ${dir}\n`); process.exitCode = 1; }
  for (const suite of report.testResults ?? []) for (const test of suite.assertionResults ?? []) {
    const key = suite.name + ":" + test.fullName; const states = outcomes.get(key) ?? new Set(); states.add(test.status); outcomes.set(key, states);
  }
  const failures = (report.testResults ?? []).flatMap(suite => (suite.assertionResults ?? []).filter(test => test.status === "failed").map(test => ({ name: test.fullName, message: test.failureMessages?.join("\n").slice(0, 2000) })));
  const run = { run: index, passed: report.numPassedTests, failed: report.numFailedTests, totalMs: (report.testResults ?? []).reduce((sum, suite) => sum + Math.max(0, suite.endTime - suite.startTime), 0),
    fixtureCount: rows.length, buildMs: rows.reduce((sum, row) => sum + row.buildMs, 0), qaMs: rows.reduce((sum, row) => sum + row.qaMs, 0),
    cleanupFailures: rows.filter(row => !row.browserCleanup || !row.portsClosed || !row.environmentsDestroyed).length,
    failures, fixtureMetrics: rows };
  runs.push(run); process.stdout.write(JSON.stringify({ ...run, fixtureMetrics: undefined }) + "\n");
  if (child.error || child.status !== 0 || report.numFailedTests || rows.length !== 12 || run.cleanupFailures) process.exitCode = 1;
}
const flakyFailureCount = [...outcomes.values()].filter(states => states.has("passed") && states.has("failed")).length;
const total = runs.reduce((sum, run) => sum + run.passed + run.failed, 0);
const expectedFailureCategories = {};
for (const run of runs) for (const fixture of run.fixtureMetrics) {
  for (const category of fixture.failureCategories) expectedFailureCategories[category] = (expectedFailureCategories[category] ?? 0) + 1;
  if (fixture.outcome === "EXPECTED_PATCH_REJECTION") expectedFailureCategories.PATCH_APPLICATION = (expectedFailureCategories.PATCH_APPLICATION ?? 0) + 1;
}
const finalSourceDigest = sourceDigest();
if (initialSourceDigest !== finalSourceDigest) { process.exitCode = 1; process.stderr.write("Source changed during the release gate; repeat against a stable worktree.\n"); }
const result = { status: runs.length === 2 && !process.exitCode && !flakyFailureCount ? "PASS" : "FAIL", runs, initialSourceDigest, finalSourceDigest,
  passRate: total ? runs.reduce((sum, run) => sum + run.passed, 0) / total : 0, flakyFailureCount, expectedFailureCategories, externalProviderCalls: 0, sharedWrites: 0 };
writeFileSync(join(dir, "release-summary.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify({ status: result.status, passRate: result.passRate, flakyFailureCount, report: join(dir, "release-summary.json") }) + "\n");
if (result.status !== "PASS") process.exitCode = 1;
