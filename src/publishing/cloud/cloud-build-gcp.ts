import { Storage } from "@google-cloud/storage";
import type { CloudBuildConfig } from "./cloud-build-config.js";

/**
 * Narrow Google Cloud adapters used by the coordinator. Everything here runs
 * with the coordinator's own identity (Application Default Credentials); the
 * worker job never receives these credentials. Nothing here creates, updates
 * or deletes cloud resources other than per-build transfer objects and job
 * executions (run / cancel).
 */

export type CloudExecutionState = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface CloudExecutionStatus {
  readonly executionId: string;
  readonly state: CloudExecutionState;
  /** As recorded on the execution itself (v1 resource), not the job template. */
  readonly sandboxLauncher: boolean;
  readonly image: string | undefined;
  readonly serviceAccount: string | undefined;
}

export interface CloudRunJobsApi {
  /** The job as a v1 (YAML-shaped) resource; the isolation verifier inspects it. */
  getJob(): Promise<unknown>;
  runJob(input: { readonly env: readonly { readonly name: string; readonly value: string }[]; readonly args: readonly string[]; readonly timeoutSeconds: number }): Promise<{ readonly executionId: string }>;
  getExecution(executionId: string): Promise<CloudExecutionStatus>;
  cancelExecution(executionId: string): Promise<void>;
}

export interface CloudIamApi {
  /** Roles granted to `member` directly on the project (inherited org/folder grants are not visible here). */
  projectRolesOf(member: string): Promise<readonly string[]>;
  bucketRolesOf(bucket: string, member: string): Promise<readonly string[]>;
}

export interface TransferStore {
  /** Creates the object only if absent (immutable request). */
  putObject(object: string, bytes: Uint8Array, contentType: string): Promise<void>;
  signedReadUrl(object: string, expiresAt: Date): Promise<string>;
  /** A PUT URL for exactly this object, JSON only, at most maxBytes. */
  signedWriteUrl(object: string, maxBytes: number, expiresAt: Date): Promise<string>;
  /** Undefined when absent; throws when larger than maxBytes (never buffered). */
  readObject(object: string, maxBytes: number): Promise<Uint8Array | undefined>;
}

export class CloudTransferTooLargeError extends Error {}

const RUN_V2 = "https://run.googleapis.com/v2";
const EXECUTION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Reads `spec.template.spec.containers[]` of a v1 execution or job template. */
const containersOf = (template: unknown) =>
  (((template as { spec?: { containers?: unknown } } | undefined)?.spec?.containers as Record<string, unknown>[] | undefined) ?? []);

export function parseV1Execution(executionId: string, body: unknown): CloudExecutionStatus {
  const value = (body ?? {}) as { spec?: { template?: unknown }; status?: Record<string, unknown> };
  const status = value.status ?? {};
  const count = (key: string) => {
    const value = status[key];
    return typeof value === "number" ? value : 0;
  };
  const done = typeof status.completionTime === "string" && !!status.completionTime;
  const state: CloudExecutionState = !done
    ? "RUNNING"
    : count("succeededCount") >= 1 && count("failedCount") === 0
      ? "SUCCEEDED"
      : count("cancelledCount") > 0
        ? "CANCELLED"
        : "FAILED";
  const template = value.spec?.template as { spec?: { serviceAccountName?: unknown } } | undefined;
  const containers = containersOf(template);
  return {
    executionId,
    state,
    sandboxLauncher: containers.length > 0 && containers.every((c) => c.sandboxLauncher === true),
    image: typeof containers[0]?.image === "string" ? containers[0].image : undefined,
    serviceAccount: typeof template?.spec?.serviceAccountName === "string" ? template.spec.serviceAccountName : undefined,
  };
}

type Requester = (input: { url: string; method?: "GET" | "POST"; data?: unknown }) => Promise<{ data: unknown }>;

