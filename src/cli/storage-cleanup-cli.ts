import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MongoConnectionManager } from "../persistence/mongodb/mongo-connection.js";
import { createMongoModels } from "../persistence/mongodb/mongo-models.js";
import { planStorageCleanup } from "../storage/storage-cleanup-planner.js";
import { MongoStorageReferenceSource, unavailableReferences } from "../storage/storage-references.js";
import { withLegacyStoreReferences } from "../storage/legacy-store-references.js";
import { describeDatabase, verifyStorageEnvironment } from "../storage/storage-environment.js";

/**
 * Storage cleanup planner — DRY RUN ONLY. Reads MongoDB (read-only queries) and
 * the data root, writes a plan file, deletes nothing and stops no process.
 * Usage: node dist/cli/storage-cleanup-cli.js [--data-root <path>]
 */
const args = process.argv.slice(2);
const at = args.indexOf("--data-root");
const dataRoot = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : process.env.SITES_DEV_DATA_ROOT ?? join(".sites-runtime", "playground"));
const mongo = new MongoConnectionManager(process.env.DATABASE);
const connected = await mongo.connect().then(() => true, () => false);
const references = connected
  ? new MongoStorageReferenceSource(createMongoModels(mongo.connection), () => Number(mongo.connection.readyState) === 1)
  : { load: () => Promise.resolve(unavailableReferences("MONGODB_UNAVAILABLE")) };
try {
  const plan = await planStorageCleanup({ dataRoot, references: withLegacyStoreReferences(references, dataRoot) });
  await mkdir(join(dataRoot, ".cleanup-plans"), { recursive: true });
  const file = join(dataRoot, ".cleanup-plans", `${plan.planId}.json`);
  await writeFile(file, JSON.stringify(plan, null, 2), "utf8");
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const byCategory = new Map<string, { count: number; bytes: number }>();
  for (const candidate of plan.candidates) {
    const group = byCategory.get(candidate.category) ?? { count: 0, bytes: 0 };
    group.count++; group.bytes += candidate.sizeBytes; byCategory.set(candidate.category, group);
  }
  console.log(`DRY RUN plan ${plan.planId} (nothing deleted) references=${plan.referencesAvailable ? "available" : `UNAVAILABLE:${plan.referencesReason}`} truncated=${plan.truncated}`);
  console.log(`Reclaimable: ${mb(plan.totals.reclaimableBytes)} in ${plan.totals.candidates} candidates; protected: ${mb(plan.totals.protectedBytes)}`);
  for (const [category, group] of byCategory) console.log(`  candidate ${category}: ${group.count} (${mb(group.bytes)})`);
  for (const group of plan.protected) console.log(`  protected ${group.reason}: ${group.count} (${mb(group.sizeBytes)})`);
  for (const warning of plan.warnings) console.log(`  warning: ${warning}`);
  const audit = plan.legacyWorkspaceAudit;
  if (audit) {
    console.log(`Legacy workspaces (no ownership marker): process scan ${audit.processScan}, truncated=${audit.truncated}`);
    for (const [kind, total] of Object.entries(audit.totals)) console.log(`  ${kind}: ${total.count} (${mb(total.sizeBytes)})`);
    for (const finding of audit.findings) {
      const match = finding.matches.map(item => `${item.siteId.slice(0, 8)}/${item.attempt.slice(0, 8)}:${item.role}`).slice(0, 3).join(" ");
      console.log(`    ${finding.environmentId} ${mb(finding.sizeBytes).padStart(9)} ${finding.classification.padEnd(14)} ${finding.reason}${match ? ` [${finding.matchCount} match: ${match}]` : ""}`);
    }
  }
  // What a future approved execution would decide; nothing is executed here.
  const environment = await verifyStorageEnvironment({ dataRoot, databaseUri: process.env.DATABASE });
  const database = describeDatabase(process.env.DATABASE);
  console.log(`Execution precondition: ${environment.ok ? "PASS" : `REFUSED (${environment.reasons.join(", ")})`}; database ${database ? `${database.scheme} ${database.local ? "local" : "REMOTE"} "${database.database}"` : "unconfigured"}`);
  console.log(`Plan file: ${file}`);
} finally {
  await mongo.disconnect();
}
