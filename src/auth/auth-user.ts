import type { IncomingMessage, ServerResponse } from "node:http";
import jwt from "jsonwebtoken";
import type { AuthenticatedUser, IdentityRepository } from "./identity-repository.js";
import { sendResponse } from "./send-response.js";

export type AuthenticatedRequest = IncomingMessage & { user?: AuthenticatedUser };
export type AuthUserMiddleware = (
  req: AuthenticatedRequest,
  res: ServerResponse,
  next: () => void | Promise<void>,
) => Promise<void>;

export interface AuthUserOptions {
  readonly identities: IdentityRepository;
  /** Read per request so a missing JWTKEY can never be cached as a fallback. */
  readonly jwtKey?: () => string | undefined;
}

/**
 * GetChatly `authUser` (src/middleware/authentication.middleware.js) for the
 * Sites node:http server. It establishes identity only; resource ownership is
 * enforced by the Sites service queries.
 */
export function createAuthUser(options: AuthUserOptions): AuthUserMiddleware {
  const jwtKey = options.jwtKey ?? (() => process.env.JWTKEY);
  return async (req, res, next) => {
    try {
      const authorizationHeader = req.headers.authorization;
      const token = authorizationHeader ? authorizationHeader.slice(7) : null;
      if (!token) return sendResponse(res, 401, "No Token. Access Denied", false);

      const secret = jwtKey();
      if (!secret) {
        console.error("[sites][auth] JWTKEY is not configured; rejecting authenticated request");
        return sendResponse(res, 500, "Internal Server Error", false);
      }

      let decodedUser: unknown;
      try {
        decodedUser = jwt.verify(token, secret);
      } catch {
        return sendResponse(res, 401, "Invalid Authorization. Access Denied", false);
      }
      const userId =
        decodedUser && typeof decodedUser === "object"
          ? (decodedUser as { userId?: unknown }).userId
          : undefined;
      if (typeof userId !== "string" || !userId)
        return sendResponse(res, 401, "Authentication Failed!", false);

      const adminData = await options.identities.findAdmin(userId);
      if (adminData) {
        req.user = adminData;
      } else {
        const userData = await options.identities.findActiveUser(userId);
        if (!userData) return sendResponse(res, 401, "Authentication Failed!", false);
        if (userData.status === "blocked")
          return sendResponse(res, 401, "Account blocked. Authentication Failed!", false);
        req.user = userData;
      }
    } catch (error) {
      console.error("[sites][auth] authentication failed unexpectedly", {
        name: (error as { name?: unknown })?.name,
      });
      return sendResponse(res, 500, "Internal Server Error", false);
    }
    // Outside the try: a downstream handler failure is not an authentication error.
    await next();
  };
}
