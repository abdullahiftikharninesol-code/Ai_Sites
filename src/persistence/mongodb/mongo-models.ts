import { Schema, type Connection, type Model } from "mongoose";

export interface MongoSiteProjectRecord {
  _id: string;
  ownerId: string;
  name: string;
  originalPrompt: string;
  sourceArtifactRef?: string;
  sourceManifestRef?: string;
  status: string;
  versionNumber: number;
  lastOperation?: "GENERATE" | "EDIT";
  lastEditPrompt?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MongoSiteJobRecord {
  jobId: string;
  projectId: string;
  ownerId: string;
  operation: "GENERATE" | "EDIT";
  status: string;
  stage: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  logicalCalls: number;
  physicalRequests: number;
  retries: number;
  modelOutputReceived: boolean;
  websiteGenerated: boolean;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MongoModels {
  readonly projects: Model<MongoSiteProjectRecord>;
  readonly jobs: Model<MongoSiteJobRecord>;
}

const projectSchema = new Schema<MongoSiteProjectRecord>(
  {
    _id: { type: String, required: true, immutable: true },
    ownerId: { type: String, required: true },
    name: { type: String, required: true },
    originalPrompt: { type: String, required: true },
    sourceArtifactRef: String,
    sourceManifestRef: String,
    status: { type: String, required: true },
    versionNumber: { type: Number, required: true, min: 0, default: 0 },
    lastOperation: { type: String, enum: ["GENERATE", "EDIT"] },
    lastEditPrompt: String,
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: "sites_projects", versionKey: false, strict: "throw" },
);
projectSchema.index({ ownerId: 1, updatedAt: -1 });

const jobSchema = new Schema<MongoSiteJobRecord>(
  {
    jobId: { type: String, required: true, unique: true, immutable: true },
    projectId: { type: String, required: true },
    ownerId: { type: String, required: true },
    operation: { type: String, required: true, enum: ["GENERATE", "EDIT"] },
    status: { type: String, required: true },
    stage: { type: String, required: true },
    provider: { type: String, required: true },
    model: String,
    inputTokens: Number,
    cachedInputTokens: Number,
    outputTokens: Number,
    reasoningTokens: Number,
    totalTokens: Number,
    logicalCalls: { type: Number, required: true, min: 0 },
    physicalRequests: { type: Number, required: true, min: 0 },
    retries: { type: Number, required: true, min: 0 },
    modelOutputReceived: { type: Boolean, required: true },
    websiteGenerated: { type: Boolean, required: true },
    errorCode: String,
    errorMessage: String,
    retryable: Boolean,
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: "sites_jobs", versionKey: false, strict: "throw" },
);
jobSchema.index({ projectId: 1, createdAt: -1 });
jobSchema.index({ ownerId: 1, createdAt: -1 });

export function createMongoModels(connection: Connection): MongoModels {
  return {
    projects:
      (connection.models.SitesProject as Model<MongoSiteProjectRecord> | undefined) ??
      connection.model<MongoSiteProjectRecord>("SitesProject", projectSchema),
    jobs:
      (connection.models.SitesJob as Model<MongoSiteJobRecord> | undefined) ??
      connection.model<MongoSiteJobRecord>("SitesJob", jobSchema),
  };
}
