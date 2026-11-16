/**
 * Isolated cloud build configuration (Stage 5A). Disabled by default:
 * SITES_PUBLISH_BUILD_PROVIDER=local keeps Stage 2 behavior (trusted sites
 * only). "cloud" selects Cloud Run jobs with Cloud Run sandboxes, and is only
 * usable after this configuration is complete AND the isolation verifier has
 * checked the live job, IAM and a probe attestation. An incomplete
 * configuration never falls back to building on this host.
 */
export type PublishBuildProvider = "local" | "cloud";

export interface CloudBuildConfig {
  readonly projectId: string;
  readonly region: string;
  readonly jobName: string;
  readonly containerName: string;
  /** The worker image the job must run, pinned by digest (…@sha256:<64 hex>). */
  readonly image: string;
  /** The job's service identity; it must hold no IAM roles. */
  readonly workerServiceAccount: string;
  /** Dedicated bucket for per-build transfer objects only (never canonical data). */
  readonly transferBucket: string;
  readonly taskTimeoutSeconds: number;
  readonly maxCpu: number;
  readonly maxMemoryMiB: number;
  readonly dailyBuildsPerOwner: number;
  readonly attestationMaxAgeMs: number;
  readonly pollIntervalMs: number;
}

export type CloudBuildConfigResult =
  | { readonly ok: true; readonly config: CloudBuildConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+\d$/;
const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DIGEST_IMAGE = /^[a-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

export function loadPublishBuildProvider(env: NodeJS.ProcessEnv = process.env): PublishBuildProvider {
  return env.SITES_PUBLISH_BUILD_PROVIDER?.trim() === "cloud" ? "cloud" : "local";
}

const bounded = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const value = Number(env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
};

export function loadCloudBuildConfig(env: NodeJS.ProcessEnv = process.env): CloudBuildConfigResult {
  const read = (name: string) => env[name]?.trim() ?? "";
  const problems: string[] = [];
  const require = (name: string, pattern: RegExp, label: string) => {
    const value = read(name);
    if (!pattern.test(value)) problems.push(`${name} must be ${label}`);
    return value;
  };
  const projectId = require("SITES_CLOUD_BUILD_PROJECT_ID", PROJECT, "a Google Cloud project ID");
  const region = require("SITES_CLOUD_BUILD_REGION", REGION, "a Cloud Run region");
  const jobName = require("SITES_CLOUD_BUILD_JOB", NAME, "a Cloud Run job name");
  const containerName = read("SITES_CLOUD_BUILD_CONTAINER") || "worker";
  if (!NAME.test(containerName)) problems.push("SITES_CLOUD_BUILD_CONTAINER must be a container name");
  const image = require("SITES_CLOUD_BUILD_IMAGE", DIGEST_IMAGE, "an image pinned by @sha256 digest");
  const workerServiceAccount = require("SITES_CLOUD_BUILD_WORKER_SERVICE_ACCOUNT", SERVICE_ACCOUNT, "a service account email");
  const transferBucket = require("SITES_CLOUD_BUILD_TRANSFER_BUCKET", BUCKET, "a dedicated bucket name");
  if (transferBucket && transferBucket === read("SITES_TEMPLATE_GCS_BUCKET"))
    problems.push("SITES_CLOUD_BUILD_TRANSFER_BUCKET must be a dedicated bucket, not the template bucket");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      projectId, region, jobName, containerName, image, workerServiceAccount, transferBucket,
      taskTimeoutSeconds: bounded(env, "SITES_CLOUD_BUILD_TIMEOUT_SECONDS", 900, 120, 1_800),
      maxCpu: bounded(env, "SITES_CLOUD_BUILD_MAX_CPU", 2, 1, 4),
      maxMemoryMiB: bounded(env, "SITES_CLOUD_BUILD_MAX_MEMORY_MIB", 4_096, 1_024, 8_192),
      dailyBuildsPerOwner: bounded(env, "SITES_CLOUD_BUILD_DAILY_LIMIT_PER_OWNER", 20, 1, 500),
      attestationMaxAgeMs: bounded(env, "SITES_CLOUD_BUILD_ATTESTATION_MAX_AGE_HOURS", 168, 1, 720) * 3_600_000,
      pollIntervalMs: bounded(env, "SITES_CLOUD_BUILD_POLL_INTERVAL_MS", 5_000, 1_000, 60_000),
    },
  };
}