export function createGoogleCloudBuildApis(config: CloudBuildConfig, storage = new Storage()) {
  const request: Requester = (input) =>
    storage.authClient.request({ url: input.url, method: input.method ?? "GET", ...(input.data === undefined ? {} : { data: input.data }), timeout: 30_000 });
  const v1 = `https://${config.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.projectId}`;
  const jobPath = `projects/${config.projectId}/locations/${config.region}/jobs/${config.jobName}`;

  const jobs: CloudRunJobsApi = {
    async getJob() {
      return (await request({ url: `${v1}/jobs/${config.jobName}` })).data;
    },
    async runJob(input) {
      const operation = (await request({
        url: `${RUN_V2}/${jobPath}:run`,
        method: "POST",
        data: {
          overrides: {
            containerOverrides: [{ name: config.containerName, env: input.env, args: input.args, clearArgs: input.args.length === 0 }],
            taskCount: 1,
            timeout: `${input.timeoutSeconds}s`,
          },
        },
      })).data as { metadata?: { name?: unknown } };
      const name = typeof operation.metadata?.name === "string" ? operation.metadata.name : "";
      const executionId = name.split("/").at(-1) ?? "";
      if (!EXECUTION_ID.test(executionId)) throw new Error("Cloud Run did not report the execution it started");
      return { executionId };
    },
    async getExecution(executionId) {
      if (!EXECUTION_ID.test(executionId)) throw new Error("Invalid execution ID");
      return parseV1Execution(executionId, (await request({ url: `${v1}/executions/${executionId}` })).data);
    },
    async cancelExecution(executionId) {
      if (!EXECUTION_ID.test(executionId)) throw new Error("Invalid execution ID");
      await request({ url: `${RUN_V2}/${jobPath}/executions/${executionId}:cancel`, method: "POST", data: {} });
    },
  };

  const rolesOf = (policy: unknown, member: string) =>
    (((policy as { bindings?: { role?: unknown; members?: unknown }[] } | undefined)?.bindings ?? [])
      .filter((binding) => Array.isArray(binding.members) && binding.members.includes(member))
      .map((binding) => String(binding.role)));
  const iam: CloudIamApi = {
    async projectRolesOf(member) {
      const policy = (await request({ url: `https://cloudresourcemanager.googleapis.com/v1/projects/${config.projectId}:getIamPolicy`, method: "POST", data: {} })).data;
      return rolesOf(policy, member);
    },
    async bucketRolesOf(bucket, member) {
      const [policy] = await storage.bucket(bucket).iam.getPolicy({ requestedPolicyVersion: 3 });
      return rolesOf(policy, member);
    },
  };

  const bucket = storage.bucket(config.transferBucket);
  const transfer: TransferStore = {
    async putObject(object, bytes, contentType) {
      await bucket.file(object).save(Buffer.from(bytes), { resumable: false, validation: "crc32c", metadata: { contentType }, preconditionOpts: { ifGenerationMatch: 0 } });
    },
    async signedReadUrl(object, expiresAt) {
      const [url] = await bucket.file(object).getSignedUrl({ version: "v4", action: "read", expires: expiresAt });
      return url;
    },
    async signedWriteUrl(object, maxBytes, expiresAt) {
      const [url] = await bucket.file(object).getSignedUrl({
        version: "v4", action: "write", expires: expiresAt, contentType: "application/json",
        extensionHeaders: { "x-goog-content-length-range": `0,${maxBytes}` },
      });
      return url;
    },
    async readObject(object, maxBytes) {
      const file = bucket.file(object);
      const [exists] = await file.exists();
      if (!exists) return undefined;
      const [metadata] = await file.getMetadata();
      if (Number(metadata.size ?? Infinity) > maxBytes) throw new CloudTransferTooLargeError("Build result exceeds its size bound");
      const [bytes] = await file.download({ validation: "crc32c" });
      if (bytes.length > maxBytes) throw new CloudTransferTooLargeError("Build result exceeds its size bound");
      return new Uint8Array(bytes);
    },
  };
  /** The coordinator's own service account (when ADC is a service account), so the worker can be checked against it. */
  const coordinatorServiceAccount = async () => {
    try {
      return (await storage.authClient.getCredentials()).client_email ?? undefined;
    } catch {
      return undefined;
    }
  };
  return { jobs, iam, transfer, coordinatorServiceAccount };
}
