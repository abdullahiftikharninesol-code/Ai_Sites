import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { inventoryStorage } from "../storage/storage-inventory.js";
import { inventoryMongoReferences } from "../storage/storage-inventory-references.js";
import { unavailableReferences } from "../storage/storage-references.js";

/** Separate from the report-writing cleanup CLI. JSON goes only to stdout; no model registration or SQLite opens. */
export async function runStorageInventoryCli(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<void> {
  const at = args.indexOf("--data-root");
  if (args.length && (args.length !== 2 || at !== 0 || !args[1] || args[1].startsWith("--"))) throw new Error("Usage: storage-inventory-cli --data-root <path>");
  const root = resolve(at >= 0 ? args[at + 1]! : env.SITES_DEV_DATA_ROOT ?? join(".sites-runtime", "playground"));
  const connection = mongoose.createConnection();
  try {
    if (env.DATABASE) await connection.openUri(env.DATABASE, { autoIndex: false, autoCreate: false, bufferCommands: false,
      serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000, socketTimeoutMS: 10_000 }).catch(() => undefined);
    const references = Number(connection.readyState) === 1 ? inventoryMongoReferences(connection)
      : { load: () => Promise.resolve(unavailableReferences("MONGODB_UNAVAILABLE")) };
    const report = await inventoryStorage({ dataRoot: root, references });
    console.log(JSON.stringify(report, null, 2));
  } finally { await connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runStorageInventoryCli(process.argv.slice(2), process.env).catch(() => {
    console.error("Storage inventory could not complete; no cleanup was performed.");
    process.exitCode = 1;
  });
}
