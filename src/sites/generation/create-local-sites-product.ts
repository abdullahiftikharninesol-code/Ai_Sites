import { resolve } from "node:path";
import { AgentProviderRegistry } from "../../agents/registry/agent-provider-registry.js";
import type { AgentProvider } from "../../agents/agent-provider.js";
import { MockAgentProvider } from "../../agents/mock-agent-provider.js";
import { InProcessAgentGateway } from "../../agents/gateway/in-process-agent-gateway.js";
import { LocalCliAgentRuntime } from "../../cli/runtime/local-cli-agent-runtime.js";
import { SITE_V1_TECHNICAL_PROFILE } from "../../cli/runtime/site-technical-profile.js";
import { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import { LocalArtifactStore } from "../../persistence/local-artifact-store.js";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import type {
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../../persistence/repositories.js";
import type { SiteVersionCommitter } from "../../persistence/version-committer.js";
import {
  InMemorySiteJobRepository,
  InMemorySiteProjectRepository,
  InMemorySiteVersionRepository,
} from "../../persistence/in-memory-repositories.js";
import {
  AgentDesignPlanner,
  AgentRequirementsPlanner,
  DeterministicDesignPlanner,
  DeterministicRequirementsPlanner,
} from "../../planning/planning.js";
import { InMemoryProgressBus } from "../application/progress.js";
import { SitesOrchestrator } from "../application/sites-orchestrator.js";
import { LocalSiteGenerationPipeline } from "./local-site-generation-pipeline.js";
import { StarterTemplateRegistry } from "./starter-template-registry.js";
import { BrowserQARunner } from "../../browser-qa/browser-qa-runner.js";
import type { SiteRuntimeProvider } from "../../site-runtime/site-runtime-provider.js";
import { AgentPlanningPipeline } from "../../agents/intelligence/agent-intelligence.js";
import { ArtifactMediaStore } from "../assets/media-store.js";
import { AdapterBackedAssetResolver, PlaceholderAssetSourceAdapter } from "../assets/source-adapters.js";
import { CarFallbackAssetSourceAdapter } from "../assets/source-adapters.js";
import { readFileSync } from "node:fs";
export interface LocalSitesProductOptions {
  readonly executionRoot: string;
  readonly artifactRoot: string;
  readonly templateRoot?: string;
  readonly keepWorkspace?: boolean;
  readonly agentRegistry?: AgentProviderRegistry;
  readonly orchestrationAgent?: AgentProvider;
  readonly browserQAEnabled?: boolean;
  readonly localCliScenario?: boolean;
  readonly artifacts?: ArtifactStore;
  readonly projects?: SiteProjectRepository;
  readonly versions?: SiteVersionRepository;
  readonly jobs?: SiteJobRepository;
  readonly versionCommitter?: SiteVersionCommitter;
  readonly runtimeProvider?: SiteRuntimeProvider;
}
export function createLocalSitesProduct(options: LocalSitesProductOptions) {
  const execution = new LocalExecutionProvider({
    rootDirectory: options.executionRoot,
    keepWorkspace: options.keepWorkspace ?? false,
    previewHost: "127.0.0.1",
    previewStartTimeoutMs: 20_000,
    commandTimeoutMs: 180_000,
    maxLogBytes: 128_000,
  });
  const artifacts = options.artifacts ?? new LocalArtifactStore(options.artifactRoot);
  const projects = options.projects ?? new InMemorySiteProjectRepository();
  const versions = options.versions ?? new InMemorySiteVersionRepository();
  const jobs = options.jobs ?? new InMemorySiteJobRepository();
  const progress = new InMemoryProgressBus();
  const requirements = new DeterministicRequirementsPlanner();
  const design = new DeterministicDesignPlanner();
  const registry = options.agentRegistry ?? new AgentProviderRegistry();
  const mockAgent = new MockAgentProvider({
    localCliScenario: options.localCliScenario ?? false,
  });
  if (!options.agentRegistry) registry.register(mockAgent);
  const gateway = new InProcessAgentGateway(registry);
  const runtime = new LocalCliAgentRuntime(gateway, registry, execution);
  const orchestrationAgent = options.orchestrationAgent ?? mockAgent;
  const templates = new StarterTemplateRegistry();
  const template = {
    templateId: "react-vite-v1",
    templateVersion: 1,
    profileId: SITE_V1_TECHNICAL_PROFILE.id,
    profileVersion: SITE_V1_TECHNICAL_PROFILE.version,
    sourceDirectory: options.templateRoot ?? resolve("tests/fixtures/react-vite-site"),
  };
  templates.register(template);
  const browserQA = new BrowserQARunner({ artifacts });
  const mediaStore = new ArtifactMediaStore(artifacts);
  const pipeline = new LocalSiteGenerationPipeline({
    execution,
    runtime,
    artifacts,
    projects,
    versions,
    jobs,
    requirements,
    design,
    intelligencePlanning: new AgentPlanningPipeline(orchestrationAgent, {
      mode: "AGENT_WITH_FALLBACK",
      strategy: "COMBINED",
    }),
    assetResolver: new AdapterBackedAssetResolver(mediaStore, [
      new CarFallbackAssetSourceAdapter(readFileSync(new URL("../assets/default-car-fallback.png", import.meta.url))),
      new PlaceholderAssetSourceAdapter(),
    ]),
    assetMediaStore: mediaStore,
    ...(options.agentRegistry && options.orchestrationAgent
      ? {
          agentRequirements: new AgentRequirementsPlanner(gateway, options.orchestrationAgent.id),
          agentDesign: new AgentDesignPlanner(gateway, options.orchestrationAgent.id),
        }
      : {}),
    progress,
    templates,
    template,
    browserQA,
    ...(options.versionCommitter ? { versionCommitter: options.versionCommitter } : {}),
    ...(options.runtimeProvider ? { runtimeProvider: options.runtimeProvider } : {}),
  });
  const orchestrator = new SitesOrchestrator(
    orchestrationAgent,
    execution,
    artifacts,
    projects,
    versions,
    jobs,
    requirements,
    design,
    progress,
    { localGenerationPipeline: pipeline },
  );
  return {
    orchestrator,
    pipeline,
    execution,
    artifacts,
    projects,
    versions,
    jobs,
    progress,
    technicalProfile: SITE_V1_TECHNICAL_PROFILE,
    template,
    browserQA,
  };
}
