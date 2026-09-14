import type { SiteId } from "../shared/types.js";

export const RUNTIME_FIELD_TYPES = [
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "email",
  "url",
] as const;
export type RuntimeFieldType = (typeof RUNTIME_FIELD_TYPES)[number];
export type RuntimeOperation = "create" | "read" | "update" | "delete";
export interface SiteDataAccessPolicy {
  readonly public?: Partial<Record<RuntimeOperation, boolean>>;
  readonly authenticated?: Partial<Record<RuntimeOperation, boolean>>;
  readonly owner?: Partial<Record<RuntimeOperation, boolean>>;
}
export interface SiteRuntimeFieldSpec {
  readonly name: string;
  readonly type: RuntimeFieldType;
  readonly required?: boolean;
  readonly defaultValue?: string | number | boolean;
  readonly maxLength?: number;
}
export interface SiteRuntimeCollectionSpec {
  readonly name: string;
  readonly fields: readonly SiteRuntimeFieldSpec[];
  readonly access?: SiteDataAccessPolicy;
}
export interface SiteRuntimeSpec {
  readonly enabled: boolean;
  readonly collections: readonly SiteRuntimeCollectionSpec[];
}
export interface SiteRuntime {
  readonly id: string;
  readonly siteId: SiteId;
  readonly status: "ACTIVE" | "DISABLED" | "DELETED";
  readonly provider: string;
  readonly schemaVersion: number;
  readonly spec: SiteRuntimeSpec;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface SiteRuntimeRecord {
  readonly id: string;
  readonly ownerUserId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}
export interface RuntimeListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
  readonly orderBy?: string;
  readonly direction?: "asc" | "desc";
  /** Trusted server-side ownership constraint; never accepted from browser query input. */
  readonly ownerUserId?: string;
}
export interface RuntimeListResult {
  readonly items: readonly SiteRuntimeRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}
export interface RuntimeStorageMetrics {
  readonly collections: number;
  readonly records: number;
  readonly bytes: number;
}
export interface RuntimeUsageMetrics {
  readonly reads: number;
  readonly creates: number;
  readonly updates: number;
  readonly deletes: number;
  readonly denied: number;
  readonly validationFailures: number;
}
