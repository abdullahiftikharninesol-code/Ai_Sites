import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { LocalExecutionProvider, loadLocalExecutionConfig, runSitesCli } from "./index.js";
const provider = new LocalExecutionProvider(loadLocalExecutionConfig());
const environment = await provider.createEnvironment({});
const workspace = provider.getWorkspacePath(environment.id);
const fixture = resolve("tests/fixtures/react-vite-site");
console.log("Provider: local");
console.log(`Workspace: ${workspace}`);
let cleanup = false;
try {
  await copy(fixture, fixture);
  console.log(
    `Environment created: ${provider.getUsageMetrics(environment.id).environmentCreationMs}ms`,
  );
  console.log(`Files copied: ${provider.getUsageMetrics(environment.id).filesWritten}`);
  const install = await provider.executeCommand(environment.id, {
    executable: "npm",
    args: ["ci"],
    timeoutMs: 180_000,
  });
  if (install.exitCode !== 0) throw new Error(install.stderr);
  console.log(`npm ci: ${install.durationMs}ms`);
  const build = await provider.executeCommand(environment.id, {
    executable: "npm",
    args: ["run", "build"],
  });
  if (build.exitCode !== 0) throw new Error(build.stderr);
  console.log(
    `Build: ${build.durationMs}ms; dist/index.html: ${await provider.fileExists(environment.id, "dist/index.html")}`,
  );
  const preview = await provider.startPreview(environment.id, { port: 0 });
  const html = await (await fetch(`${preview.url!}/src/App.tsx`)).text();
  console.log(
    `Preview: ${preview.url}; ready: ${preview.httpReadyMs}ms; HTTP verified: ${html.includes("AI Sites Local Execution Test")}`,
  );
  await provider.writeFile(
    environment.id,
    "task.json",
    JSON.stringify({
      jobId: "demo-job",
      siteId: "demo-site",
      operation: "REPLACE_TEXT",
      userRequest: "Change title",
      target: {
        path: "src/App.tsx",
        find: "AI Sites Local Execution Test",
        replace: "AI Sites CLI Test",
      },
    }),
  );
  const exit = await runSitesCli(["apply-task", "task.json", "--workspace", workspace, "--json"]);
  if (exit !== 0) throw new Error("CLI edit failed");
  const rebuild = await provider.executeCommand(environment.id, {
    executable: "npm",
    args: ["run", "build"],
  });
  if (rebuild.exitCode !== 0) throw new Error(rebuild.stderr);
  const updated = await (await fetch(`${preview.url!}/src/App.tsx`)).text();
  console.log(
    `CLI edit: success; updated preview verified: ${updated.includes("AI Sites CLI Test")}`,
  );
  console.log(`Metrics: ${JSON.stringify(provider.getUsageMetrics(environment.id))}`);
} finally {
  await provider.destroyEnvironment(environment.id);
  cleanup = true;
  console.log(
    `Cleanup: ${cleanup ? "success" : "failed"}${provider.config.keepWorkspace ? ` (workspace kept: ${workspace})` : ""}`,
  );
}
async function copy(root: string, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await copy(root, full);
    else
      await provider.writeFile(
        environment.id,
        relative(root, full).replaceAll("\\", "/"),
        await readFile(full, "utf8"),
      );
  }
}
