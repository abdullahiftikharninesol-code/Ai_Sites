import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { DaytonaExecutionProvider } from "./execution/daytona/daytona-execution.provider.js";
import { loadDaytonaConfig } from "./execution/daytona/daytona-config.js";
import { CliBundleInstaller, loadBuiltSitesCliBundle } from "./cli/runtime/sites-cli-bundle.js";

async function uploadTree(
  provider: DaytonaExecutionProvider,
  environmentId: string,
  root: string,
  directory = root,
): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) bytes += await uploadTree(provider, environmentId, root, absolute);
    else {
      const content = await readFile(absolute, "utf8");
      await provider.writeFile(
        environmentId,
        relative(root, absolute).split(sep).join("/"),
        content,
      );
      bytes += Buffer.byteLength(content);
    }
  }
  return bytes;
}

async function main(): Promise<void> {
  const provider = new DaytonaExecutionProvider(loadDaytonaConfig());
  const environment = await provider.createEnvironment({});
  const started = Date.now();
  console.log(`Daytona environment: ${environment.id}`);
  try {
    const cli = await new CliBundleInstaller(provider).install(
      environment.id,
      await loadBuiltSitesCliBundle(),
    );
    console.log(`Sites CLI ${cli.cliVersion}: verified (${cli.installMs}ms)`);
    const bytes = await uploadTree(
      provider,
      environment.id,
      resolve("tests/fixtures/react-vite-site"),
    );
    console.log(`Project uploaded: ${bytes} bytes`);
    const install = await provider.executeCommand(environment.id, {
      executable: "npm",
      args: ["ci"],
      timeoutMs: 240_000,
    });
    if (install.exitCode !== 0)
      throw new Error(`npm ci failed: ${install.stderr || install.stdout}`);
    const first = await provider.executeCommand(environment.id, {
      executable: "npm",
      args: ["run", "build"],
    });
    if (first.exitCode !== 0)
      throw new Error(`initial build failed: ${first.stderr || first.stdout}`);
    const app = await provider.readFile(environment.id, "src/App.tsx");
    await provider.writeFile(
      environment.id,
      "src/App.tsx",
      `import './missing-phase-10-module';\n${app}`,
    );
    const failed = await provider.executeCommand(environment.id, {
      executable: "npm",
      args: ["run", "build"],
    });
    if (failed.exitCode === 0) throw new Error("intentional failure unexpectedly passed");
    console.log(`Intentional compiler failure captured (exit ${failed.exitCode})`);
    await provider.writeFile(environment.id, "src/App.tsx", app);
    const repaired = await provider.executeCommand(environment.id, {
      executable: "npm",
      args: ["run", "build"],
    });
    if (repaired.exitCode !== 0)
      throw new Error(`repair build failed: ${repaired.stderr || repaired.stdout}`);
    const preview = await provider.startPreview(environment.id, { port: 4173 });
    const response = await fetch(preview.url as string);
    if (!response.ok) throw new Error(`preview HTTP ${response.status}`);
    console.log(`Remote preview ready: ${preview.url}`);
    console.log(`Logs: ${(await provider.readLogs(environment.id)).slice(-3).join(" | ")}`);
    console.log(`Telemetry: ${JSON.stringify(provider.getUsageMetrics(environment.id))}`);
  } finally {
    await provider.destroyEnvironment(environment.id);
    console.log(`Sandbox cleaned (${Date.now() - started}ms total)`);
  }
}
await main();
