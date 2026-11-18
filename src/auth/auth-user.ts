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

/** undefined: absent/empty; null: malformed or ambiguous. Inspect raw fields before Node's duplicate-header normalization. */
function bearerCredential(req: AuthenticatedRequest): string | null | undefined {
  const header = req.headers.authorization;
  if (header !== undefined && typeof header !== "string") return null;
  if (req.rawHeaders !== undefined) {
    if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2 !== 0) return null;
    let count = 0, raw: string | undefined;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i], value = req.rawHeaders[i + 1];
      if (typeof name !== "string" || typeof value !== "string") return null;
      if (name.toLowerCase() === "authorization") { count++; raw = value; }
    }
    if (count > 1 || raw !== header) return null;
  }
  if (header === undefined || /^[ \t]*(?:Bearer[ \t]*)?$/i.test(header)) return undefined;
  // HTTP field OWS may surround the value; Bearer credentials require one or more SP separators, never HTAB.
  const match = /^[ \t]*Bearer +([A-Za-z0-9._~+/-]+=*)[ \t]*$/i.exec(header);
  return match?.[0] === header ? match[1]! : null;
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
      const token = bearerCredential(req);
      if (token === undefined) return sendResponse(res, 401, "No Token. Access Denied", false);
      if (token === null) return sendResponse(res, 401, "Invalid Authorization. Access Denied", false);

      const secret = jwtKey();
      if (!secret) {
        console.error("[sites][auth] JWTKEY is not configured; rejecting authenticated request");
        return sendResponse(res, 500, "Internal Server Error", false);
      }

      let decodedUser: unknown;
      try {
        decodedUser = jwt.verify(token, secret, { algorithms: ["HS256"] });
        const exp = decodedUser && typeof decodedUser === "object" ? (decodedUser as { exp?: unknown }).exp : undefined;
        if (typeof exp !== "number" || !Number.isFinite(exp))
          return sendResponse(res, 401, "Invalid Authorization. Access Denied", false);
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
