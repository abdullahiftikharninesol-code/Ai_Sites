import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPersistentSitesProduct } from "./sites/generation/create-local-persistent-sites-product.js";
import type { UserId } from "./shared/types.js";
const root = await mkdtemp(join(tmpdir(), "sites-hosting-demo-"));
const common = {
  databasePath: join(root, "sites.db"),
  artifactRoot: join(root, "artifacts"),
};
const userId = "hosting-demo" as UserId;
try {
  const a = createLocalPersistentSitesProduct({ ...common, executionRoot: join(root, "a") });
  const v1 = await a.orchestrator.generateWebsite({
    userId,
    prompt: "Create a hosted product site",
    planningMode: "deterministic",
    agentProvider: "mock",
  });
  const d1 = await a.deploymentService.deploy({ siteId: v1.siteId, versionId: v1.versionId });
  await a.deploymentService.publish(d1);
  const g = a.createHostingGateway("127.0.0.1", 0);
  await g.start();
  const slug = (await a.queries.getProject(v1.siteId)).project.slug;
  console.log(
    `Site: ${v1.siteId}\nV1: ${v1.versionId}\nDeployment V1: ${d1.id}\nHosted URL: ${g.url(slug)}\nBuild: ${d1.metrics?.finalBuildDurationMs}ms; artifact: ${d1.metrics?.deploymentArtifactBytes} bytes`,
  );
  await g.close();
  await a.close();
  const b = createLocalPersistentSitesProduct({ ...common, executionRoot: join(root, "b") });
  const g2 = b.createHostingGateway("127.0.0.1", 0);
  await g2.start();
  console.log(`Restart served V1: ${(await fetch(g2.url(slug))).status === 200}`);
  const v2 = await b.orchestrator.editWebsite({
    userId,
    siteId: v1.siteId,
    versionId: v1.versionId,
    instruction: "Change heading",
    agentProvider: "mock",
  });
  const d2 = await b.deploymentService.deploy({ siteId: v1.siteId, versionId: v2.newVersionId });
  await b.deploymentService.publish(d2);
  console.log(`V2: ${v2.newVersionId}\nDeployment V2: ${d2.id}\nSame URL: ${g2.url(slug)}`);
  const started = Date.now();
  await b.deploymentService.rollback(v1.siteId, d1.id);
  console.log(`Rollback V1: true; ${Date.now() - started}ms`);
  await b.deploymentService.unpublish(v1.siteId);
  console.log(
    `Unpublish status: ${(await fetch(g2.url(slug))).status}\nV1 artifact retained: ${await b.artifacts.exists(d1.deploymentArtifactRef!)}\nCleanup: environments=${b.execution.getActiveEnvironmentCount()}`,
  );
  await g2.close();
  await b.close();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log("Temporary hosting demo data cleaned");
}
