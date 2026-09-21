import type { ArtifactStore } from "../persistence/artifact-store.js";
import { ArtifactNamespace } from "../persistence/artifact-namespace.js";
import type { SiteId, VersionId } from "../shared/types.js";
import { serializeBrowserQAReport, type BrowserQAReport } from "./browser-qa-domain.js";

export async function persistBrowserQAReport(
  artifacts: ArtifactStore,
  siteId: SiteId,
  versionId: VersionId,
  report: BrowserQAReport,
): Promise<string> {
  const ref = ArtifactNamespace.version(siteId, versionId, "BROWSER_QA_REPORT", "report.json");
  await artifacts.put(ref, Buffer.from(serializeBrowserQAReport(report), "utf8"), {
    kind: "BROWSER_QA_REPORT",
    contentType: "application/json",
  });
  return ref;
}
