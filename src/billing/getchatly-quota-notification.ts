import type { SubscriberQuota, SubscriberQuotaRepository } from "./credit-billing.js";
import type {
  GetChatlyRedisGateway,
  RedisDeleteResult,
  RedisEmitResult,
  RedisWarningLogger,
} from "../redis/shared-redis.js";

export const GETCHATLY_QUOTA_EVENT = "userCreditQuota";
export const GETCHATLY_SOCKET_NAMESPACE = "/";

export interface GetChatlyQuotaUser {
  readonly subscription?: { readonly isActive?: boolean };
  readonly chatCount: number;
}

export interface GetChatlyQuotaUserRepository {
  findForQuotaNotification(userId: string): Promise<GetChatlyQuotaUser | undefined>;
}

export interface UserCreditQuotaPayload extends Readonly<Record<string, unknown>> {
  readonly _id: unknown;
  readonly user: unknown;
  readonly type: string;
  readonly count: number;
  readonly limit: number;
  readonly chat_request_tokens: number;
  readonly chat_response_tokens: number;
  readonly is_credit_implemented: boolean;
  readonly token_credit: number;
  readonly token_credit_used: number;
  readonly model_credit_list: readonly unknown[];
  readonly is_premium: boolean;
  readonly chat_count: number;
}

export interface QuotaNotificationResult {
  readonly payloadLoaded: boolean;
  readonly cache: RedisDeleteResult;
  readonly event: RedisEmitResult;
}

export interface QuotaChangeNotifier {
  notifyGetChatlyQuotaChanged(userId: string): Promise<QuotaNotificationResult>;
}

export function resolveGetChatlyCacheEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return env.REDIS_CACHE_ENV || env.NODE_ENV || "development";
}

export function getGetChatlyInitialDataCacheKeys(
  userId: unknown,
  cacheEnvironment = resolveGetChatlyCacheEnvironment(),
): readonly [string, string] {
  const normalizedUserId = String(userId);
  return [
    `cache:${cacheEnvironment}:initial_data:${normalizedUserId}`,
    `cache:initial_data:${normalizedUserId}`,
  ];
}

export function buildUserCreditQuotaPayload(
  quota: SubscriberQuota,
  user: GetChatlyQuotaUser,
): UserCreditQuotaPayload {
  return {
    _id: quota.id,
    user: quota.user,
    type: quota.type,
    count: quota.count,
    limit: quota.limit,
    chat_request_tokens: quota.chatRequestTokens,
    chat_response_tokens: quota.chatResponseTokens,
    is_credit_implemented: quota.isCreditImplemented,
    token_credit: quota.tokenCredit,
    token_credit_used: quota.tokenCreditUsed,
    model_credit_list: quota.modelCreditList,
    is_premium: Boolean(user.subscription?.isActive),
    chat_count: user.chatCount,
  };
}

/** Read the authoritative quota and user counters without emitting another event. */
export async function readUserCreditQuotaPayload(
  quotas: SubscriberQuotaRepository,
  users: GetChatlyQuotaUserRepository,
  userId: string,
): Promise<UserCreditQuotaPayload | undefined> {
  const [quota, user] = await Promise.all([
    quotas.findForUser(userId),
    users.findForQuotaNotification(userId),
  ]);
  return quota && user ? buildUserCreditQuotaPayload(quota, user) : undefined;
}

export function invalidateGetChatlyInitialDataCache(
  redis: GetChatlyRedisGateway,
  userId: unknown,
  cacheEnvironment: string,
): Promise<RedisDeleteResult> {
  return redis.deleteExactKeys(getGetChatlyInitialDataCacheKeys(userId, cacheEnvironment));
}

/** Best-effort bridge from durable Sites billing to GetChatly's existing UI contract. */
export class GetChatlyQuotaNotificationService implements QuotaChangeNotifier {
  constructor(
    private readonly quotas: SubscriberQuotaRepository,
    private readonly users: GetChatlyQuotaUserRepository,
    private readonly redis: GetChatlyRedisGateway,
    private readonly cacheEnvironment: string,
    private readonly logger: RedisWarningLogger = console,
  ) {}

  async notifyGetChatlyQuotaChanged(userId: string): Promise<QuotaNotificationResult> {
    let payload: UserCreditQuotaPayload | undefined;
    try {
      payload = await readUserCreditQuotaPayload(this.quotas, this.users, userId);
      if (!payload) throw new Error("Fresh GetChatly quota payload data is unavailable");
    } catch {
      this.logger.warn(
        "[sites][billing] unable to load fresh GetChatly quota payload; event skipped",
      );
    }

    let cache: RedisDeleteResult = { attempted: false, deletedKeys: 0 };
    try {
      cache = await invalidateGetChatlyInitialDataCache(this.redis, userId, this.cacheEnvironment);
    } catch {
      this.logger.warn("[sites][billing] GetChatly initial-data cache invalidation failed");
    }

    let event: RedisEmitResult = { attempted: false };
    if (payload) {
      try {
        event = await this.redis.emit(
          GETCHATLY_SOCKET_NAMESPACE,
          String(userId),
          GETCHATLY_QUOTA_EVENT,
          payload,
        );
      } catch {
        this.logger.warn("[sites][billing] GetChatly userCreditQuota emission failed");
      }
    }
    return { payloadLoaded: payload !== undefined, cache, event };
  }
}
