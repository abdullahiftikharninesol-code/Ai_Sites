import { MongoConnectionManager } from "../../persistence/mongodb/mongo-connection.js";
import { createPublishBuildPath } from "../create-publish-preparation-service.js";

/**
 * Operator command (never run automatically): runs the pinned worker image in
 * probe mode in the configured Cloud Run job and records the attestation that
 * cloud builds require. Contains no tenant data. Requires
 * SITES_PUBLISH_BUILD_PROVIDER=cloud and the SITES_CLOUD_BUILD_* settings.
 *
 *   npm run publish:cloud-attest
 */
const mongo = new MongoConnectionManager(process.env.DATABASE);
try {
  if (process.env.SITES_PUBLISH_BUILD_PROVIDER?.trim() !== "cloud") throw new Error("Set SITES_PUBLISH_BUILD_PROVIDER=cloud to attest the cloud build job");
  await mongo.connect();
  const { cloud } = createPublishBuildPath({ connection: mongo.connection, execution: undefined as never });
  if (!cloud) throw new Error("The cloud build configuration is incomplete; see the warning above");
  const attestation = await cloud.attest();
  console.info(JSON.stringify({ passed: attestation.passed, violations: attestation.violations, configHash: attestation.configHash, executionId: attestation.executionId }, null, 2));
  process.exitCode = attestation.passed ? 0 : 1;
} catch (error) {
  console.error(`[sites][publish] attestation failed: ${(error as Error).message}`);
  const metadata = (error as { metadata?: unknown }).metadata;
  if (metadata) console.error(JSON.stringify(metadata, null, 2));
  process.exitCode = 1;
} finally {
  await mongo.disconnect().catch(() => undefined);
}
