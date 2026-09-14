import {
  DeterministicDesignPlanner,
  DeterministicRequirementsPlanner,
  InMemoryProgressBus,
  InMemorySiteJobRepository,
  InMemorySiteProjectRepository,
  InMemorySiteVersionRepository,
  LocalArtifactStore,
  MockExecutionProvider,
  SitesOrchestrator,
  createAgentProviderRegistry,
  loadConfig,
} from "./index.js";
import type { UserId } from "./index.js";

const providerId = process.argv[2];
const keyNames: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  kimi: "KIMI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
if (!providerId || !keyNames[providerId]) {
  console.error("Choose one of: openai, anthropic, gemini, deepseek, xai, kimi, groq, openrouter");
  process.exitCode = 2;
} else if (!process.env[keyNames[providerId]]?.trim()) {
  console.error(
    `${keyNames[providerId]} is not configured. Set it explicitly before running this paid opt-in demo.`,
  );
  process.exitCode = 2;
} else {
  const env = { ...process.env, DEFAULT_AGENT_PROVIDER: providerId };
  const provider = createAgentProviderRegistry(loadConfig(env), env).get(providerId);
  const progress = new InMemoryProgressBus();
  progress.subscribe((event) => console.log(`[${event.state}] ${event.message}`));
  const started = Date.now();
  const result = await new SitesOrchestrator(
    provider,
    new MockExecutionProvider(),
    new LocalArtifactStore(),
    new InMemorySiteProjectRepository(),
    new InMemorySiteVersionRepository(),
    new InMemorySiteJobRepository(),
    new DeterministicRequirementsPlanner(),
    new DeterministicDesignPlanner(),
    progress,
  ).createSite({
    userId: `${providerId}-demo-user` as UserId,
    prompt: "Create a minimal modern business landing page and verify it builds.",
    projectName: `${providerId} Demo`,
  });
  console.log(`Provider: ${provider.id}`);
  console.log(`Model: ${result.usage.agent.model ?? provider.getCapabilities().models[0]}`);
  console.log(`Calls/tools: ${result.usage.agent.calls}/${result.usage.agent.toolCalls ?? 0}`);
  console.log(
    `Tokens (input/cached/output): ${result.usage.agent.inputTokens}/${result.usage.agent.cachedInputTokens ?? "not reported"}/${result.usage.agent.outputTokens}`,
  );
  console.log(`Retries: ${result.usage.agent.retryCount ?? 0}`);
  console.log(`Duration: ${Date.now() - started}ms`);
  console.log(`Preview: ${result.preview.url} (mock execution)`);
}
