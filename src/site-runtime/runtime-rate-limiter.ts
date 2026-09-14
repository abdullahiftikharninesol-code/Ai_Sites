import { ApplicationError } from "../app/errors/application-error.js";
export interface RuntimeRateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}
export class LocalRuntimeRateLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly config: RuntimeRateLimitConfig = { maxRequests: 30, windowMs: 60_000 },
    private readonly now: () => number = Date.now,
  ) {}
  consume(key: string): void {
    const current = this.now();
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      this.#buckets.set(key, { count: 1, resetAt: current + this.config.windowMs });
      return;
    }
    if (bucket.count >= this.config.maxRequests)
      throw new ApplicationError("RUNTIME_RATE_LIMITED", "Runtime request rate limit exceeded");
    bucket.count += 1;
  }
}
