import type { AuthenticatedRequest } from "./auth-user.js";

/**
 * GetChatly `ownerIdOf(req)` (presentationRouter.js). Ownership comes only from
 * the authenticated `req.user`, never from the body, query or headers.
 */
export function ownerIdOf(req: AuthenticatedRequest): string | null {
  const user = req.user as { _id?: { toString(): string }; id?: unknown } | undefined;
  return user?._id?.toString() || (typeof user?.id === "string" ? user.id : null) || null;
}
