import { createHash } from "node:crypto";
import type { StaticArtifactLimits } from "../static-artifact.js";

/**
 * Wire format between the trusted coordinator (AI Sites backend) and the
 * trusted worker in the Cloud Run job. Untrusted site code never reads or
 * writes these documents: it only runs inside Cloud Run sandboxes started by
 * the worker. The coordinator still treats every result as untrusted input.
 */
export const BUILD_REQUEST_SCHEMA = "ai-sites.cloud-build-request/1";
export const BUILD_RESULT_SCHEMA = "ai-sites.cloud-build-result/1";
export const PROBE_REPORT_SCHEMA = "ai-sites.cloud-build-probe/1";

export interface CloudBuildLimits {
  readonly installTimeoutMs: number;
  readonly buildTimeoutMs: number;
  readonly memoryMb: number;
  readonly output: StaticArtifactLimits;
  readonly maxDependencies: number;
  readonly maxDependencyBytes: number;
}

/** Immutable once uploaded: its SHA-256 is passed to the worker separately. */
export interface CloudBuildRequest {
  readonly schema: typeof BUILD_REQUEST_SCHEMA;
  readonly buildId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly sourceArtifactRef: string;
  readonly sourceSha256: string;
  /** The exact saved snapshot bytes (source.json), base64. */
  readonly sourceBase64: string;
  readonly limits: CloudBuildLimits;
  readonly createdAt: string;
}

/**
 * What the worker observed from inside a sandbox, before any site code ran.
 * Every field must be false/empty for the build (or attestation) to count.
 */
export interface SandboxSelfCheck {
  /** The metadata server (and so the job's credentials) answered. */
  readonly metadataReachable: boolean;
  /** Any outbound connection (public internet or the npm registry) succeeded. */
  readonly egressReachable: boolean;
  /** Names of inherited variables that look like configuration or credentials. */
  readonly inheritedEnv: readonly string[];
  /** The worker's own environment (signed URLs) was readable through /proc. */
  readonly hostEnvironReadable: boolean;
  /** The root filesystem accepted a write. */
  readonly rootWritable: boolean;
  /** Well-known credential files were present. */
  readonly credentialFilesVisible: boolean;
}

export const SELF_CHECK_KEYS: readonly (keyof SandboxSelfCheck)[] = [
  "metadataReachable", "egressReachable", "inheritedEnv", "hostEnvironReadable", "rootWritable", "credentialFilesVisible",
];

/** The reasons a self-check does not prove isolation (empty = isolated). */
export function selfCheckViolations(check: unknown): string[] {
  const value = (check ?? {}) as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of SELF_CHECK_KEYS) {
    const field = value[key];
    if (key === "inheritedEnv") {
      if (!Array.isArray(field)) violations.push("inheritedEnv:missing");
      else if (field.length) violations.push(`inheritedEnv:${field.slice(0, 5).map(String).join(",").slice(0, 120)}`);
    } else if (field !== false) violations.push(`${key}:${field === true ? "true" : "missing"}`);
  }
  return violations;
}

export type CloudBuildFailureCode =
  | "PUBLISH_SOURCE_INVALID"
  | "PUBLISH_DEPENDENCY_INSTALL_FAILED"
  | "PUBLISH_BUILD_FAILED"
  | "PUBLISH_BUILD_TIMEOUT"
  | "PUBLISH_ARTIFACT_INVALID"
  | "PUBLISH_ISOLATION_UNAVAILABLE"
  | "PUBLISH_BUILD_WORKER_FAILED";

export const WORKER_FAILURE_CODES: ReadonlySet<string> = new Set<CloudBuildFailureCode>([
  "PUBLISH_SOURCE_INVALID", "PUBLISH_DEPENDENCY_INSTALL_FAILED", "PUBLISH_BUILD_FAILED", "PUBLISH_BUILD_TIMEOUT",
  "PUBLISH_ARTIFACT_INVALID", "PUBLISH_ISOLATION_UNAVAILABLE", "PUBLISH_BUILD_WORKER_FAILED",
]);

export interface CloudBuildResultFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentBase64: string;
}

export interface CloudBuildResult {
  readonly schema: typeof BUILD_RESULT_SCHEMA;
  readonly buildId: string;
  readonly requestSha256: string;
  readonly isolation: { readonly sandbox: true; readonly checks: SandboxSelfCheck };
  readonly outcome:
    | {
        readonly status: "SUCCEEDED";
        readonly files: readonly CloudBuildResultFile[];
        readonly metrics: { readonly installMs: number; readonly buildMs: number; readonly totalMs: number; readonly dependencies: number; readonly dependencyBytes: number };
      }
    | { readonly status: "FAILED"; readonly code: CloudBuildFailureCode; readonly stage: string; readonly log?: string };
}

export interface CloudBuildProbeReport {
  readonly schema: typeof PROBE_REPORT_SCHEMA;
  readonly probeId: string;
  readonly isolation: { readonly sandbox: true; readonly checks: SandboxSelfCheck };
}

export const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Worker-side bound for one result document (base64 output plus overhead). */
export const maxResultBytes = (limits: CloudBuildLimits) => Math.ceil(limits.output.maxTotalBytes * 1.4) + 1_048_576;
