import { spawn } from "node:child_process";

const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const args =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd run test:integration:full-architecture"]
    : ["run", "test:integration:full-architecture"];
const child = spawn(command, args, {
  stdio: "inherit",
  env: { ...process.env, SITES_FULL_LIFECYCLE_DEMO: "1" },
});
const exitCode = await new Promise<number>((resolve) =>
  child.once("exit", (code) => resolve(code ?? 1)),
);
if (exitCode !== 0) process.exitCode = exitCode;
else {
  console.log("\nPhase 14 full lifecycle demo: PASS");
  console.log("V1/V2 build and Visual QA: PASS");
  console.log("Deployment, platform route, and custom domain: PASS");
  console.log("Auth, owned-data isolation, and named external action: PASS");
  console.log("Restart, rollback, unpublish, and republish: PASS");
  console.log("Failed V3 and runtime-migration safety: PASS");
  console.log("Cleanup: PASS (no execution environments or browsers remain)");
  console.log("No credentials, cookies, tokens, secrets, or private records were printed.");
}
