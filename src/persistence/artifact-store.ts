export type ArtifactKind =
  | "SOURCE_ARCHIVE"
  | "SOURCE_MANIFEST"
  | "PRODUCTION_BUILD"
  | "SCREENSHOT"
  | "VISUAL_QA_REPORT"
  | "BROWSER_QA_REPORT"
  | "VISUAL_REVIEW_REPORT"
  | "VISUAL_REPAIR_ATTEMPT"
  | "DEPLOYMENT_BUILD"
  | "LOG"
  | "GENERATED_ASSET";
export interface ArtifactMetadata {
  readonly key: string;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly sha256?: string;
  readonly storageProvider?: string;
  readonly storageKey?: string;
  readonly siteId?: string;
  readonly versionId?: string;
}
export interface ArtifactStore {
  put(
    key: string,
    data: Uint8Array,
    options: { readonly kind: ArtifactKind; readonly contentType: string },
  ): Promise<ArtifactMetadata>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
