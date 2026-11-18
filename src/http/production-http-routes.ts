import type { ServerResponse } from "node:http";
import type { AuthenticatedRequest } from "../auth/auth-user.js";
import { VERCEL_CALLBACK_PATH } from "../integrations/vercel/vercel-integration-config.js";

export const PRODUCTION_METHODS = ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] as const;
export const PRODUCTION_HEADERS = ["authorization", "content-type", "x-sites-file-name"] as const;
export const JSON_BODY_LIMIT = 64_000;
export const UPLOAD_BODY_LIMIT = 10 * 1024 * 1024;
interface PublicContext {
  readonly request: AuthenticatedRequest;
  readonly response: ServerResponse;
  readonly url: URL;
}
export interface ProductionRouteContext extends PublicContext {
  /** Derived only by authUser/ownerIdOf. Every future service lookup must be scoped to this owner. */
  readonly ownerId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | Uint8Array | undefined;
}
export type ProductionRoute = {
  readonly access: "authenticated";
  readonly method: Exclude<typeof PRODUCTION_METHODS[number], "OPTIONS">;
  readonly path: string;
  readonly body?: "json" | "bytes";
  readonly handle: (context: ProductionRouteContext) => void | Promise<void>;
} | {
  /** Exact, GET-only exception. Future handler must verify single-use state; currently not mounted. */
  readonly access: "oauth-callback";
  readonly method: "GET";
  readonly path: typeof VERCEL_CALLBACK_PATH;
  readonly handle: (context: PublicContext) => void | Promise<void>;
};

/** Frozen registrations: authenticated paths may use named single segments; public paths remain exact. */
export function productionRoutes(routes: readonly ProductionRoute[] = []): readonly ProductionRoute[] {
  const keys = new Set<string>();
  return Object.freeze(routes.map(route => {
    const url = new URL(route.path, "http://local");
    if (!route.path.startsWith("/") || url.origin !== "http://local" || url.pathname !== route.path ||
      !PRODUCTION_METHODS.includes(route.method) || route.method === ("OPTIONS" as string) ||
      ["/healthz", "/readyz"].includes(route.path) || typeof route.handle !== "function") throw new Error("Invalid production route");
    if (route.access !== "authenticated" && (route.access !== "oauth-callback" || route.method !== "GET" || route.path !== VERCEL_CALLBACK_PATH))
      throw new Error("Invalid public production route");
    if (route.access === "authenticated" && route.body !== undefined &&
      (!["json", "bytes"].includes(route.body) || ["GET", "HEAD"].includes(route.method))) throw new Error("Invalid production route body");
    const segments = route.path.split("/");
    const params = segments.filter(segment => segment.startsWith(":"));
    if (params.some(param => !/^:[A-Za-z][A-Za-z0-9_]*$/.test(param)) || new Set(params).size !== params.length ||
      (route.access !== "authenticated" && params.length)) throw new Error("Invalid route parameters");
    const key = `${route.method} ${segments.map(segment => segment.startsWith(":") ? ":" : segment).join("/")}`;
    if (keys.has(key)) throw new Error("Duplicate production route");
    keys.add(key);
    return Object.freeze({ ...route });
  }));
}

/** No prefix matching or arbitrary regular expressions. Invalid/encoded separators never become parameters. */
export function matchProductionRoute(route: ProductionRoute, method: string, path: string): Readonly<Record<string, string>> | undefined {
  if (route.method !== method) return undefined;
  const expected = route.path.split("/"), actual = path.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index]!;
    if (!segment.startsWith(":")) { if (segment !== value) return undefined; continue; }
    try {
      const decoded = decodeURIComponent(value);
      if (!decoded || decoded.length > 200 || /[\\/]/.test(decoded) || decoded.includes("\0") || decoded === "." || decoded === "..") return undefined;
      Object.defineProperty(params, segment.slice(1), { value: decoded, enumerable: true });
    } catch { return undefined; }
  }
  return Object.freeze(params);
}

export async function readProductionBody(request: AuthenticatedRequest, kind: "json" | "bytes", limit?: number) {
  const maximum = Math.min(limit ?? Infinity, kind === "json" ? JSON_BODY_LIMIT : UPLOAD_BODY_LIMIT);
  const tooLarge = () => Object.assign(new Error("Request is too large"), { code: "REQUEST_TOO_LARGE" });
  const length = Number(request.headers["content-length"]);
  let exceeded = Number.isFinite(length) && length > maximum;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    if (!exceeded && (size += bytes.length) > maximum) exceeded = true;
    if (exceeded) chunks.length = 0;
    else chunks.push(bytes);
  }
  // Drain without retaining oversized data before replying, avoiding a TCP reset during an upload.
  // The server's request deadline bounds the receive time.
  if (exceeded) throw tooLarge();
  const bytes = Buffer.concat(chunks);
  if (kind === "bytes") return new Uint8Array(bytes);
  if (!bytes.length) return {};
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value as Readonly<Record<string, unknown>>;
  } catch { throw Object.assign(new Error("Invalid request"), { code: "INVALID_REQUEST" }); }
}
