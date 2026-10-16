import { Storage } from "@google-cloud/storage";
import type {
  ComparableTemplateArtifactStorage,
  TemplateArtifactStorage,
  TemplateArtifactWrite,
} from "./template-artifact-storage.js";

/**
 * Stores private template artifacts using Google Application Default Credentials.
 * The adapter never makes objects public and never creates signed URLs.
 */
export class GoogleCloudTemplateArtifactStorage
  implements TemplateArtifactStorage, ComparableTemplateArtifactStorage
{
  readonly bucketName: string;

  constructor(
    bucketName: string,
    private readonly storage = new Storage(),
  ) {
    const normalized = bucketName.trim();
    if (!normalized) throw new Error("SITES_TEMPLATE_GCS_BUCKET is required");
    this.bucketName = normalized;
  }

  async objectExists(object: string): Promise<boolean> {
    const [exists] = await this.storage.bucket(this.bucketName).file(object).exists();
    return exists;
  }

  async readObject(object: string): Promise<Uint8Array | undefined> {
    try {
      const [bytes] = await this.storage.bucket(this.bucketName).file(object).download();
      return new Uint8Array(bytes);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        Number(error.code) === 404
      )
        return undefined;
      throw error;
    }
  }

  async putObject(write: TemplateArtifactWrite): Promise<void> {
    await this.storage.bucket(this.bucketName).file(write.object).save(write.bytes, {
      resumable: false,
      validation: "crc32c",
      metadata: { contentType: write.contentType },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  }

  async deleteObject(object: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(object).delete();
  }
}
