import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPersistentSitesProduct } from "./sites/generation/create-local-persistent-sites-product.js";
import type { UserId } from "./shared/types.js";
const root = await mkdtemp(join(tmpdir(), "sites-persistent-demo-"));
const artifactRoot = join(root, "artifacts");
const userId = "persistent-demo-user" as UserId;
console.log(`Persistent demo root: ${root}`);
try {
  const first = createLocalPersistentSitesProduct({
    artifactRoot,
    executionRoot: join(root, "runtime-1"),
  });
  await first.connectPersistence();
  const generated = await first.orchestrator.generateWebsite({
    userId,
    prompt: "Create a responsive restart-safe product website",
    planningMode: "deterministic",
    agentProvider: "mock",
  });
  console.log(
    `Instance A: site ${generated.siteId}; V1 ${generated.versionId}; Browser QA ${generated.browserQA?.status ?? "NOT_RUN"}`,
  );
  await first.close();
  console.log("Instance A database closed");
  const second = createLocalPersistentSitesProduct({
    artifactRoot,
    executionRoot: join(root, "runtime-2"),
  });
  await second.connectPersistence();
  const loaded = await second.queries.getProject(generated.siteId);
  console.log(
    `Instance B reload: ${loaded.project.name}; latest ${loaded.latestVersion?.versionNumber}`,
  );
  const restored = await second.pipeline.restoreVersion(generated.versionId);
  console.log(`Fresh restore build: ${restored.build.success}`);
  await second.pipeline.disposeRestoredEnvironment(restored.environmentId);
  const edited = await second.orchestrator.editWebsite({
    userId,
    siteId: generated.siteId,
    versionId: generated.versionId,
    instruction: "Change the heading",
    agentProvider: "mock",
  });
  console.log(`Instance B: V2 ${edited.newVersionId}; Browser QA ${edited.browserQA?.status ?? "NOT_RUN"}`);
  await second.close();
  const third = createLocalPersistentSitesProduct({
    artifactRoot,
    executionRoot: join(root, "runtime-3"),
  });
  await third.connectPersistence();
  const project = await third.queries.getProject(generated.siteId);
  const versions = await third.queries.listVersions(generated.siteId);
  console.log(
    `Instance C versions: ${versions.items.map((version) => `V${version.versionNumber}`).join(" → ")}`,
  );
  console.log(`Lineage: ${versions.items[1]?.parentVersionId} → ${versions.items[1]?.id}`);
  console.log(`Latest pointer: ${project.project.latestVersionId}`);
  console.log(
    `Screenshots persisted: ${versions.items.flatMap((version) => version.finalScreenshotRefs ?? []).length}`,
  );
  console.log(
    `Artifacts valid: ${(await Promise.all(versions.items.flatMap((version) => [version.sourceArtifactRef, version.sourceManifestRef!, ...(version.finalScreenshotRefs ?? [])]).map((ref) => third.artifacts.exists(ref)))).every(Boolean)}`,
  );
  console.log(
    `Cleanup: environments=${third.execution.getActiveEnvironmentCount()}`,
  );
  await third.close();
  console.log("Instance C database closed; restart boundary verified");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log("Temporary persistent demo root cleaned");
}
