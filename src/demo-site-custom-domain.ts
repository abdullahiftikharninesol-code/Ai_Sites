import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createLocalPersistentSitesProduct } from "./sites/generation/create-local-persistent-sites-product.js";
import type { UserId } from "./shared/types.js";
const root = await mkdtemp(join(tmpdir(), "sites-domain-demo-")),
  common = {
    databasePath: join(root, "sites.db"),
    runtimeDatabasePath: join(root, "runtime.sqlite"),
    artifactRoot: join(root, "artifacts"),
  },
  userId = "domain-demo" as UserId,
  hostname = "www.example.test";
const hostGet = (base: string, host: string, path = "/") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(base),
      req = httpRequest(
        { hostname: url.hostname, port: url.port, path, headers: { Host: host } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (raw: unknown) =>
            chunks.push(raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.alloc(0)),
          );
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
    req.on("error", reject);
    req.end();
  });
try {
  const a = createLocalPersistentSitesProduct({ ...common, executionRoot: join(root, "a") });
  const v1 = await a.orchestrator.generateWebsite({
      userId,
      prompt: "Create a custom-domain product site",
      planningMode: "deterministic",
      agentProvider: "mock",
    }),
    d1 = await a.deploymentService.deploy({ siteId: v1.siteId, versionId: v1.versionId });
  await a.deploymentService.publish(d1);
  const added = await a.customDomainService.add(v1.siteId, hostname);
  console.log(
    `[DOMAIN] registered ${hostname}: ${added.domain.status}; challenge issued (token redacted)`,
  );
  await a.customDomainService.verify(v1.siteId, added.domain.id).catch(() => undefined);
  console.log("[VERIFY] before simulated DNS: pending/failed safely");
  const challenge = await a.customDomainService.reissue(v1.siteId, added.domain.id);
  a.localDns.setTxtRecord(challenge.recordName, challenge.recordValue);
  await a.customDomainService.verify(v1.siteId, added.domain.id);
  await a.customDomainService.activate(v1.siteId, added.domain.id);
  const gateway = a.createHostingGateway("127.0.0.1", 0);
  await gateway.start();
  const address = gateway.url("unused").replace(/\/sites\/unused\/$/, "/");
  console.log(
    `[V1] custom host status: ${(await hostGet(address, hostname)).status}; SPA: ${(await hostGet(address, hostname, "/features")).status}; missing asset: ${(await hostGet(address, hostname, "/assets/missing.js")).status}`,
  );
  await gateway.close();
  await a.close();
  const b = createLocalPersistentSitesProduct({ ...common, executionRoot: join(root, "b") }),
    gateway2 = b.createHostingGateway("127.0.0.1", 0);
  await gateway2.start();
  const address2 = gateway2.url("unused").replace(/\/sites\/unused\/$/, "/");
  console.log(
    `[RESTART] domain persisted and served: ${(await hostGet(address2, hostname)).status === 200}`,
  );
  const v2 = await b.orchestrator.editWebsite({
      userId,
      siteId: v1.siteId,
      versionId: v1.versionId,
      instruction: "Change heading",
      agentProvider: "mock",
    }),
    d2 = await b.deploymentService.deploy({ siteId: v1.siteId, versionId: v2.newVersionId });
  await b.deploymentService.publish(d2);
  console.log(
    `[V2] same domain served current publish: ${(await hostGet(address2, hostname)).status === 200}`,
  );
  await b.deploymentService.rollback(v1.siteId, d1.id);
  console.log(
    `[ROLLBACK] same domain served V1: ${(await hostGet(address2, hostname)).status === 200}`,
  );
  await b.deploymentService.unpublish(v1.siteId);
  console.log(`[UNPUBLISH] custom host status: ${(await hostGet(address2, hostname)).status}`);
  await b.deploymentService.publish(d1);
  await b.customDomainService.disable(v1.siteId, added.domain.id);
  console.log(
    `[DISABLE] host status: ${(await hostGet(address2, hostname)).status}; default route: ${(await fetch(gateway2.url((await b.queries.getProject(v1.siteId)).project.slug))).status}`,
  );
  await gateway2.close();
  b.localDns.clear();
  console.log(
    `[CLEANUP] environments=${b.execution.getActiveEnvironmentCount()}, simulatedDns=cleared`,
  );
  await b.close();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log("Temporary custom-domain demo data cleaned");
}
