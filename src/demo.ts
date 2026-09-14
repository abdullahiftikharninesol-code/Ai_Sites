import {
  DeterministicDesignPlanner,
  DeterministicRequirementsPlanner,
  InMemoryProgressBus,
  InMemorySiteJobRepository,
  InMemorySiteProjectRepository,
  InMemorySiteVersionRepository,
  LocalArtifactStore,
  MockAgentProvider,
  MockExecutionProvider,
  SitesOrchestrator,
} from "./index.js";
import type { UserId } from "./index.js";

const progress = new InMemoryProgressBus();
progress.subscribe((event) => console.log(`[${event.state}] ${event.message}`));
const projects = new InMemorySiteProjectRepository();
const versions = new InMemorySiteVersionRepository();
const orchestrator = new SitesOrchestrator(
  new MockAgentProvider(),
  new MockExecutionProvider(),
  new LocalArtifactStore(),
  projects,
  versions,
  new InMemorySiteJobRepository(),
  new DeterministicRequirementsPlanner(),
  new DeterministicDesignPlanner(),
  progress,
);

const userId = "demo-user" as UserId;
console.log('Prompt: "Create a modern business website"');
const created = await orchestrator.createSite({
  userId,
  prompt: "Create a modern business website",
  projectName: "Demo Site",
});
console.log(`Site ID: ${created.project.id}`);
console.log(`Version: ${created.version.versionNumber}`);
console.log(`Preview: ${created.preview.url}`);
console.log('\nEdit: "Change the heading"');
const edited = await orchestrator.editSite({
  userId,
  siteId: created.project.id,
  prompt: "Change the heading",
});
console.log(`Version: ${edited.version.versionNumber}`);
console.log(`Preview: ${edited.preview.url}`);
