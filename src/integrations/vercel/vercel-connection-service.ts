import { createHash, randomBytes } from "node:crypto";
import type { Connection } from "mongoose";
import {
  loadVercelIntegrationConfig,
  type VercelIntegrationConfig,
  type VercelIntegrationConfigResult,
} from "./vercel-integration-config.js";
import {
  MongoVercelIntegrationRepository,
  VercelConfigurationConflictError,
  type VercelIntegrationRepository,
} from "./vercel-connection-repository.js";
import { createVercelOAuthClient, type VercelOAuthClient } from "./vercel-oauth-client.js";
import { decryptVercelToken, encryptVercelToken } from "./vercel-token-cipher.js";
import { countVercelPublishingActivity } from "./vercel-publishing-activity.js";
import {
  createVercelAccountVerifier,
  type VercelAccountVerification,
  type VercelAccountVerifier,
  type VercelConnectionProblem,
} from "./vercel-account-verifier.js";

/** A cached verification is reused for this long; status reads never hammer Vercel. */
export const VERCEL_VERIFICATION_TTL_MS = 10 * 60_000;
/** An explicit refresh re-verifies at most this often per user. */
export const VERCEL_REFRESH_MIN_INTERVAL_MS = 15_000;
/** Exact confirmation the disconnect request must carry (the UI sends it after an explicit confirm). */
export const VERCEL_DISCONNECT_CONFIRMATION = "DISCONNECT_VERCEL";

export const VERCEL_STATE_TTL_MS = 10 * 60_000;

/** Stable, non-sensitive reason codes; safe to show in the return URL. */
export type VercelCallbackFailure =
  | "not_configured"
  | "invalid_request"
  | "state_missing"
  | "state_invalid"
  | "exchange_failed"
  | "installation_mismatch"
  | "configuration_conflict"
  | "storage_failed"
  | "cancelled";

/** Owner and site from a consumed state; used only to choose the return page. */
export interface VercelReturnContext {
  readonly ownerId: string;
  readonly siteId?: string;
}

const ERROR_MESSAGES = {
  VERCEL_INTEGRATION_NOT_CONFIGURED: "Vercel integration is not configured",
  VERCEL_CALLBACK_FAILED: "Vercel connection failed",
  VERCEL_SITE_NOT_FOUND: "Site not found",
  VERCEL_NOT_CONNECTED: "Connect a Vercel account before publishing",
  VERCEL_TOKEN_UNAVAILABLE: "The stored Vercel authorization can no longer be used. Reconnect Vercel.",
  VERCEL_DISCONNECT_BLOCKED: "A website is being published with this Vercel connection. Wait for it to finish, or confirm disconnecting anyway.",
  VERCEL_DISCONNECT_UNAVAILABLE: "Publishing activity could not be verified. Try disconnecting Vercel again later.",
} as const;

/** Server-side credentials for one owner's active connection. Never serialized to clients or logs. */
export interface VercelCredentials {
  readonly ownerId: string;
  readonly configurationId: string;
  readonly teamId: string | null;
  readonly vercelUserId: string;
  readonly accessToken: string;
}

const VERCEL_INTEGRATION_ERROR = Symbol.for("ai-sites.VercelIntegrationError");

export class VercelIntegrationError extends Error {
  readonly [VERCEL_INTEGRATION_ERROR] = true;
  /** Brand check: classification must not depend on module identity. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== VercelIntegrationError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[VERCEL_INTEGRATION_ERROR] === true;
  }
  constructor(
    readonly code: keyof typeof ERROR_MESSAGES,
    readonly reason?: VercelCallbackFailure,
    readonly returnContext?: VercelReturnContext,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "VercelIntegrationError";
  }
}

/**
 * Browser view of the signed-in user's connection: no tokens, installation,
 * user or team IDs. The display name is only what Vercel itself reported.
 */
export interface VercelConnectionStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly state: "DISCONNECTED" | "CONNECTED" | "REAUTHORIZATION_REQUIRED" | "VERIFICATION_UNAVAILABLE";
  readonly connection?: {
    readonly connectedAt: string;
    readonly accountType: "personal" | "team";
    readonly displayName?: string;
    readonly verifiedAt?: string;
    readonly problem?: VercelConnectionProblem;
  };
}

