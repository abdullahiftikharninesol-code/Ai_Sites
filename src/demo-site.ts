import { resolve } from "node:path";
import { createAgentProviderRegistry } from "./agents/registry/create-agent-provider-registry.js";
import { loadConfig } from "./app/config/environment.js";
import { createLocalSitesProduct } from "./sites/generation/create-local-sites-product.js";
import type { UserId } from "./shared/types.js";

const selected = process.argv[2] ?? "mock";
const prompt =
  process.argv.slice(3).join(" ") ||
  "Create a modern software product website with Home, Features and Contact sections.";
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
    `${paidKeys[selected] ?? "Provider"} is not configured. No Mock fallback was used.`,
  );
  process.exitCode = 2;
} else {
  const registry =
    selected === "mock"
      ? undefined
      : createAgentProviderRegistry(
          loadConfig({ ...process.env, DEFAULT_AGENT_PROVIDER: selected }),
          { ...process.env, DEFAULT_AGENT_PROVIDER: selected },
        );
  const product = createLocalSitesProduct({
    executionRoot: resolve(".sites-runtime/site-demo"),
    artifactRoot: resolve(".local-data/site-demo/artifacts"),
    ...(registry ? { agentRegistry: registry, orchestrationAgent: registry.get(selected) } : {}),
  });
  console.log(`Prompt: ${prompt}`);
  console.log(`AgentProvider: ${selected}; ExecutionProvider: local`);
  const generated = await product.orchestrator.generateWebsite({
    userId: "local-demo-user" as UserId,
    prompt,
    projectName: "Local AI Site",
    planningMode: selected === "mock" ? "deterministic" : "agent",
    agentProvider: selected,
  });
  console.log(`Site ID: ${generated.siteId}`);
  console.log(
    `SiteSpec: ${generated.siteSpec.requirements.siteType}; ${generated.siteSpec.requirements.pages.length} page(s); ${generated.technicalProfile.id}`,
  );
  console.log(`Version 1: ${generated.versionId}; build ${generated.build.durationMs}ms`);
  console.log(`V1 changed files: ${generated.changedFiles.summary.join(", ")}`);
  console.log(`Generation usage: ${JSON.stringify(generated.usage)}`);
  console.log(
    `Original generation environment cleaned: ${product.execution.getActiveEnvironmentCount() === 0}`,
  );

  const restored = await product.pipeline.restoreVersion(generated.versionId);
  const restoredPreview = await product.execution.startPreview(restored.environmentId, { port: 0 });
  console.log(`Fresh V1 restore build: ${restored.build.success}`);
  console.log(`Preview URL while active: ${restoredPreview.url}`);
  await product.pipeline.disposeRestoredEnvironment(restored.environmentId);

  const edited = await product.orchestrator.editWebsite({
    userId: "local-demo-user" as UserId,
    siteId: generated.siteId,
    versionId: generated.versionId,
    instruction: "Change the hero heading while preserving the rest of the site.",
    agentProvider: selected,
  });
  console.log(`Version 2: ${edited.newVersionId}; parent ${edited.fromVersionId}`);
  console.log(`V2 changed files: ${edited.changedFiles.summary.join(", ")}`);
  console.log(`V2 build: ${edited.build.success}; ${edited.build.durationMs}ms`);
  console.log(`Edit usage: ${JSON.stringify(edited.usage)}`);
  console.log(`Cleanup complete: ${product.execution.getActiveEnvironmentCount() === 0}`);
  console.log(`Source artifacts retained under: ${resolve(".local-data/site-demo/artifacts")}`);
}
