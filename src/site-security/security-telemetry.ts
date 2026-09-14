export interface SecurityMetrics {
  signupAttempts: number;
  signupSuccesses: number;
  signupFailures: number;
  loginAttempts: number;
  loginSuccesses: number;
  loginFailures: number;
  logoutCount: number;
  sessionValidations: number;
  authRateLimited: number;
  deniedOperations: number;
  ownerViolations: number;
  actionAttempts: number;
  actionSuccesses: number;
  actionFailures: number;
  actionRateLimited: number;
  csrfRejected: number;
  originRejected: number;
}
const empty = (): SecurityMetrics => ({
  signupAttempts: 0,
  signupSuccesses: 0,
  signupFailures: 0,
  loginAttempts: 0,
  loginSuccesses: 0,
  loginFailures: 0,
  logoutCount: 0,
  sessionValidations: 0,
  authRateLimited: 0,
  deniedOperations: 0,
  ownerViolations: 0,
  actionAttempts: 0,
  actionSuccesses: 0,
  actionFailures: 0,
  actionRateLimited: 0,
  csrfRejected: 0,
  originRejected: 0,
});
export class LocalSecurityTelemetry {
  readonly #bySite = new Map<string, SecurityMetrics>();
  increment(siteId: string, key: keyof SecurityMetrics): void {
    const current = this.#bySite.get(siteId) ?? empty();
    this.#bySite.set(siteId, { ...current, [key]: current[key] + 1 });
  }
  summary(siteId: string): SecurityMetrics {
    return { ...(this.#bySite.get(siteId) ?? empty()) };
  }
}
