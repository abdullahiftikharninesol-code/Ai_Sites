import { createHash } from "node:crypto";
import type { ArtifactStore } from "../../persistence/artifact-store.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import { isAbsolute, posix } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { SiteArtifactSecurityScanner } from "../../site-security/site-artifact-security-scanner.js";
export interface SiteSourceManifestFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly encoding?: "base64";
}
export interface SiteSourceManifest {
  readonly schemaVersion: 1 | 2;
  readonly technicalProfileId: string;
  readonly technicalProfileVersion?: number;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly files: readonly SiteSourceManifestFile[];
  readonly createdAt: string;
}
export interface SiteSourceSnapshot {
  readonly manifest: SiteSourceManifest;
  readonly files: Readonly<Record<string, string>>;
}
const included = (path: string): boolean =>
  path === "package.json" ||
  path === "package-lock.json" ||
  path === "index.html" ||
  path.startsWith("src/") ||
  path.startsWith("public/") ||
  path.startsWith("tsconfig") ||
  path === "vite.config.ts";
export class SiteSourceSnapshotService {
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly scanner = new SiteArtifactSecurityScanner(),
  ) {}
  async capture(
    execution: LocalExecutionProvider,
    environmentId: string,
    artifactRef: string,
    metadata: {
      technicalProfileId: string;
      technicalProfileVersion?: number;
      templateId: string;
      templateVersion: number;
    },
  ): Promise<SiteSourceSnapshot> {
    const files: Record<string, string> = {};
    const manifestFiles: SiteSourceManifestFile[] = [];
    for (const entry of await execution.listFiles(environmentId)) {
      if (entry.type !== "FILE" || !included(entry.path)) continue;
      const content = await execution.readFileBytes(environmentId, entry.path);
      const binary = !Buffer.from(content.toString("utf8")).equals(content);
      files[entry.path] = content.toString(binary ? "base64" : "utf8");
      manifestFiles.push({
        path: entry.path,
        sizeBytes: content.byteLength,
        ...(binary ? { encoding: "base64" as const } : {}),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    const snapshot: SiteSourceSnapshot = {
      manifest: {
        schemaVersion: 2,
        ...metadata,
        files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
        createdAt: new Date().toISOString(),
      },
      files,
    };
    this.scanner.scan(
      manifestFiles.map((file) => ({
        path: file.path,
        content: Buffer.from(files[file.path]!, file.encoding ?? "utf8"),
      })),
      "source",
    );
    const serialized = JSON.stringify(snapshot);
    await this.artifacts.put(artifactRef, Buffer.from(serialized), {
      kind: "SOURCE_ARCHIVE",
      contentType: "application/json",
    });
    const manifestRef = artifactRef.replace(/source\.json$/, "manifest.json");
    await this.artifacts.put(manifestRef, Buffer.from(JSON.stringify(snapshot.manifest)), {
      kind: "SOURCE_MANIFEST",
      contentType: "application/json",
    });
    return snapshot;
  }
  async restore(
    execution: LocalExecutionProvider,
    environmentId: string,
    artifactRef: string,
  ): Promise<SiteSourceSnapshot> {
    const artifact = await this.artifacts.get(artifactRef);
    if (!artifact)
      throw new ApplicationError(
        "ARTIFACT_NOT_FOUND",
        `Source artifact was not found: ${artifactRef}`,
      );
    let snapshot: SiteSourceSnapshot;
    try {
      snapshot = JSON.parse(Buffer.from(artifact).toString("utf8")) as SiteSourceSnapshot;
    } catch (cause) {
      throw new ApplicationError("ARTIFACT_INTEGRITY_FAILED", "Source artifact is not valid JSON", {
        cause,
      });
    }
    if (
      ![1, 2].includes(snapshot?.manifest?.schemaVersion) ||
      !Array.isArray(snapshot.manifest.files) ||
      !snapshot.files
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY_FAILED", "Unsupported source snapshot");
    const restored = new Map<string, Buffer>();
    for (const file of snapshot.manifest.files as readonly SiteSourceManifestFile[]) {
      if (
        !file ||
        typeof file.path !== "string" ||
        (file.encoding !== undefined && file.encoding !== "base64") ||
        isAbsolute(file.path) ||
        file.path.includes("\\") ||
        posix.normalize(file.path).startsWith("../") ||
        file.path.startsWith("/")
      )
        throw new ApplicationError(
          "ARTIFACT_INTEGRITY_FAILED",
          `Unsafe source manifest path: ${file.path}`,
        );
      const stored = snapshot.files[file.path];
      const content =
        typeof stored === "string" ? Buffer.from(stored, file.encoding ?? "utf8") : undefined;
      if (
        content === undefined ||
        content.byteLength !== file.sizeBytes ||
        createHash("sha256").update(content).digest("hex") !== file.sha256
      )
        throw new ApplicationError(
          "ARTIFACT_INTEGRITY_FAILED",
          `Source artifact integrity check failed: ${file.path}`,
        );
      restored.set(file.path, content);
    }
    for (const [path, content] of restored)
      await execution.writeFileBytes(environmentId, path, content);
    return snapshot;
  }
}
export interface SiteChangeSummary {
  readonly filesCreated: readonly string[];
  readonly filesModified: readonly string[];
  readonly filesDeleted: readonly string[];
  readonly summary: readonly string[];
}
export function summarizeChanges(
  before: SiteSourceSnapshot | undefined,
  after: SiteSourceSnapshot,
): SiteChangeSummary {
  const oldFiles = before?.files ?? {};
  const created = Object.keys(after.files)
    .filter((path) => oldFiles[path] === undefined)
    .sort();
  const modified = Object.keys(after.files)
    .filter((path) => oldFiles[path] !== undefined && oldFiles[path] !== after.files[path])
    .sort();
  const deleted = Object.keys(oldFiles)
    .filter((path) => after.files[path] === undefined)
    .sort();
  return {
    filesCreated: created,
    filesModified: modified,
    filesDeleted: deleted,
    summary: [
      ...created.map((path) => `created ${path}`),
      ...modified.map((path) => `modified ${path}`),
      ...deleted.map((path) => `deleted ${path}`),
    ],
  };
}
