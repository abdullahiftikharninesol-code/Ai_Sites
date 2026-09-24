import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactMetadata, ArtifactStore } from "./artifact-store.js";

export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;
  constructor(root = resolve(".local-data", "artifacts")) {
    this.#root = resolve(root);
  }
  #path(key: string): string {
    const target = resolve(this.#root, key);
    if (target !== this.#root && !target.startsWith(`${this.#root}${sep}`))
      throw new Error("Artifact key escapes storage root");
    return target;
  }
  async put(
    key: string,
    data: Uint8Array,
    options: { readonly kind: ArtifactMetadata["kind"]; readonly contentType: string },
  ): Promise<ArtifactMetadata> {
    const target = this.#path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return {
      key,
      kind: options.kind,
      contentType: options.contentType,
      sizeBytes: data.byteLength,
      createdAt: new Date(),
      sha256: createHash("sha256").update(data).digest("hex"),
      storageProvider: "local",
      storageKey: key,
    };
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async delete(key: string) {
    await rm(this.#path(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await rm(this.#path(prefix), { recursive: true, force: true });
  }
  async exists(key: string) {
    try {
      await stat(this.#path(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
