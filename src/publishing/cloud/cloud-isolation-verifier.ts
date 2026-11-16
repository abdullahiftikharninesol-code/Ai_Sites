import { PublishingError } from "../publishing-errors.js";
import type { CloudBuildConfig } from "./cloud-build-config.js";
import type { CloudIamApi, CloudRunJobsApi } from "./cloud-build-gcp.js";
import type { CloudBuildLedger } from "./cloud-build-ledger.js";
import { sha256Hex } from "./cloud-build-protocol.js";

export interface CloudIsolationStatus {
  readonly verified: boolean;
  readonly reasons: readonly string[];
  readonly configHash?: string;
  readonly checkedAt: Date;
}

const VERIFIED_CACHE_MS = 5 * 60_000;
const FAILED_CACHE_MS = 30_000;
const PUBLIC_MEMBERS = ["allUsers", "allAuthenticatedUsers"];

const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const cpuOf = (value: unknown) => {
  const amount = text(value);
  return amount.endsWith("m") ? Number(amount.slice(0, -1)) / 1_000 : Number(amount);
};
const mibOf = (value: unknown) => {
  const match = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)?$/.exec(text(value));
  if (!match) return NaN;
  const amount = Number(match[1]);
  return match[2] === "Gi" ? amount * 1_024 : match[2] === "G" ? (amount * 1e9) / 1_048_576 : match[2] === "M" ? (amount * 1e6) / 1_048_576 : match[2] === "Mi" ? amount : amount / 1_048_576;
};

/**
 * Inspects the live Cloud Run job (v1 resource) against the only shape AI
 * Sites accepts for untrusted builds. Returns the violations (empty = the
 * job is acceptable) and a hash of the verified settings.
 */
export function inspectCloudBuildJob(job: unknown, config: CloudBuildConfig): { readonly violations: string[]; readonly configHash: string } {
  const violations: string[] = [];
  const execution = record(record(record(job).spec).template);
  const executionAnnotations = record(record(execution.metadata).annotations);
  const executionSpec = record(execution.spec);
  const task = record(executionSpec.template);
  const taskSpec = record(task.spec);
  const containers = Array.isArray(taskSpec.containers) ? (taskSpec.containers as unknown[]).map(record) : [];
  const container = containers[0] ?? {};
  const limits = record(record(container.resources).limits);
  const environment = text(executionAnnotations["run.googleapis.com/execution-environment"] ?? record(record(task.metadata).annotations)["run.googleapis.com/execution-environment"]);

  if ((executionSpec.taskCount ?? 1) !== 1) violations.push("taskCount must be 1");
  if (executionSpec.parallelism !== undefined && executionSpec.parallelism !== 1 && executionSpec.parallelism !== 0) violations.push("parallelism must be 1");
  if (taskSpec.maxRetries !== 0) violations.push("maxRetries must be explicitly 0 (no automatic retries)");
  if (typeof taskSpec.timeoutSeconds !== "number" && typeof taskSpec.timeoutSeconds !== "string") violations.push("timeoutSeconds must be set");
  else if (Number(taskSpec.timeoutSeconds) > config.taskTimeoutSeconds) violations.push(`timeoutSeconds must be at most ${config.taskTimeoutSeconds}`);
  if (taskSpec.serviceAccountName !== config.workerServiceAccount) violations.push("the job must run as the dedicated worker service account");
  if (environment === "gen1") violations.push("sandboxes require the second generation execution environment");
  if (containers.length !== 1) violations.push("exactly one container is allowed (no sidecars)");
  if (container.name !== config.containerName) violations.push(`the container must be named ${config.containerName}`);
  if (container.image !== config.image) violations.push("the container image must be the pinned worker image digest");
  if (container.sandboxLauncher !== true) violations.push("the Cloud Run sandbox launcher must be enabled");
  if (Array.isArray(container.env) && container.env.length) violations.push("the job template must not define environment variables or secrets");
  if (Array.isArray(container.envFrom) && container.envFrom.length) violations.push("the job template must not import environment variables");
  if ((Array.isArray(container.volumeMounts) && container.volumeMounts.length) || (Array.isArray(taskSpec.volumes) && taskSpec.volumes.length))
    violations.push("the job must not mount volumes (secrets, buckets or NFS)");
  const cpu = cpuOf(limits.cpu);
  const memory = mibOf(limits.memory);
  if (!(cpu > 0 && cpu <= config.maxCpu)) violations.push(`a CPU limit of at most ${config.maxCpu} is required`);
  if (!(memory > 0 && memory <= config.maxMemoryMiB)) violations.push(`a memory limit of at most ${config.maxMemoryMiB}Mi is required`);
  for (const key of Object.keys(executionAnnotations))
    if (/cloudsql-instances|secrets|vpc-access-connector/.test(key)) violations.push(`annotation ${key} grants the worker extra access`);

  const configHash = sha256Hex(JSON.stringify({
    image: container.image ?? null, serviceAccount: taskSpec.serviceAccountName ?? null, sandboxLauncher: container.sandboxLauncher ?? null,
    maxRetries: taskSpec.maxRetries ?? null, timeoutSeconds: taskSpec.timeoutSeconds ?? null, cpu: limits.cpu ?? null, memory: limits.memory ?? null,
    environment, taskCount: executionSpec.taskCount ?? 1,
  }));
  return { violations, configHash };
}

