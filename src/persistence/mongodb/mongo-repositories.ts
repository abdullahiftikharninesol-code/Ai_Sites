import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ArtifactStore } from "../artifact-store.js";
import type {
  SiteSourceManifest,
  SiteSourceSnapshot,
} from "../../sites/generation/source-snapshot.js";
import type { SiteJob, SiteProject, SiteVersion } from "../../sites/domain/entities.js";
import type { DeploymentId, JobId, SiteId, UserId, VersionId } from "../../shared/types.js";
import type {
  SiteJobRepository,
  SiteProjectRepository,
  SiteVersionRepository,
} from "../repositories.js";
import type { SiteVersionCommitter, UnnumberedSiteVersion } from "../version-committer.js";
import type {
  MongoModels,
  MongoSiteJobRecord,
  MongoSiteProjectRecord,
} from "./mongo-models.js";

interface LegacyMongoCurrentFile {
  readonly path: string;
  readonly content: string;
  readonly encoding?: "base64";
}

interface LegacyMongoSiteProjectRecord extends MongoSiteProjectRecord {
  readonly currentFiles?: readonly LegacyMongoCurrentFile[];
}

interface PublicationState {
  readonly versionId: VersionId;
  readonly deploymentId: DeploymentId;
}

/** Runtime-only state that deliberately does not expand the MongoDB schema. */
export class MongoRuntimeState {
  readonly versions = new Map<SiteId, SiteVersion>();
  readonly publications = new Map<SiteId, PublicationState>();
}

const writeError = (message: string, cause: unknown): never => {
  throw new ApplicationError("PERSISTENCE_WRITE_FAILED", message, { cause });
};

const slugFor = (siteId: string): string => `site-${siteId.slice(0, 8)}`;
const versionIdFor = (siteId: string, versionNumber: number): VersionId =>
  `${siteId}:v${versionNumber}` as VersionId;
const sourceRefFor = (siteId: string): string => `sites/${siteId}/current/source.json`;
const manifestRefFor = (siteId: string): string => `sites/${siteId}/current/manifest.json`;

