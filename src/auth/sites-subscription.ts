import { ApplicationError } from "../app/errors/application-error.js";
import type { AuthenticatedUser, GetChatlySubscriptionRecord } from "./identity-repository.js";

type SubscriptionIdentity = {
  readonly subscription?: GetChatlySubscriptionRecord;
};

export function isSitesSubscriptionEligible(user: SubscriptionIdentity | undefined): boolean {
  const subscription = user?.subscription;
  const paidPlan =
    typeof subscription?.plan_type === "string" &&
    subscription.plan_type.length > 0 &&
    subscription.plan_type !== "free";
  return (
    paidPlan &&
    ((subscription.payment_status === "active" && subscription.is_active === true) ||
      subscription.payment_status === "canceled")
  );
}

export function requireSitesSubscription(user: AuthenticatedUser | undefined): void {
  if (!isSitesSubscriptionEligible(user))
    throw new ApplicationError(
      "SUBSCRIPTION_REQUIRED",
      "A paid subscription is required to use Sites.",
    );
}