/**
 * Decides whether untrusted user sites may build in the cloud. Never trusts a
 * flag or the provider's self-description: it reads the live job, the live
 * IAM policy of the worker identity, and requires a recent passing probe
 * attestation for exactly this job configuration. Fails closed on any error.
 */
export class CloudIsolationVerifier {
  #cached: CloudIsolationStatus | undefined;

  constructor(
    private readonly options: {
      readonly config: CloudBuildConfig;
      readonly jobs: Pick<CloudRunJobsApi, "getJob">;
      readonly iam: CloudIamApi;
      readonly ledger: Pick<CloudBuildLedger, "latestAttestation">;
      /** The coordinator's own identity, when known; the worker must not share it. */
      readonly coordinatorServiceAccount?: () => Promise<string | undefined>;
      readonly now?: () => Date;
    },
  ) {}

  /** The job configuration and IAM checks only (used before a probe attestation exists). */
  async inspect(): Promise<{ readonly violations: string[]; readonly configHash: string }> {
    const { config } = this.options;
    const { violations, configHash } = inspectCloudBuildJob(await this.options.jobs.getJob(), config);
    const member = `serviceAccount:${config.workerServiceAccount}`;
    const [projectRoles, bucketRoles, publicRoles, coordinator] = await Promise.all([
      this.options.iam.projectRolesOf(member),
      this.options.iam.bucketRolesOf(config.transferBucket, member),
      Promise.all(PUBLIC_MEMBERS.map((m) => this.options.iam.bucketRolesOf(config.transferBucket, m))),
      this.options.coordinatorServiceAccount?.() ?? Promise.resolve(undefined),
    ]);
    if (projectRoles.length) violations.push(`the worker identity holds project roles: ${projectRoles.slice(0, 5).join(", ")}`);
    if (bucketRoles.length) violations.push("the worker identity has access to the transfer bucket (signed URLs only)");
    if (publicRoles.some((roles) => roles.length)) violations.push("the transfer bucket is publicly accessible");
    if (coordinator && coordinator === config.workerServiceAccount) violations.push("the worker must not use the coordinator's identity");
    return { violations, configHash };
  }

  async status(): Promise<CloudIsolationStatus> {
    const now = (this.options.now ?? (() => new Date()))();
    const cached = this.#cached;
    if (cached && now.getTime() - cached.checkedAt.getTime() < (cached.verified ? VERIFIED_CACHE_MS : FAILED_CACHE_MS)) return cached;
    let status: CloudIsolationStatus;
    try {
      const { violations, configHash } = await this.inspect();
      const attestation = await this.options.ledger.latestAttestation(configHash);
      if (!attestation) violations.push("no isolation probe attestation exists for this job configuration");
      else {
        if (!attestation.passed) violations.push(`the latest isolation probe failed: ${attestation.violations.slice(0, 3).join("; ")}`);
        if (attestation.image !== this.options.config.image) violations.push("the isolation probe ran a different worker image");
        if (now.getTime() - attestation.createdAt.getTime() > this.options.config.attestationMaxAgeMs) violations.push("the isolation probe attestation has expired");
      }
      status = { verified: violations.length === 0, reasons: violations, configHash, checkedAt: now };
    } catch (error) {
      console.warn("[sites][publish] cloud isolation check failed", { name: (error as Error)?.name });
      status = { verified: false, reasons: ["the cloud build configuration could not be verified"], checkedAt: now };
    }
    if (!status.verified) console.warn(`[sites][publish] cloud builds unavailable: ${status.reasons.join("; ").slice(0, 600)}`);
    this.#cached = status;
    return status;
  }

  async assertVerified(): Promise<{ readonly configHash: string }> {
    const status = await this.status();
    if (!status.verified || !status.configHash)
      throw new PublishingError("PUBLISH_ISOLATION_UNAVAILABLE", "Isolated cloud builds aren't available right now, so this site can't be built for publishing. Nothing was built or deployed.", {
        metadata: { reasons: status.reasons.slice(0, 5) },
      });
    return { configHash: status.configHash };
  }

  /** Drops the cached decision (e.g. after a failed execution check). */
  invalidate() {
    this.#cached = undefined;
  }
}