const projectFrom = (record: MongoSiteProjectRecord, state: MongoRuntimeState): SiteProject => {
  const publication = state.publications.get(record._id as SiteId);
  return {
    id: record._id as SiteId,
    ownerId: record.ownerId as UserId,
    name: record.name,
    originalPrompt: record.originalPrompt,
    versionNumber: record.versionNumber,
    ...(record.lastOperation ? { lastOperation: record.lastOperation } : {}),
    ...(record.lastEditPrompt ? { lastEditPrompt: record.lastEditPrompt } : {}),
    slug: slugFor(record._id),
    status: record.status as SiteProject["status"],
    ...(record.versionNumber > 0
      ? { latestVersionId: versionIdFor(record._id, record.versionNumber) }
      : {}),
    ...(publication
      ? {
          publishedVersionId: publication.versionId,
          publishedDeploymentId: publication.deploymentId,
        }
      : {}),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
};

export class MongoSiteProjectRepository implements SiteProjectRepository {
  constructor(
    private readonly models: MongoModels,
    private readonly state = new MongoRuntimeState(),
  ) {}

  async getById(id: SiteId) {
    const record = await this.models.projects.findById(id).lean().exec();
    return record ? projectFrom(record, this.state) : undefined;
  }

  async getBySlug(slug: string) {
    const records = await this.models.projects.find({}).lean().exec();
    const record = records.find((item) => slugFor(item._id) === slug);
    return record ? projectFrom(record, this.state) : undefined;
  }

  async save(project: SiteProject) {
    try {
      await this.models.projects
        .updateOne(
          { _id: project.id },
          {
            $set: {
              ownerId: project.ownerId,
              name: project.name,
              originalPrompt: project.originalPrompt ?? "",
              status: project.status,
              updatedAt: project.updatedAt,
            },
            $setOnInsert: {
              _id: project.id,
              versionNumber: 0,
              createdAt: project.createdAt,
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (cause) {
      writeError("Unable to save site project", cause);
    }
  }

  async listByOwner(ownerId: string) {
    try {
      const records = await this.models.projects
        .find({ ownerId })
        .sort({ updatedAt: -1 })
        .lean()
        .exec();
      return { items: records.map((record) => projectFrom(record, this.state)) };
    } catch (cause) {
      throw new ApplicationError("PERSISTENCE_READ_FAILED", "Unable to list site projects", {
        cause,
      });
    }
  }

  async setPublication(
    siteId: SiteId,
    publication?: { readonly versionId: VersionId; readonly deploymentId: DeploymentId },
  ) {
    if (!(await this.models.projects.exists({ _id: siteId })))
      throw new ApplicationError("SITE_NOT_FOUND", "Site project was not found");
    if (publication) this.state.publications.set(siteId, publication);
    else this.state.publications.delete(siteId);
  }
}

export class MongoSiteVersionRepository implements SiteVersionRepository {
  constructor(
    private readonly models: MongoModels,
    private readonly artifacts: ArtifactStore,
    private readonly state = new MongoRuntimeState(),
  ) {}

  async getById(id: VersionId) {
    for (const version of this.state.versions.values())
      if (version.id === id) return cloneVersion(version);
    const parsed = parseVersionId(id);
    if (!parsed) return undefined;
    const record = await this.models.projects.findById(parsed.siteId).lean().exec();
    if (!record || record.versionNumber !== parsed.versionNumber || record.versionNumber < 1)
      return undefined;
    await this.#assertSnapshotExists(record);
    return versionFrom(record);
  }

  async save(version: SiteVersion) {
    const record = await this.models.projects.findById(version.siteId).lean().exec();
    if (!record) throw new ApplicationError("SITE_NOT_FOUND", "Site project was not found");
    const snapshot = await readSnapshot(this.artifacts, version.sourceArtifactRef);
    const sourceManifestRef = await ensureLocalManifest(
      this.artifacts,
      version.sourceArtifactRef,
      version.sourceManifestRef,
      snapshot,
    );
    const now = new Date();
    const result = await this.models.projects
      .updateOne(
        { _id: version.siteId, versionNumber: record.versionNumber },
        {
          $set: {
            sourceArtifactRef: version.sourceArtifactRef,
            sourceManifestRef,
            status: "ACTIVE",
            versionNumber: version.versionNumber,
            lastOperation: record.versionNumber === 0 ? "GENERATE" : "EDIT",
            updatedAt: now,
          },
        },
      )
      .exec();
    if (!result.matchedCount)
      throw new ApplicationError(
        "PERSISTENCE_TRANSACTION_FAILED",
        "Current site changed while saving the generated result",
      );
    this.state.versions.set(version.siteId, {
      ...cloneVersion(version),
      id: versionIdFor(version.siteId, version.versionNumber),
      sourceManifestRef,
    });
  }

  async listBySite(siteId: SiteId) {
    const cached = this.state.versions.get(siteId);
    if (cached) return { items: [cloneVersion(cached)] };
    const record = await this.models.projects.findById(siteId).lean().exec();
    if (!record || record.versionNumber < 1) return { items: [] };
    await this.#assertSnapshotExists(record);
    return { items: [versionFrom(record)] };
  }

  async #assertSnapshotExists(record: MongoSiteProjectRecord): Promise<void> {
    await readSnapshot(this.artifacts, sourceArtifactRefFrom(record));
  }
}

export class MongoSiteVersionCommitter implements SiteVersionCommitter {
  constructor(
    private readonly models: MongoModels,
    private readonly artifacts: ArtifactStore,
    private readonly state = new MongoRuntimeState(),
  ) {}

  async commit(project: SiteProject, draft: UnnumberedSiteVersion): Promise<SiteVersion> {
    try {
      const current = await this.models.projects.findById(project.id).lean().exec();
      if (!current) throw new ApplicationError("SITE_NOT_FOUND", "Site project was not found");
      const snapshot = await readSnapshot(this.artifacts, draft.sourceArtifactRef);
      const sourceManifestRef = await ensureLocalManifest(
        this.artifacts,
        draft.sourceArtifactRef,
        draft.sourceManifestRef,
        snapshot,
      );
      const versionNumber = current.versionNumber + 1;
      const operation = current.versionNumber === 0 ? "GENERATE" : "EDIT";
      const now = new Date();
      const set: Record<string, unknown> = {
        sourceArtifactRef: draft.sourceArtifactRef,
        sourceManifestRef,
        status: "ACTIVE",
        versionNumber,
        lastOperation: operation,
        updatedAt: now,
      };
      const update: Record<string, unknown> = { $set: set };
      if (operation === "EDIT") set.lastEditPrompt = project.lastEditPrompt ?? "";
      else {
        set.name = project.name;
        update.$unset = { lastEditPrompt: 1 };
      }
      const updated = await this.models.projects
        .findOneAndUpdate({ _id: project.id, versionNumber: current.versionNumber }, update, {
          new: true,
        })
        .lean()
        .exec();
      if (!updated)
        throw new ApplicationError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "Current site changed while saving the generated result",
        );
      const version: SiteVersion = {
        ...draft,
        id: versionIdFor(project.id, versionNumber),
        versionNumber,
        sourceManifestRef,
      };
      this.state.versions.set(project.id, cloneVersion(version));
      return version;
    } catch (cause) {
      if (cause instanceof ApplicationError) throw cause;
      throw new ApplicationError(
        "PERSISTENCE_TRANSACTION_FAILED",
        "Unable to atomically replace current site state",
        { cause },
      );
    }
  }
}

export class MongoSiteJobRepository implements SiteJobRepository {
  constructor(private readonly models: MongoModels) {}

  async getById(id: JobId) {
    const record = await this.models.jobs.findOne({ jobId: id }).lean().exec();
    return record ? jobFrom(record) : undefined;
  }

  async save(job: SiteJob) {
    try {
      const set: Record<string, unknown> = {
        projectId: job.siteId,
        ownerId: job.userId,
        operation: job.operation,
        status: job.status,
        stage: job.stage,
        provider: job.provider,
        logicalCalls: job.logicalCalls,
        physicalRequests: job.physicalRequests,
        retries: job.retries,
        modelOutputReceived: job.modelOutputReceived,
        websiteGenerated: job.websiteGenerated,
        updatedAt: job.updatedAt,
      };
      const unset: Record<string, 1> = {};
      for (const key of [
        "model",
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "reasoningTokens",
        "totalTokens",
        "errorCode",
        "errorMessage",
        "retryable",
      ] as const) {
        const value = job[key];
        if (value === undefined) unset[key] = 1;
        else set[key] = value;
      }
      await this.models.jobs
        .updateOne(
          { jobId: job.id },
          {
            $set: set,
            $setOnInsert: { jobId: job.id, createdAt: job.createdAt },
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
          { upsert: true },
        )
        .exec();
    } catch (cause) {
      writeError("Unable to save site job", cause);
    }
  }

  async listBySite(siteId: SiteId) {
    const records = await this.models.jobs
      .find({ projectId: siteId })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    return { items: records.map(jobFrom) };
  }
}

export async function deleteMongoSite(models: MongoModels, siteId: SiteId): Promise<void> {
  await Promise.all([
    models.jobs.deleteMany({ projectId: siteId }).exec(),
    models.projects.deleteOne({ _id: siteId }).exec(),
  ]);
}

export async function migrateMongoProjectFilesToLocalArtifacts(
  models: MongoModels,
  artifacts: ArtifactStore,
): Promise<number> {
  const cursor = models.projects.collection.find(
    { currentFiles: { $exists: true } } as never,
    {
      projection: {
        _id: 1,
        currentFiles: 1,
        sourceArtifactRef: 1,
        sourceManifestRef: 1,
        versionNumber: 1,
        updatedAt: 1,
      },
    },
  );
  let migrated = 0;
  for await (const value of cursor) {
    const record = value as unknown as LegacyMongoSiteProjectRecord;
    const set: Record<string, unknown> = {};
    if (record.versionNumber > 0) {
      const sourceArtifactRef = sourceArtifactRefFrom(record);
      const sourceManifestRef = sourceManifestRefFrom(record);
      if (
        !(await artifacts.exists(sourceArtifactRef)) ||
        !(await artifacts.exists(sourceManifestRef))
      ) {
        const snapshot = snapshotFromLegacyRecord(record);
        await artifacts.put(sourceArtifactRef, Buffer.from(JSON.stringify(snapshot)), {
          kind: "SOURCE_ARCHIVE",
          contentType: "application/json",
        });
        await artifacts.put(
          sourceManifestRef,
          Buffer.from(JSON.stringify(snapshot.manifest)),
          { kind: "SOURCE_MANIFEST", contentType: "application/json" },
        );
      }
      set.sourceArtifactRef = sourceArtifactRef;
      set.sourceManifestRef = sourceManifestRef;
    }
    await models.projects.collection.updateOne(
      { _id: record._id, currentFiles: { $exists: true } } as never,
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        $unset: { currentFiles: "" },
      },
    );
    migrated++;
  }
  return migrated;
}

const cloneVersion = (version: SiteVersion): SiteVersion => ({
  ...structuredClone(version),
  createdAt: new Date(version.createdAt),
});

const parseVersionId = (
  id: string,
): { readonly siteId: SiteId; readonly versionNumber: number } | undefined => {
  const match = /^(.*):v([1-9]\d*)$/.exec(id);
  return match
    ? { siteId: match[1] as SiteId, versionNumber: Number(match[2]) }
    : undefined;
};

const jobFrom = (record: MongoSiteJobRecord): SiteJob => ({
  id: record.jobId as JobId,
  siteId: record.projectId as SiteId,
  userId: record.ownerId as UserId,
  operation: record.operation,
  status: record.status as SiteJob["status"],
  stage: record.stage,
  provider: record.provider,
  ...(record.model !== undefined ? { model: record.model } : {}),
  ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens } : {}),
  ...(record.cachedInputTokens !== undefined
    ? { cachedInputTokens: record.cachedInputTokens }
    : {}),
  ...(record.outputTokens !== undefined ? { outputTokens: record.outputTokens } : {}),
  ...(record.reasoningTokens !== undefined
    ? { reasoningTokens: record.reasoningTokens }
    : {}),
  ...(record.totalTokens !== undefined ? { totalTokens: record.totalTokens } : {}),
  logicalCalls: record.logicalCalls,
  physicalRequests: record.physicalRequests,
  retries: record.retries,
  modelOutputReceived: record.modelOutputReceived,
  websiteGenerated: record.websiteGenerated,
  ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
  ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
  ...(record.retryable !== undefined ? { retryable: record.retryable } : {}),
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const readSnapshot = async (
  artifacts: ArtifactStore,
  artifactRef: string,
): Promise<SiteSourceSnapshot> => {
  const data = await artifacts.get(artifactRef);
  if (!data)
    throw new ApplicationError("ARTIFACT_NOT_FOUND", `Source artifact was not found: ${artifactRef}`);
  try {
    const snapshot = JSON.parse(Buffer.from(data).toString("utf8")) as SiteSourceSnapshot;
    if (!snapshot?.manifest?.files || !snapshot.files)
      throw new Error("Source snapshot shape is invalid");
    return snapshot;
  } catch (cause) {
    throw new ApplicationError("ARTIFACT_INTEGRITY_FAILED", "Source artifact is not valid", {
      cause,
    });
  }
};

const snapshotFromLegacyRecord = (record: LegacyMongoSiteProjectRecord): SiteSourceSnapshot => {
  const currentFiles = record.currentFiles;
  if (!isLegacyCurrentFiles(currentFiles))
    throw new ApplicationError(
      "ARTIFACT_NOT_FOUND",
      `Legacy source files are unavailable for site ${record._id}`,
    );
  const files = Object.fromEntries(currentFiles.map((file) => [file.path, file.content]));
  const manifest: SiteSourceManifest = {
    schemaVersion: 2,
    technicalProfileId: "react-vite-v1",
    templateId: "react-vite-v1",
    templateVersion: 1,
    files: currentFiles
      .map((file) => {
        const content = Buffer.from(file.content, file.encoding ?? "utf8");
        return {
          path: file.path,
          sizeBytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          ...(file.encoding ? { encoding: file.encoding } : {}),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path)),
    createdAt: record.updatedAt.toISOString(),
  };
  return { manifest, files };
};

const isLegacyCurrentFiles = (value: unknown): value is readonly LegacyMongoCurrentFile[] =>
  Array.isArray(value) &&
  value.every(
    (file: unknown): file is LegacyMongoCurrentFile =>
      typeof file === "object" &&
      file !== null &&
      typeof (file as Partial<LegacyMongoCurrentFile>).path === "string" &&
      typeof (file as Partial<LegacyMongoCurrentFile>).content === "string" &&
      ((file as Partial<LegacyMongoCurrentFile>).encoding === undefined ||
        (file as Partial<LegacyMongoCurrentFile>).encoding === "base64"),
  );

const versionFrom = (record: MongoSiteProjectRecord): SiteVersion => ({
  id: versionIdFor(record._id, record.versionNumber),
  siteId: record._id as SiteId,
  versionNumber: record.versionNumber,
  ...(record.versionNumber > 1
    ? { parentVersionId: versionIdFor(record._id, record.versionNumber - 1) }
    : {}),
  sourceArtifactRef: sourceArtifactRefFrom(record),
  sourceManifestRef: sourceManifestRefFrom(record),
  buildStatus: "SUCCEEDED",
  browserQAStatus: "PASSED",
  createdAt: new Date(record.updatedAt),
});

const sourceArtifactRefFrom = (record: MongoSiteProjectRecord): string =>
  record.sourceArtifactRef ?? sourceRefFor(record._id);

const sourceManifestRefFrom = (record: MongoSiteProjectRecord): string =>
  record.sourceManifestRef ?? manifestRefFor(record._id);

const ensureLocalManifest = async (
  artifacts: ArtifactStore,
  sourceArtifactRef: string,
  configuredManifestRef: string | undefined,
  snapshot: SiteSourceSnapshot,
): Promise<string> => {
  const sourceManifestRef =
    configuredManifestRef ?? sourceArtifactRef.replace(/source\.json$/, "manifest.json");
  if (!(await artifacts.exists(sourceManifestRef)))
    await artifacts.put(sourceManifestRef, Buffer.from(JSON.stringify(snapshot.manifest)), {
      kind: "SOURCE_MANIFEST",
      contentType: "application/json",
    });
  return sourceManifestRef;
};
