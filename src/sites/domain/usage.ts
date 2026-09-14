export interface AgentUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens: number;
  readonly providerId?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly toolCalls?: number;
  readonly reasoningTokens?: number;
  readonly retryCount?: number;
}
export interface ExecutionUsage {
  readonly providerId: string;
  readonly seconds: number;
  readonly cpuSeconds?: number;
  readonly memoryMbSeconds?: number;
}
export interface SiteUsageRecord {
  readonly siteId: string;
  readonly jobId?: string;
  readonly agent: AgentUsage;
  readonly execution?: ExecutionUsage;
  readonly builds: number;
  readonly previewSeconds: number;
  readonly visualQaCalls: number;
  readonly imageGenerations: number;
  readonly estimatedProviderCostMicros?: number;
  readonly recordedAt: Date;
}
export interface HostingQuota {
  readonly maxProjects: number;
  readonly maxPublishedSites: number;
  readonly storageBytes: number;
  readonly monthlyBandwidthBytes: number;
  readonly customDomains: number;
  readonly maxConcurrentJobs: number;
}
export function totalTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.outputTokens;
}
