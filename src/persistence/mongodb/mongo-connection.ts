import { createHash } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { ApplicationError } from "../../app/errors/application-error.js";

export interface MongoConnectionStatus {
  readonly provider: "mongodb";
  readonly connected: boolean;
}

export class MongoConnectionManager {
  readonly connection: Connection;
  readonly #uri: string | undefined;
  #connecting: Promise<void> | undefined;

  constructor(uri?: string) {
    this.#uri = uri?.trim() || undefined;
    this.connection = mongoose.createConnection();
  }

  async connect(): Promise<void> {
    if (this.connection.readyState === 1) return;
    if (!this.#uri)
      throw new ApplicationError(
        "PERSISTENCE_INITIALIZATION_FAILED",
        "MongoDB persistence requires DATABASE to be configured",
      );
    this.#connecting ??= this.connection
      .openUri(this.#uri, { serverSelectionTimeoutMS: 10_000 })
      .then(() => undefined)
      .catch(() => {
        throw new ApplicationError(
          "PERSISTENCE_INITIALIZATION_FAILED",
          "Unable to connect to MongoDB",
        );
      })
      .finally(() => {
        this.#connecting = undefined;
      });
    await this.#connecting;
  }

  status(): MongoConnectionStatus {
    return { provider: "mongodb", connected: this.connection.readyState === 1 };
  }

  async disconnect(): Promise<void> {
    if (this.#connecting) await this.#connecting.catch(() => undefined);
    if (this.connection.readyState !== 0) await this.connection.close();
  }
}

let shared:
  | { readonly fingerprint: string; readonly manager: MongoConnectionManager }
  | undefined;

export function getSharedMongoConnection(uri?: string): MongoConnectionManager {
  const normalized = uri?.trim() || "";
  const fingerprint = createHash("sha256").update(normalized).digest("hex");
  if (shared?.fingerprint === fingerprint) return shared.manager;
  if (shared && shared.manager.connection.readyState !== 0)
    throw new Error("MongoDB connection is already configured for this application");
  const manager = new MongoConnectionManager(normalized || undefined);
  shared = { fingerprint, manager };
  return manager;
}

export const connectMongo = (manager: MongoConnectionManager) => manager.connect();
export const getMongoStatus = (manager: MongoConnectionManager) => manager.status();
export const disconnectMongo = (manager: MongoConnectionManager) => manager.disconnect();
