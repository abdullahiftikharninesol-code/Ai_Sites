export interface TemplateArtifactWrite {
  readonly object: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Narrow private-object storage contract used only by the template publisher. */
export interface TemplateArtifactStorage {
  readonly bucketName: string;
  objectExists(object: string): Promise<boolean>;
  putObject(write: TemplateArtifactWrite): Promise<void>;
  deleteObject(object: string): Promise<void>;
}

/** Create-only storage contract for approved catalog publication. */
export interface ComparableTemplateArtifactStorage {
  readonly bucketName: string;
  readObject(object: string): Promise<Uint8Array | undefined>;
  putObject(write: TemplateArtifactWrite): Promise<void>;
}

/** Read-only private-object contract used by runtime template instantiation. */
export interface TemplateArtifactReader {
  readObject(object: string): Promise<Uint8Array | undefined>;
}
