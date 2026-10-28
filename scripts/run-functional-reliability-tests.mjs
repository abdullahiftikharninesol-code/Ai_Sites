import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

// Keep test profiles, temporary projects, logs and compile caches alongside the
// checkout (D: on the development machine), never in the system TEMP directory.
const root = resolve(import.meta.dirname, "..");
const scratch = join(root, ".sites-runtime", "functional-test-scratch");
for (const name of ["tmp", "node-cache", "npm-logs"]) mkdirSync(join(scratch, name), { recursive: true });
const supplied = process.argv.slice(2);
const suites = supplied.length ? supplied : [
  "tests/production-functional-behavior.test.ts", "tests/production-functional-pipeline.test.ts",
  "tests/route-aware-functional-contract.test.ts", "tests/route-aware-behavior.test.ts",
  "tests/accordion-reliability.test.ts", "tests/build-repair-reliability.test.ts",
];
const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...suites, "--maxWorkers=1", "--testTimeout=300000"], {
  cwd: root, stdio: "inherit", env: { ...process.env,
    TEMP: join(scratch, "tmp"), TMP: join(scratch, "tmp"), NODE_COMPILE_CACHE: join(scratch, "node-cache"),
    npm_config_logs_dir: join(scratch, "npm-logs"), npm_config_offline: "true",
  },
});
if (result.error) { process.stderr.write(result.error.message + "\n"); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
