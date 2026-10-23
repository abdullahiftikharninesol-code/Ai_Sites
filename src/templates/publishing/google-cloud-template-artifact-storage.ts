import { CRC32C, Storage } from "@google-cloud/storage";
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
      // The SDK's streaming teeny-request -> pipeline transport installs eleven
      // listeners on its PassThrough under Node 24. Buffer through the same ADC
      // client instead; retain CRC32C here and catalog SHA-256 at the caller.
      const url = `${this.storage.apiEndpoint.replace(/\/$/, "")}/storage/v1/b/${encodeURIComponent(this.bucketName)}/o/${encodeURIComponent(object)}?alt=media`;
      const response = await this.storage.authClient.request<ArrayBuffer>({
        url, method: "GET", responseType: "arraybuffer", headers: { "Accept-Encoding": "identity" },
      });
      const bytes = new Uint8Array(response.data);
      const expected = response.headers.get("x-goog-hash")?.split(",").map(value => value.trim()).find(value => value.startsWith("crc32c="))?.slice(7);
      const checksum = new CRC32C(); checksum.update(Buffer.from(bytes));
      if (!expected || checksum.toString() !== expected)
        throw Object.assign(new Error("Template source CRC32C integrity check failed"), { code: "CONTENT_DOWNLOAD_MISMATCH" });
      return new Uint8Array(bytes);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (("code" in error && Number(error.code) === 404) ||
          ("response" in error && (error.response as { status?: number } | undefined)?.status === 404))
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
