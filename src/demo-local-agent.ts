import { resolve } from "node:path";
import {
  AgentProviderRegistry,
  InMemorySiteVersionRepository,
  InProcessAgentGateway,
  LocalCliAgentRuntime,
  LocalExecutionProvider,
  MockAgentProvider,
  bootstrapLocalProject,
  createAgentProviderRegistry,
  loadConfig,
  loadLocalExecutionConfig,
} from "./index.js";
import type { SiteId, SiteVersion, VersionId } from "./index.js";
const selected = process.argv[2] ?? "mock";
const paidKeys: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  kimi: "KIMI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
if (selected !== "mock" && (!paidKeys[selected] || !process.env[paidKeys[selected]]?.trim())) {
  console.error(
    `${paidKeys[selected] ?? "Provider"} is not configured. This command never falls back to Mock.`,
  );
  process.exitCode = 2;
} else {
  const execution = new LocalExecutionProvider(loadLocalExecutionConfig());
  const environment = await execution.createEnvironment({});
  const registry: AgentProviderRegistry =
    selected === "mock"
      ? new AgentProviderRegistry()
      : createAgentProviderRegistry(
          loadConfig({ ...process.env, DEFAULT_AGENT_PROVIDER: selected }),
          { ...process.env, DEFAULT_AGENT_PROVIDER: selected },
        );
  if (selected === "mock") registry.register(new MockAgentProvider({ localCliScenario: true }));
  const runtime = new LocalCliAgentRuntime(
    new InProcessAgentGateway(registry),
    registry,
    execution,
    (state, message) => console.log(`[${state}] ${message}`),
  );
  const versions = new InMemorySiteVersionRepository();
  const siteId = "demo-local-agent-site" as SiteId;
  console.log(`AgentProvider: ${selected}`);
  console.log("Runtime: LOCAL_CLI");
  console.log(`Workspace: ${execution.getWorkspacePath(environment.id)}`);
  try {
    await bootstrapLocalProject(
      execution,
      environment.id,
      resolve("tests/fixtures/react-vite-site"),
    );
    const install = await execution.executeCommand(environment.id, {
      executable: "npm",
      args: ["ci"],
      timeoutMs: 180_000,
    });
    if (install.exitCode !== 0) throw new Error(install.stderr);
    const generated = await runtime.run(environment.id, {
      jobId: "demo-generate",
      siteId,
      operation: "GENERATE_SITE",
      runtime: "LOCAL_CLI",
      agentProvider: selected,
      userRequest:
        "Create a focused React landing page, build it, repair errors, and start preview.",
      limits: { maxAgentTurns: 12, maxToolCalls: 30, maxBuildRepairs: 3 },
    });
    if (!generated.success) throw new Error("Generation session did not finish successfully");
    const v1: SiteVersion = {
      id: "demo-version-1" as VersionId,
      siteId,
      versionNumber: 1,
      sourceArtifactRef: "demo/v1",
      buildStatus: "SUCCEEDED",
      createdAt: new Date(),
    };
    await versions.save(v1);
    console.log(`Generation report: ${JSON.stringify(generated)}`);
    console.log(
      `Preview V1 verified: ${(await (await fetch(`${generated.previewUrl!}/src/App.tsx`)).text()).includes(selected === "mock" ? "AI Sites Generated Hero" : "App")}`,
    );
    const edited = await runtime.run(environment.id, {
      jobId: "demo-edit",
      siteId,
      operation: "EDIT_SITE",
      runtime: "LOCAL_CLI",
      agentProvider: selected,
      userRequest: "Change the hero heading to AI Sites Updated Hero, rebuild, and preview.",
      limits: { maxAgentTurns: 10, maxToolCalls: 20, maxBuildRepairs: 2 },
    });
    if (!edited.success) throw new Error("Edit session did not finish successfully");
    await versions.save({
      id: "demo-version-2" as VersionId,
      siteId,
      versionNumber: 2,
      parentVersionId: v1.id,
      sourceArtifactRef: "demo/v2",
      buildStatus: "SUCCEEDED",
      createdAt: new Date(),
    });
    console.log(`Edit report: ${JSON.stringify(edited)}`);
    console.log(
      `Versions: ${(await versions.listBySite(siteId)).items.map((version) => version.versionNumber).join(" → ")}`,
    );
    console.log(
      `Updated preview verified: ${(await (await fetch(`${edited.previewUrl!}/src/App.tsx`)).text()).includes("AI Sites Updated Hero")}`,
    );
  } finally {
    await execution.destroyEnvironment(environment.id);
    console.log("Cleanup: success");
  }
}
