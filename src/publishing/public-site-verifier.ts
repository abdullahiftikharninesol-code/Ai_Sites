import { createHash } from "node:crypto";
import type { PreparedArtifactDocument } from "./static-artifact.js";

/**
 * Proves the public production URL serves exactly the prepared artifact:
 *   - entry:          "/" returns index.html, byte identical (SHA-256);
 *   - asset:          the critical scripts/stylesheets index.html loads;
 *   - route-fallback: (history routing) the site's own client routes and
 *                     synthetic nested paths, requested directly as a refresh
 *                     or a shared link would, return index.html exactly;
 *   - missing-asset:  a missing script is a 404, never the app's HTML.
 * Limitation: these prove what the server answers. Whether the browser then
 * renders the right page is client-side behavior, checked by Browser QA on
 * the saved version, not here (no browser runs against the live site).
 * Requests go only to the Vercel-assigned hostname over HTTPS, never follow
 * redirects, and read bounded bodies.
 */
export type PublicCheckKind = "entry" | "asset" | "route-fallback" | "missing-asset";
export interface PublicCheck {
  readonly path: string;
  readonly ok: boolean;
  readonly kind?: PublicCheckKind;
  readonly detail?: string;
}
export interface PublicVerificationResult {
  readonly ok: boolean;
  /** Set when not ok: PROTECTED (401/403), MISMATCH, UNREACHABLE. */
  readonly reason?: "PROTECTED" | "MISMATCH" | "UNREACHABLE";
  readonly checks: readonly PublicCheck[];
  /** What was proven: direct-access routes checked, and that browser rendering is not part of this check. */
  readonly coverage?: { readonly routing: string; readonly routes: readonly string[]; readonly serverFallback: boolean; readonly clientRendering: "NOT_VERIFIED" };
}

/** Synthetic nested paths no site defines: they must reach the app through the SPA fallback. */
export const SYNTHETIC_DEEP_LINKS = ["/__ai-sites-verify/deep/link", "/__ai-sites-verify/a/b/c/d/"];
export const MISSING_ASSET_PROBE = "/assets/__ai-sites-verify-missing.js";
export interface PublicVerifierOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  readonly maxAssets?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A safe public origin from a Vercel alias hostname, or undefined. */
export function publicOriginFor(host: string): string | undefined {
  const value = host.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return HOSTNAME.test(value) ? `https://${value}` : undefined;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Local scripts, module preloads and stylesheets index.html loads. */
function criticalAssets(index: string, available: ReadonlySet<string>, max: number): string[] {
  const found = new Set<string>();
  for (const match of index.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const isLink = match[1]!.toLowerCase() === "link";
    if (isLink && !/\brel\s*=\s*["']?(?:stylesheet|modulepreload)\b/i.test(tag)) continue;
    const ref = new RegExp(`\\s${isLink ? "href" : "src"}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
    if (!ref || !ref.startsWith("/") || ref.startsWith("//")) continue;
    const path = ref.split(/[?#]/)[0]!.slice(1);
    if (available.has(path)) found.add(path);
    if (found.size >= max) break;
  }
  return [...found];
}

export async function verifyPublicDeployment(
  origin: string,
  artifact: PreparedArtifactDocument,
  options: PublicVerifierOptions = {},
): Promise<PublicVerificationResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const attempts = Math.max(1, options.attempts ?? 6);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const files = new Map(artifact.files.map((file) => [file.path, file]));
  const index = files.get("index.html");
  if (!index) return { ok: false, reason: "MISMATCH", checks: [{ path: "/", kind: "entry", ok: false, detail: "artifact has no index.html" }] };
  const indexText = Buffer.from(index.contentBase64, "base64").toString("utf8");
  const history = artifact.routing === "history";
  const routes = history ? (artifact.routes ?? []).filter((route) => !files.has(route.replace(/^\//, ""))).slice(0, 3) : [];
  type Target = { path: string; kind: PublicCheckKind; expected?: { sha256: string; sizeBytes: number } };
  const targets: Target[] = [
    { path: "/", kind: "entry", expected: index },
    ...criticalAssets(indexText, new Set(files.keys()), options.maxAssets ?? 8).map((path): Target => ({ path: `/${path}`, kind: "asset", expected: files.get(path)! })),
    // Direct requests for client routes (a refresh or shared link) must be answered with the app itself.
    ...(history ? [...routes, ...SYNTHETIC_DEEP_LINKS].map((path): Target => ({ path, kind: "route-fallback", expected: index })) : []),
    // A missing file must stay a 404: never the app's HTML in place of a script.
    { path: MISSING_ASSET_PROBE, kind: "missing-asset" },
  ];
  const coverage = { routing: artifact.routing, routes, serverFallback: history, clientRendering: "NOT_VERIFIED" as const };

  let last: PublicVerificationResult = { ok: false, reason: "UNREACHABLE", checks: [] };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    const checks: PublicCheck[] = [];
    let reason: PublicVerificationResult["reason"];
    for (const target of targets) {
      options.signal?.throwIfAborted();
      try {
        const response = await fetchImpl(`${origin}${target.path}`, {
          redirect: "manual",
          headers: { "cache-control": "no-cache" },
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]) : AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        if (response.status === 401 || response.status === 403) {
          checks.push({ path: target.path, kind: target.kind, ok: false, detail: `HTTP ${response.status}` });
          reason = "PROTECTED";
          break;
        }
        if (!target.expected) {
          // missing-asset: only a real "not found" is correct; a 200 means something answered for a file that doesn't exist.
          await response.body?.cancel().catch(() => undefined);
          const ok = response.status === 404 || response.status === 410;
          checks.push({ path: target.path, kind: target.kind, ok, ...(ok ? {} : { detail: `HTTP ${response.status} for a file that does not exist` }) });
          if (!ok) reason = "MISMATCH";
          continue;
        }
        if (response.status !== 200) {
          checks.push({ path: target.path, kind: target.kind, ok: false, detail: `HTTP ${response.status}` });
          // A client route answered 404 means the deployment has no SPA fallback: the content is wrong, not unreachable.
          reason = target.kind === "route-fallback" && response.status === 404 ? "MISMATCH" : (reason ?? "UNREACHABLE");
          continue;
        }
        const body = await readCapped(response, target.expected.sizeBytes + 1024);
        const ok = !!body && sha256(body) === target.expected.sha256;
        checks.push({ path: target.path, kind: target.kind, ok, ...(ok ? {} : { detail: "content differs from the prepared build" }) });
        if (!ok) reason = "MISMATCH";
      } catch {
        checks.push({ path: target.path, kind: target.kind, ok: false, detail: "request failed" });
        reason ??= "UNREACHABLE";
      }
    }
    last = reason ? { ok: false, reason, checks, coverage } : { ok: true, checks, coverage };
    // Deployment Protection will not clear by waiting.
    if (last.ok || reason === "PROTECTED") return last;
    if (attempt < attempts) await sleep(options.delayMs ?? 3_000);
  }
  return last;
}
