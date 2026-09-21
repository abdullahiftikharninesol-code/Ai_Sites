import type { ArtifactKind } from "./artifact-store.js";
const folders: Readonly<Record<ArtifactKind, string>> = {
  SOURCE_ARCHIVE: "source",
  SOURCE_MANIFEST: "source",
  PRODUCTION_BUILD: "build",
  SCREENSHOT: "screenshots",
  VISUAL_QA_REPORT: "qa",
  BROWSER_QA_REPORT: "qa",
  VISUAL_REVIEW_REPORT: "qa",
  VISUAL_REPAIR_ATTEMPT: "qa",
  DEPLOYMENT_BUILD: "deployment",
  LOG: "logs",
  GENERATED_ASSET: "assets",
};
export class ArtifactNamespace {
  static version(siteId: string, versionId: string, kind: ArtifactKind, filename: string): string {
    for (const value of [siteId, versionId, filename])
      if (!value || value.includes("..") || /[\\/]/.test(value))
        throw new Error("Invalid artifact namespace segment");
    return `sites/${siteId}/versions/${versionId}/${folders[kind]}/${filename}`;
  }
}
