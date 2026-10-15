import { Emitter } from "@socket.io/redis-emitter";
import { createClient } from "redis";

export interface SharedRedisConfig {
  readonly url?: string;
}

export interface RedisDeleteResult {
  readonly attempted: boolean;
  readonly deletedKeys: number;
}

export interface RedisEmitResult {
  readonly attempted: boolean;
}

export interface GetChatlyRedisGateway {
  deleteExactKeys(keys: readonly string[]): Promise<RedisDeleteResult>;
  emit(
    namespace: string,
    room: string,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<RedisEmitResult>;
}

export interface RedisCommandClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  del(keys: string[]): Promise<number>;
  publish(channel: string, message: string | Buffer): Promise<number>;
  close(): Promise<void>;
  on(event: "error", listener: () => void): unknown;
}

export interface RedisWarningLogger {
  warn(message: string): void;
}

export type RedisClientFactory = (url: string) => RedisCommandClient;

const defaultClientFactory: RedisClientFactory = (url) =>
  createClient({
    url,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  }) as unknown as RedisCommandClient;

/**
 * One lazy node-redis connection shared by exact cache deletes and the
 * official Socket.IO Redis emitter. Sites never needs a subscriber client.
 */
export class SharedRedisConnection implements GetChatlyRedisGateway {
  readonly #url: string | undefined;
  readonly #logger: RedisWarningLogger;
  readonly #clientFactory: RedisClientFactory;
  #client: RedisCommandClient | undefined;
  #connectPromise: Promise<RedisCommandClient> | undefined;
  #warnedUnavailable = false;
  #warnedClientError = false;
  #closed = false;

  constructor(
    config: SharedRedisConfig,
    logger: RedisWarningLogger = console,
    clientFactory: RedisClientFactory = defaultClientFactory,
  ) {
    this.#url = config.url?.trim() || undefined;
    this.#logger = logger;
    this.#clientFactory = clientFactory;
  }

  async deleteExactKeys(keys: readonly string[]): Promise<RedisDeleteResult> {
    const client = await this.#connectedClient();
    if (!client) return { attempted: false, deletedKeys: 0 };
    return { attempted: true, deletedKeys: await client.del([...keys]) };
  }

  async emit(
    namespace: string,
    room: string,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<RedisEmitResult> {
    const client = await this.#connectedClient();
    if (!client) return { attempted: false };

    // redis-emitter intentionally returns synchronously. Capture and await the
    // node-redis publish promise so a failed publish follows Phase B's warning
    // path instead of becoming an unhandled rejection.
    let publication: Promise<number> | undefined;
    const emitter = new Emitter(
      {
        publish: (channel: string, message: string | Buffer) => {
          publication = client.publish(channel, message);
          return publication;
        },
      },
      { key: "socket.io" },
    );
    emitter.of(namespace).to(room).emit(event, payload);
    if (!publication) throw new Error("Socket.IO Redis emitter did not publish an event");
    await publication;
    return { attempted: true };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#connectPromise?.catch(() => undefined);
    if (this.#client?.isOpen) await this.#client.close();
  }

  async #connectedClient(): Promise<RedisCommandClient | undefined> {
    if (!this.#url || this.#closed) {
      if (!this.#url && !this.#warnedUnavailable) {
        this.#warnedUnavailable = true;
        this.#logger.warn(
          "[sites][redis] REDIS_URL is not configured; GetChatly quota synchronization is unavailable",
        );
      }
      return undefined;
    }
    if (!this.#client) {
      this.#client = this.#clientFactory(this.#url);
      this.#client.on("error", () => {
        if (this.#warnedClientError) return;
        this.#warnedClientError = true;
        this.#logger.warn("[sites][redis] shared Redis client reported a connection error");
      });
    }
    if (this.#client.isOpen) return this.#client;
    this.#connectPromise ??= this.#client
      .connect()
      .then(() => this.#client!)
      .finally(() => {
        this.#connectPromise = undefined;
      });
    return this.#connectPromise;
  }
}
