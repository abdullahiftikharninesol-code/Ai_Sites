import type { SiteId } from "../shared/types.js";
import type {
  RuntimeListOptions,
  RuntimeListResult,
  RuntimeStorageMetrics,
  RuntimeUsageMetrics,
  SiteRuntime,
  SiteRuntimeRecord,
  SiteRuntimeSpec,
} from "./runtime-types.js";
export interface SiteRuntimeProvider {
  readonly id: string;
  provisionRuntime(siteId: SiteId, spec: SiteRuntimeSpec): Promise<SiteRuntime>;
  getRuntime(siteId: SiteId): Promise<SiteRuntime | undefined>;
  deleteRuntime(siteId: SiteId): Promise<void>;
  applySchema(siteId: SiteId, expectedVersion: number, spec: SiteRuntimeSpec): Promise<SiteRuntime>;
  createRecord(
    siteId: SiteId,
    collection: string,
    data: unknown,
    ownerUserId?: string,
  ): Promise<SiteRuntimeRecord>;
  getRecord(siteId: SiteId, collection: string, id: string): Promise<SiteRuntimeRecord | undefined>;
  listRecords(
    siteId: SiteId,
    collection: string,
    options?: RuntimeListOptions,
  ): Promise<RuntimeListResult>;
  updateRecord(
    siteId: SiteId,
    collection: string,
    id: string,
    data: unknown,
  ): Promise<SiteRuntimeRecord>;
  deleteRecord(siteId: SiteId, collection: string, id: string): Promise<void>;
  storageMetrics(siteId: SiteId): Promise<RuntimeStorageMetrics>;
  usageMetrics(siteId: SiteId): RuntimeUsageMetrics;
  close(): void;
}