export interface VercelDisconnectResult {
  readonly disconnected: boolean;
  /** True only when Vercel confirmed the installation is gone (removed now or already). */
  readonly remoteRevoked: boolean;
  readonly revocation: "CONFIRMED" | "NOT_CONFIRMED" | "NOT_ATTEMPTED";
  /** Publishes that were running; they stop before their next Vercel change. */
  readonly interruptedPublishes: number;
}

/** The active connection's account, without decrypting anything. */
export interface VercelActiveAccount {
  readonly configurationId: string;
  /** Team ID for a team installation, else the Vercel user ID (server-side only). */
  readonly accountId: string;
  readonly accountType: "personal" | "team";
  readonly displayName?: string;
}

export type SiteOwnershipCheck = (ownerId: string, siteId: string) => Promise<boolean>;

export interface VercelConnectionServiceOptions {
  readonly repository: VercelIntegrationRepository;
  readonly oauth?: VercelOAuthClient;
  readonly config?: () => VercelIntegrationConfigResult;
  readonly now?: () => Date;
  /** Existing Sites ownership rule; required to bind an authorization to a site. */
  readonly siteOwnership?: SiteOwnershipCheck;
  /** Verifies a stored connection against Vercel (bounded, no retries). */
  readonly verifier?: VercelAccountVerifier;
  /** Running publish operations of this owner (they stop when the connection changes). */
  readonly activePublishes?: (ownerId: string) => Promise<number>;
}

const hashState = (state: string) => createHash("sha256").update(state, "utf8").digest("hex");

const CALLBACK_PATTERNS = {
  state: /^[A-Za-z0-9_-]{43}$/,
  code: /^[A-Za-z0-9._~-]{1,512}$/,
  configurationId: /^icfg_[A-Za-z0-9]{1,64}$/,
  teamId: /^team_[A-Za-z0-9]{1,64}$/,
} as const;

/** Sites project IDs; never a reserved editor path segment. */
const SITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const isSiteId = (value: unknown): value is string =>
  typeof value === "string" && SITE_ID_PATTERN.test(value) && value !== "build";

const fail = (reason: VercelCallbackFailure, returnContext?: VercelReturnContext) =>
  new VercelIntegrationError("VERCEL_CALLBACK_FAILED", reason, returnContext);

export class VercelConnectionService {
  readonly #repository: VercelIntegrationRepository;
  readonly #oauth: VercelOAuthClient;
  readonly #config: () => VercelIntegrationConfigResult;
  readonly #now: () => Date;
  readonly #siteOwnership: SiteOwnershipCheck | undefined;
  readonly #verifier: VercelAccountVerifier | undefined;
  readonly #activePublishes: ((ownerId: string) => Promise<number>) | undefined;
  readonly #lastRefresh = new Map<string, number>();
  readonly #verifying = new Map<string, Promise<VercelAccountVerification | undefined>>();

  constructor(options: VercelConnectionServiceOptions) {
    this.#repository = options.repository;
    this.#oauth = options.oauth ?? createVercelOAuthClient();
    this.#config = options.config ?? (() => loadVercelIntegrationConfig());
    this.#now = options.now ?? (() => new Date());
    this.#siteOwnership = options.siteOwnership;
    // No default: only the production factory talks to Vercel; without a verifier, status stays unverified.
    this.#verifier = options.verifier;
    this.#activePublishes = options.activePublishes;
  }

  configuration(): VercelIntegrationConfigResult {
    return this.#config();
  }

