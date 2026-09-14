import {
  DeterministicDesignPlanner,
  DeterministicRequirementsPlanner,
  InMemoryProgressBus,
  InMemorySiteJobRepository,
  InMemorySiteProjectRepository,
  InMemorySiteVersionRepository,
  LocalArtifactStore,
  MockExecutionProvider,
  OpenAIAgentProvider,
  SitesOrchestrator,
  loadOpenAIAgentConfig,
} from "./index.js";
import type { UserId } from "./index.js";

if (!process.env.OPENAI_API_KEY?.trim()) {
  console.error(
    "OPENAI_API_KEY is not configured. Set it in your environment, optionally set OPENAI_AGENT_MODEL, then run npm run demo:openai.",
  );
  process.exitCode = 2;
} else {
  const config = loadOpenAIAgentConfig();
  const progress = new InMemoryProgressBus();
  progress.subscribe((event) => console.log(`[${event.state}] ${event.message}`));
  const startedAt = Date.now();
  const result = await new SitesOrchestrator(
    new OpenAIAgentProvider(config),
    new MockExecutionProvider(),
    new LocalArtifactStore(),
    new InMemorySiteProjectRepository(),
    new InMemorySiteVersionRepository(),
    new InMemorySiteJobRepository(),
    new DeterministicRequirementsPlanner(),
    new DeterministicDesignPlanner(),
    progress,
  ).createSite({
    userId: "openai-demo-user" as UserId,
    prompt: "Create a minimal modern business landing page and verify it builds.",
    projectName: "OpenAI Demo",
  });
  console.log(`Model: ${result.usage.agent.model ?? config.model}`);
  console.log(`AI calls: ${result.usage.agent.calls}`);
  console.log(`Tool calls: ${result.usage.agent.toolCalls ?? 0}`);
  console.log(`Input tokens: ${result.usage.agent.inputTokens}`);
  console.log(`Cached input tokens: ${result.usage.agent.cachedInputTokens}`);
  console.log(`Output tokens: ${result.usage.agent.outputTokens}`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);
  console.log(`Version ID: ${result.version.id}`);
  console.log(`Preview URL: ${result.preview.url} (simulated)`);
}
