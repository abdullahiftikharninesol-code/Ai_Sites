import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPersistentSitesProduct } from "./sites/generation/create-local-persistent-sites-product.js";
import { SitesRuntimeClient } from "./site-runtime/runtime-client.js";
import type { SiteRuntimeSpec } from "./site-runtime/runtime-types.js";
import type { UserId } from "./shared/types.js";

const root = await mkdtemp(join(tmpdir(), "sites-runtime-demo-"));
const common = {
  artifactRoot: join(root, "artifacts"),
};
const userId = "runtime-demo" as UserId;
try {
  const first = createLocalPersistentSitesProduct({
    ...common,
    executionRoot: join(root, "execution-a"),
  });
  await first.connectPersistence();
  const runtimeGateway = first.createRuntimeGateway(["http://127.0.0.1:8088"], "127.0.0.1", 8090);
  await runtimeGateway.start();
  console.log("[RUNTIME] gateway ready");
  const v1 = await first.orchestrator.generateWebsite({
    userId,
    prompt: "Create a modern agency website with a contact form",
    planningMode: "deterministic",
    agentProvider: "mock",
  });
  console.log("[V1] generated, built, and browser validated");
  const runtime = await first.siteRuntime.getRuntime(v1.siteId);
  if (!runtime) throw new Error("Runtime was not provisioned");
  const d1 = await first.deploymentService.deploy({ siteId: v1.siteId, versionId: v1.versionId });
  await first.deploymentService.publish(d1);
  console.log("[V1] deployed and published");
  const hosting = first.createHostingGateway("127.0.0.1", 8088);
  await hosting.start();
  const project = (await first.queries.getProject(v1.siteId)).project;
  const hostedFormConfigured = (await (await fetch(hosting.url(project.slug))).text()).includes(
    "contact_submissions",
  );
  const client = new SitesRuntimeClient(
    { siteId: v1.siteId, baseUrl: "http://127.0.0.1:8090" },
    (input, init) =>
      fetch(input, { ...init, headers: { ...init?.headers, origin: "http://127.0.0.1:8088" } }),
  );
  await client.data.create("contact_submissions", {
    name: "Demo visitor",
    email: "demo@example.test",
    message: "First submission",
  });
  const publicDenied = await client.data.list("contact_submissions").then(
    () => false,
    () => true,
  );
  const before = (
    await first.siteRuntimeService.list(
      v1.siteId,
      "contact_submissions",
      {},
      { kind: "INTERNAL", ownerId: userId },
    )
  ).total;
  console.log(
    `Site ID: ${v1.siteId}\nRuntime ID: ${runtime.id}\nRuntime schema: ${runtime.schemaVersion}\nCollections: ${runtime.spec.collections.map((x) => x.name).join(", ")}\nV1: ${v1.versionId}\nHosted URL: ${hosting.url(project.slug)}\nHosted contact form configured: ${hostedFormConfigured}\nRecords: ${before}\nPublic read denied: ${publicDenied}`,
  );
  await hosting.close();
  await runtimeGateway.close();
  await first.close();
  console.log("[RESTART] first application closed");
  const second = createLocalPersistentSitesProduct({
    ...common,
    executionRoot: join(root, "execution-b"),
  });
  await second.connectPersistence();
  const restarted = (
    await second.siteRuntimeService.list(
      v1.siteId,
      "contact_submissions",
      {},
      { kind: "INTERNAL", ownerId: userId },
    )
  ).total;
  console.log("[RESTART] runtime record restored");
  const current = (await second.siteRuntime.getRuntime(v1.siteId))!;
  const migrated: SiteRuntimeSpec = {
    ...current.spec,
    collections: current.spec.collections.map((collection) =>
      collection.name === "contact_submissions"
        ? { ...collection, fields: [...collection.fields, { name: "phone", type: "string" }] }
        : collection,
    ),
  };
  await second.siteRuntime.applySchema(v1.siteId, current.schemaVersion, migrated);
  const v2 = await second.orchestrator.editWebsite({
    userId,
    siteId: v1.siteId,
    versionId: v1.versionId,
    instruction: "Change heading",
    agentProvider: "mock",
  });
  console.log("[V2] edited, built, and browser validated");
  const d2 = await second.deploymentService.deploy({
    siteId: v1.siteId,
    versionId: v2.newVersionId,
  });
  await second.deploymentService.publish(d2);
  await second.siteRuntimeService.create(
    v1.siteId,
    "contact_submissions",
    {
      name: "Second visitor",
      email: "second@example.test",
      message: "Second submission",
      phone: "123",
    },
    { kind: "INTERNAL", ownerId: userId },
  );
  const afterV2 = (
    await second.siteRuntimeService.list(
      v1.siteId,
      "contact_submissions",
      {},
      { kind: "INTERNAL", ownerId: userId },
    )
  ).total;
  await second.deploymentService.rollback(v1.siteId, d1.id);
  const afterRollback = (
    await second.siteRuntimeService.list(
      v1.siteId,
      "contact_submissions",
      {},
      { kind: "INTERNAL", ownerId: userId },
    )
  ).total;
  console.log(
    `Restart records: ${restarted}\nV2: ${v2.newVersionId}\nRuntime schema: 2\nV2 records: ${afterV2}\nRollback records: ${afterRollback}\nCleanup: environments=${second.execution.getActiveEnvironmentCount()}`,
  );
  await second.close();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log("Temporary runtime demo data cleaned");
}
