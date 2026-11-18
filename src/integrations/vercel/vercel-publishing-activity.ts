import type { Connection } from "mongoose";

/** Native count only: no publisher/model construction, skipped pages, or unknown-as-zero fallback. */
export async function countVercelPublishingActivity(connection: Pick<Connection, "db">, ownerId: string): Promise<number> {
  if (!connection.db) throw new Error("Publishing activity is unavailable");
  return connection.db.collection("sites_publish_operations").countDocuments({ ownerId, $or: [
    { active: true },
    { status: { $ne: "PUBLISHED" }, supersededAt: { $exists: false }, $or: [
      { deploymentId: { $exists: false }, deploymentRequestedAt: { $exists: true } },
      // READY without a verified publication is still uncertain (alias assignment may lag).
      { deploymentId: { $exists: true }, deploymentState: { $nin: ["ERROR", "CANCELED", "DELETED", "BLOCKED"] } },
    ] },
  ] }, { maxTimeMS: 5_000 });
}