  #requireConfig(): VercelIntegrationConfig {
    const result = this.#config();
    if (!result.configured) throw new VercelIntegrationError("VERCEL_INTEGRATION_NOT_CONFIGURED");
    return result.config;
  }

  /** Fails closed: an invalid ID, missing checker or lookup error is "not owned". */
  async #ownsSite(ownerId: string, siteId: unknown): Promise<boolean> {
    if (!isSiteId(siteId) || !this.#siteOwnership) return false;
    return this.#siteOwnership(ownerId, siteId).catch(() => false);
  }

  /**
   * The owner's connection state. Verification is cached for
   * VERCEL_VERIFICATION_TTL_MS; `refresh` re-verifies (at most every
   * VERCEL_REFRESH_MIN_INTERVAL_MS per owner). Concurrent reads share one
   * verification, so status checks never multiply Vercel traffic.
   */
  async status(ownerId: string, options: { readonly refresh?: boolean } = {}): Promise<VercelConnectionStatus> {
    const configured = this.#config().configured;
    const connection = await this.#repository.findActiveConnection(ownerId);
    if (!connection) return { configured, connected: false, state: "DISCONNECTED" };
    const now = this.#now().getTime();
    const cached = connection.verification;
    const stale = !cached || now - cached.checkedAt.getTime() >= VERCEL_VERIFICATION_TTL_MS;
    const identity = this.#connectionIdentity(connection);
    const refreshAllowed = options.refresh === true && now - (this.#lastRefresh.get(identity) ?? 0) >= VERCEL_REFRESH_MIN_INTERVAL_MS;
    let verification: VercelAccountVerification | undefined = cached;
    if (configured && this.#verifier && (stale || refreshAllowed)) {
      if (refreshAllowed) this.#lastRefresh.set(identity, now);
      verification = (await this.#verify(connection)) ?? cached;
    }
    // Never serialize an older account's verification as the new connection's state.
    const current = await this.#repository.findActiveConnection(ownerId);
    if (!current) return { configured, connected: false, state: "DISCONNECTED" };
    if (this.#connectionIdentity(current) !== identity) return {
      configured, connected: true, state: "VERIFICATION_UNAVAILABLE",
      connection: { connectedAt: current.connectedAt.toISOString(), accountType: current.teamId ? "team" : "personal" },
    };
    const accountType = connection.teamId ? "team" : "personal";
    const state: VercelConnectionStatus["state"] = !configured || !verification || verification.state === "UNAVAILABLE"
      ? "VERIFICATION_UNAVAILABLE"
      : verification.state === "REAUTHORIZATION_REQUIRED" ? "REAUTHORIZATION_REQUIRED" : "CONNECTED";
    return {
      configured,
      connected: true,
      state,
      connection: {
        connectedAt: connection.connectedAt.toISOString(),
        accountType,
        // A name is shown only from a successful verification of this connection.
        ...(verification?.state === "OK" && verification.displayName ? { displayName: verification.displayName } : {}),
        ...(verification ? { verifiedAt: verification.checkedAt.toISOString() } : {}),
        ...(verification?.problem ? { problem: verification.problem } : !configured ? { problem: "UNAVAILABLE" as const } : {}),
      },
    };
  }

  #connectionIdentity(connection: { ownerId: string; configurationId: string; encryptedAccessToken: string }) {
    return createHash("sha256").update(JSON.stringify([connection.ownerId, connection.configurationId, connection.encryptedAccessToken])).digest("hex");
  }
  /** One in-flight verification per exact encrypted connection, including same-installation renewals. */
  #verify(connection: { ownerId: string; configurationId: string; teamId: string | null; vercelUserId: string; encryptedAccessToken: string }) {
    const identity = this.#connectionIdentity(connection);
    const running = this.#verifying.get(identity);
    if (running) return running;
    const job = (async (): Promise<VercelAccountVerification | undefined> => {
      const config = this.#requireConfig();
      const now = this.#now();
      let accessToken: string;
      try {
        accessToken = decryptVercelToken(config.encryptionKey, connection.encryptedAccessToken, connection);
      } catch {
        accessToken = "";
      }
      const accountType = connection.teamId ? "team" : "personal";
      const verification: VercelAccountVerification = accessToken && this.#verifier
        ? await this.#verifier.verify({ auth: { accessToken, teamId: connection.teamId }, configurationId: connection.configurationId, accountId: connection.teamId ?? connection.vercelUserId, now })
        : { state: "REAUTHORIZATION_REQUIRED", problem: "TOKEN_UNREADABLE", accountType, checkedAt: now };
      await this.#repository.saveVerification(connection.ownerId, connection.configurationId, verification, connection.encryptedAccessToken).catch(() => undefined);
      return verification;
    })()
      .catch(() => undefined)
      .finally(() => this.#verifying.delete(identity));
    this.#verifying.set(identity, job);
    return job;
  }

  /** The owner's active account (no decryption, no Vercel call). */
  async activeAccount(ownerId: string): Promise<VercelActiveAccount | undefined> {
    const connection = await this.#repository.findActiveConnection(ownerId);
    if (!connection) return undefined;
    return {
      configurationId: connection.configurationId,
      accountId: connection.teamId ?? connection.vercelUserId,
      accountType: connection.teamId ? "team" : "personal",
      ...(connection.verification?.state === "OK" && connection.verification.displayName ? { displayName: connection.verification.displayName } : {}),
    };
  }

  /** True while this exact installation is still the owner's active connection (checked before consequential Vercel changes). */
  async isActiveConfiguration(ownerId: string, configurationId: string): Promise<boolean> {
    return (await this.#repository.findActiveConnection(ownerId))?.configurationId === configurationId;
  }

  /**
   * Issues a single-use state bound to the authenticated owner and, optionally,
   * to one of the owner's sites (the editor to return to). Older unused states
   * for the owner are invalidated, so stale or duplicate authorizations fail.
   */
  async start(
    ownerId: string,
    options: { readonly siteId?: unknown } = {},
  ): Promise<{ installUrl: string; expiresAt: string }> {
    const config = this.#requireConfig();
    const { siteId } = options;
    if (siteId !== undefined && !(await this.#ownsSite(ownerId, siteId)))
      throw new VercelIntegrationError("VERCEL_SITE_NOT_FOUND");
    const state = randomBytes(32).toString("base64url");
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + VERCEL_STATE_TTL_MS);
    const lifecycleId = hashState(state);
    await this.#repository.createState({
      stateHash: hashState(state),
      ownerId,
      ...(isSiteId(siteId) ? { siteId } : {}),
      createdAt,
      expiresAt,
      lifecycleId,
    });
    // Single owner-row mutation defines the ordering of concurrent starts.
    await this.#repository.beginAuthorization(ownerId, lifecycleId, createdAt);
    const installUrl = new URL(
      `https://vercel.com/integrations/${encodeURIComponent(config.slug)}/new`,
    );
    installUrl.searchParams.set("state", state);
    return { installUrl: installUrl.toString(), expiresAt: expiresAt.toISOString() };
  }

  /**
   * Handles the Vercel Redirect URL. The owner (and return site) come only from
   * the consumed state; nothing in the callback query can select a different
   * user or site.
   */
  async complete(
    query: URLSearchParams,
  ): Promise<{ ownerId: string; configurationId: string; siteId?: string }> {
    const result = this.#config();
    if (!result.configured) throw fail("not_configured");
    const config = result.config;

    const single = (name: string) => {
      const values = query.getAll(name);
      if (values.length > 1) throw fail("invalid_request");
      return values[0];
    };
    const state = single("state");
    const code = single("code");
    const configurationId = single("configurationId");
    const teamId = single("teamId") ?? null;
    if (!state) throw fail("state_missing");
    if (!CALLBACK_PATTERNS.state.test(state)) throw fail("invalid_request");

    // Consumed first so a replayed or cancelled callback can never exchange
    // later; the consumed state also identifies where to return.
    const consumed = await this.#repository.consumeState(hashState(state), this.#now());
    if (!consumed?.lifecycleId || !(await this.#repository.isCurrentAuthorization(consumed.ownerId, consumed.lifecycleId))) throw fail("state_invalid");
    const { ownerId } = consumed;
    const context: VercelReturnContext = consumed;
    // A callback without a code means the user did not finish authorizing.
    if (!code) throw fail("cancelled", context);
    if (
      !CALLBACK_PATTERNS.code.test(code) ||
      !configurationId ||
      !CALLBACK_PATTERNS.configurationId.test(configurationId) ||
      (teamId !== null && !CALLBACK_PATTERNS.teamId.test(teamId))
    )
      throw fail("invalid_request", context);

    const exchange = await this.#oauth
      .exchangeCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri: config.redirectUri,
      })
      .catch(() => {
        throw fail("exchange_failed", context);
      });
    if (exchange.installationId !== configurationId || exchange.teamId !== teamId)
      throw fail("installation_mismatch", context);

    const existing = await this.#repository.findConnectionByConfiguration(configurationId);
    if (existing && existing.ownerId !== ownerId) throw fail("configuration_conflict", context);
    const previous = await this.#repository.findActiveConnection(ownerId);

    const now = this.#now();
    try {
      const saved = await this.#repository.saveConnection({
        ownerId,
        configurationId,
        vercelUserId: exchange.userId,
        teamId: exchange.teamId,
        tokenType: exchange.tokenType,
        encryptedAccessToken: encryptVercelToken(config.encryptionKey, exchange.accessToken, {
          ownerId,
          configurationId,
        }),
        status: "active",
        connectedAt: now,
        updatedAt: now,
      }, consumed.lifecycleId);
      if (!saved) throw fail("state_invalid", context);
    } catch (error) {
      if (error instanceof VercelIntegrationError) throw error;
      throw fail(
        error instanceof VercelConfigurationConflictError
          ? "configuration_conflict"
          : "storage_failed",
        context,
      );
    }

    // One connection per user: release the replaced installation on Vercel.
    if (previous && previous.configurationId !== configurationId && await this.#repository.isCurrentAuthorization(ownerId, consumed.lifecycleId))
      await this.#removeRemote(config, previous).catch(() => false);
    return consumed.siteId
      ? { ownerId, configurationId, siteId: consumed.siteId }
      : { ownerId, configurationId };
  }

  /**
   * Decrypts the owner's token for a server-side Vercel call. Fails closed when
   * the integration is unconfigured, the owner has no active connection, or the
   * stored token cannot be authenticated (key rotated, record tampered with).
   */
  async credentials(ownerId: string): Promise<VercelCredentials> {
    const config = this.#requireConfig();
    const connection = await this.#repository.findActiveConnection(ownerId);
    if (!connection) throw new VercelIntegrationError("VERCEL_NOT_CONNECTED");
    let accessToken: string;
    try {
      accessToken = decryptVercelToken(config.encryptionKey, connection.encryptedAccessToken, connection);
    } catch {
      throw new VercelIntegrationError("VERCEL_TOKEN_UNAVAILABLE");
    }
    if (!accessToken) throw new VercelIntegrationError("VERCEL_TOKEN_UNAVAILABLE");
    return {
      ownerId,
      configurationId: connection.configurationId,
      teamId: connection.teamId,
      vercelUserId: connection.vercelUserId,
      accessToken,
    };
  }

  /**
   * Disconnects the owner's Vercel account:
   *   1. refuses while publishes are running unless the caller confirmed it;
   *   2. invalidates the owner's outstanding OAuth states;
   *   3. erases the stored token locally (atomic, only for this exact
   *      installation, so a concurrent reconnect is never undone);
   *   4. then asks Vercel to remove the installation with the in-memory token,
   *      reporting CONFIRMED only when Vercel confirmed it.
   * Running publishes stop before their next Vercel change. Vercel projects,
   * deployments, live sites and AI Sites publication records are untouched.
   */
  async disconnect(ownerId: string, options: { readonly allowActivePublishing?: boolean } = {}): Promise<VercelDisconnectResult> {
    const connection = await this.#repository.findActiveConnection(ownerId);
    let running: number;
    try {
      if (!this.#activePublishes) throw new Error("Missing activity check");
      running = await this.#activePublishes(ownerId);
      if (!Number.isSafeInteger(running) || running < 0) throw new Error("Incomplete activity check");
    } catch { throw new VercelIntegrationError("VERCEL_DISCONNECT_UNAVAILABLE"); }
    if (running > 0 && options.allowActivePublishing !== true) throw new VercelIntegrationError("VERCEL_DISCONNECT_BLOCKED");
    if (!connection) {
      await this.#repository.invalidatePendingAuthorization(ownerId);
      return { disconnected: false, remoteRevoked: false, revocation: "NOT_ATTEMPTED", interruptedPublishes: 0 };
    }
    const result = this.#config();
    let accessToken: string | undefined;
    if (result.configured)
      try {
        accessToken = decryptVercelToken(result.config.encryptionKey, connection.encryptedAccessToken, connection);
      } catch {
        accessToken = undefined;
      }
    const now = this.#now();
    const disconnected = await this.#repository.markDisconnected(ownerId, connection.configurationId, now, connection.encryptedAccessToken);
    // Lost a race (already disconnected or replaced by a new authorization): leave Vercel alone.
    if (!disconnected) return { disconnected: false, remoteRevoked: false, revocation: "NOT_ATTEMPTED", interruptedPublishes: 0 };
    const remoteRevoked = accessToken
      ? await this.#oauth.removeConfiguration({ accessToken, configurationId: connection.configurationId, teamId: connection.teamId }).catch(() => false)
      : false;
    console.info(`[sites][vercel] disconnected owner connection revocation=${remoteRevoked ? "confirmed" : "not_confirmed"} running_publishes=${running}`);
    return { disconnected: true, remoteRevoked, revocation: remoteRevoked ? "CONFIRMED" : "NOT_CONFIRMED", interruptedPublishes: running };
  }

  async #removeRemote(
    config: VercelIntegrationConfig,
    connection: {
      ownerId: string;
      configurationId: string;
      teamId: string | null;
      encryptedAccessToken: string;
    },
  ): Promise<boolean> {
    const accessToken = decryptVercelToken(
      config.encryptionKey,
      connection.encryptedAccessToken,
      connection,
    );
    return this.#oauth.removeConfiguration({
      accessToken,
      configurationId: connection.configurationId,
      teamId: connection.teamId,
    });
  }

  /**
   * Browser destination after the callback; carries only fixed reason codes.
   * The editor path is used only for a site taken from the consumed state that
   * the same owner still owns; otherwise the configured Sites page is used.
   */
  async returnLocation(
    outcome: { ok: true } | { ok: false; reason: VercelCallbackFailure },
    context?: VercelReturnContext,
  ): Promise<string | undefined> {
    const result = this.#config();
    if (!result.configured) return undefined;
    const url = new URL(result.config.returnUrl);
    if (context?.siteId && (await this.#ownsSite(context.ownerId, context.siteId)))
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(context.siteId)}`;
    url.searchParams.set("vercel", outcome.ok ? "connected" : "error");
    if (!outcome.ok) url.searchParams.set("reason", outcome.reason);
    return url.toString();
  }
}

export const createVercelConnectionService = (
  connection: Connection,
  siteOwnership?: SiteOwnershipCheck,
  activePublishes?: (ownerId: string) => Promise<number>,
) =>
  new VercelConnectionService({
    repository: new MongoVercelIntegrationRepository(connection),
    verifier: createVercelAccountVerifier(),
    ...(siteOwnership ? { siteOwnership } : {}),
    activePublishes: activePublishes ?? ((ownerId) => countVercelPublishingActivity(connection, ownerId)),
  });
