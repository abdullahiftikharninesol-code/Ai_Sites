export type BenchmarkTier = "SMOKE" | "STANDARD" | "FULL";
export type BenchmarkScenarioId =
  "EXECUTION_PRIMITIVES" | "SITE_GENERATION" | "TARGETED_EDIT" | "FULL_PRODUCT_E2E";
export interface BenchmarkScenario {
  readonly id: BenchmarkScenarioId;
  readonly version: number;
  readonly tier: BenchmarkTier;
  readonly description: string;
  readonly prompt?: string;
  readonly expected?: Readonly<Record<string, unknown>>;
}
export interface BenchmarkProviders {
  readonly agentProvider: string;
  readonly executionProvider: string;
  readonly hostingProvider: string;
  readonly runtimeProvider: string;
  readonly authProvider: string;
  readonly artifactStore: string;
  readonly modelId?: string;
}
export interface BenchmarkMetric {
  readonly planningMs?: number;
  readonly agentTurns?: number;
  readonly toolCalls?: number;
  readonly filesWritten?: number;
  readonly filesPatched?: number;
  readonly environmentCreationMs?: number;
  readonly sourceUploadMs?: number;
  readonly cliInstallMs?: number;
  readonly npmInstallMs?: number;
  readonly buildAttempts?: number;
  readonly buildMs?: number;
  readonly repairMs?: number;
  readonly previewStartMs?: number;
  readonly httpReadyMs?: number;
  readonly renderMs?: number;
  readonly qaMs?: number;
  readonly visualRepairAttempts?: number;
  readonly finalScore?: number;
  readonly sourceSnapshotMs?: number;
  readonly sourceBytes?: number;
  readonly freshBuildMs?: number;
  readonly artifactBytes?: number;
  readonly publishMs?: number;
  readonly rollbackMs?: number;
  readonly republishMs?: number;
  readonly runtimeRequests?: number;
  readonly runtimeWrites?: number;
  readonly runtimeReads?: number;
  readonly deniedOperations?: number;
  readonly signupMs?: number;
  readonly loginMs?: number;
  readonly actionMs?: number;
  readonly cleanupMs?: number;
  readonly totalScenarioMs: number;
  readonly firstBuildSuccess?: boolean;
  readonly buildRepairCount?: number;
  readonly visualQaScore?: number;
  readonly visualRepairCount?: number;
  readonly toolCallCount?: number;
  readonly filesTouched?: number;
  readonly targetedEditMinimality?: number;
  readonly runtimeFeatureSuccess?: boolean;
  readonly securityPolicyViolations?: number;
  readonly tokenUsage?: Readonly<Record<string, number>>;
  readonly estimatedModelCostUsd?: number;
  readonly estimatedCostUsd?: number;
  readonly actualCostUsd?: number | null;
}
export interface BenchmarkSecurityCapabilities {
  readonly secureIsolation: boolean;
  readonly secretFiltering: boolean;
  readonly networkControls: boolean;
  readonly cleanupGuarantees: boolean;
  readonly ttl: boolean;
  readonly previewExposure: "LOCAL" | "SIGNED" | "PUBLIC" | "NONE";
}
export interface BenchmarkResult {
  readonly schemaVersion: 1;
  readonly scenarioId: BenchmarkScenarioId;
  readonly scenarioVersion: number;
  readonly tier: BenchmarkTier;
  readonly runId: string;
  readonly repetition: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "PASSED" | "FAILED";
  readonly providers: BenchmarkProviders;
  readonly metrics: BenchmarkMetric;
  readonly security: BenchmarkSecurityCapabilities;
  readonly reproducibility: {
    readonly nodeVersion: string;
    readonly npmVersion?: string;
    readonly os: string;
    readonly architecture: string;
    readonly gitCommit?: string;
    readonly starterVersion: string;
    readonly cliVersion: string;
    readonly technicalProfileVersion: string;
    readonly resourceProfile: string;
  };
  readonly failure?: { readonly code: string; readonly message: string };
}
