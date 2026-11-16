import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { SiteArtifactSecurityScanner } from "../site-security/site-artifact-security-scanner.js";
import { PublishingError } from "./publishing-errors.js";
import { functionalSourceManifest } from "../sites/generation/functional-source-contract.js";

/**
 * Static production output of a verified site version, validated for upload
 * to a static host. Nothing here executes code or trusts a path from the
 * build: every entry is lstat'ed, links are refused and every path is
 * re-derived and checked against the output root.
 */
export interface StaticArtifactLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
}
export const DEFAULT_STATIC_ARTIFACT_LIMITS: StaticArtifactLimits = Object.freeze({
  maxFiles: 2_000,
  maxTotalBytes: 30 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxDepth: 16,
});

export interface StaticFile {
  /** Relative, forward-slash path inside the output root. */
  readonly path: string;
  readonly content: Buffer;
}

/** How the site routes: decides whether deep links need an index.html rewrite. */
export type SiteRoutingMode = "history" | "hash" | "none";

const invalid = (message: string, metadata?: Record<string, unknown>) =>
  new PublishingError("PUBLISH_ARTIFACT_INVALID", message, { metadata });

/**
 * Files a static deployment must never carry: they would turn the upload into
 * a server build (package.json), serverless functions (api/, middleware) or
 * override the generated platform configuration (vercel.json/now.json).
 */
const RESERVED_ROOT = /^(?:api|\.vercel|node_modules)(?:\/|$)|^(?:vercel\.json|now\.json|package\.json|package-lock\.json|_?middleware\.[cm]?[jt]sx?)$/i;
/** No control or Windows-reserved characters; no leading/trailing space or trailing dot. */
const isSafeSegment = (segment: string) =>
  !!segment &&
  !segment.startsWith(" ") &&
  !/[ .]$/.test(segment) &&
  !/[<>:"|?*\\/]/.test(segment) &&
  ![...segment].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** Validates one output path; returns it unchanged when it is safe. */
export function validateArtifactPath(path: string): string {
  if (!path || path.length > 1_024 || path.includes("\\") || path.startsWith("/"))
    throw invalid("Production output contains an unsafe path", { path: path.slice(0, 200) });
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.length > 255)
      throw invalid("Production output contains an unsafe path", { path });
    // Dot-files are only allowed under .well-known/ (e.g. security.txt).
    if (segment.startsWith(".") && !(segment === ".well-known" && segments[0] === ".well-known"))
      throw invalid("Production output contains a hidden file", { path });
    if (!isSafeSegment(segment))
      throw invalid("Production output contains an unsupported file name", { path });
  }
  if (posix.normalize(path) !== path) throw invalid("Production output contains an unsafe path", { path });
  if (RESERVED_ROOT.test(path))
    throw invalid("Production output contains a file reserved for the hosting platform", { path });
  return path;
}

/**
 * Reads a build output directory without following links. Fails on symlinks,
 * junctions, special files, paths outside the root and any exceeded bound.
 */
export async function collectStaticOutput(
  outputDirectory: string,
  workspaceRoot: string,
  limits: StaticArtifactLimits = DEFAULT_STATIC_ARTIFACT_LIMITS,
): Promise<StaticFile[]> {
  let rootInfo;
  try {
    rootInfo = await lstat(outputDirectory);
  } catch {
    throw invalid("The production build did not produce a dist directory");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw invalid("The production output directory is not a plain directory");
  const realRoot = await realpath(outputDirectory);
  const realWorkspace = await realpath(workspaceRoot);
  if (!isInside(realWorkspace, realRoot))
    throw invalid("The production output directory escapes the build workspace");

  const files: StaticFile[] = [];
  let totalBytes = 0;
  const stack: Array<{ directory: string; depth: number }> = [{ directory: realRoot, depth: 0 }];
  while (stack.length) {
    const { directory, depth } = stack.pop()!;
    if (depth > limits.maxDepth) throw invalid("Production output is nested too deeply");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const info = await lstat(full);
      const path = relative(realRoot, full).split(sep).join("/");
      // Node reports Windows junctions as symbolic links as well.
      if (info.isSymbolicLink()) throw invalid("Production output contains a link", { path });
      if (info.isDirectory()) {
        stack.push({ directory: full, depth: depth + 1 });
        continue;
      }
      if (!info.isFile()) throw invalid("Production output contains a special file", { path });
      validateArtifactPath(path);
      if (!isInside(realRoot, await realpath(full)))
        throw invalid("Production output contains a path outside the output directory", { path });
      if (files.length + 1 > limits.maxFiles)
        throw invalid(`Production output has more than ${limits.maxFiles} files`);
      if (info.size > limits.maxFileBytes)
        throw invalid("Production output contains a file that is too large", { path, sizeBytes: info.size });
      totalBytes += info.size;
      if (totalBytes > limits.maxTotalBytes)
        throw invalid(`Production output exceeds ${limits.maxTotalBytes} bytes`);
      files.push({ path, content: await readFile(full) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const isInside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Version of the generated hosting configuration. Bump it whenever
 * staticHostingConfig or routing detection changes, so artifacts are rebuilt
 * and earlier publications can be flagged for republishing.
 *   1: rewrites only for BrowserRouter / createBrowserRouter
 *   2: any path-based client routing (react-router or location.pathname), and
 *      missing files with an extension (or under /assets, /api) stay 404
 */
export const HOSTING_CONFIG_VERSION = 2;

const SOURCE_FILE = /^src\/.*\.[cm]?[jt]sx?$/;
const BROWSER_ROUTER = /\b(?:BrowserRouter|createBrowserRouter|HistoryRouter|unstable_HistoryRouter)\b/;
const HASH_ROUTER = /\b(?:HashRouter|createHashRouter)\b/;
const MEMORY_ROUTER = /\b(?:MemoryRouter|createMemoryRouter)\b/;
const PATHNAME = /\blocation\.pathname\b/;
const HISTORY_API = /\b(?:pushState|replaceState)\s*\(|["']popstate["']/;
const HASH_ROUTING = /\blocation\.hash\b/;
const HASH_EVENTS = /["']hashchange["']/;
/** A route that can be requested directly: static segments, no parameters, wildcards or file extensions. */
const PLAIN_ROUTE = /^\/[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*\/?$/;

export interface SiteRouting {
  readonly mode: SiteRoutingMode;
  /** Up to 5 static client routes resolved from the source's routing syntax (for direct-access verification). */
  readonly routes: readonly string[];
}

/** Static client routes, from the same AST analysis Browser QA trusts (never guessed from URLs or labels). */
function sourceRoutes(sources: readonly (readonly [string, string])[]): string[] {
  try {
    const manifest = functionalSourceManifest({ files: sources.map(([path, content]) => ({ path, content })) });
    return [...new Set(manifest.routes.map((route) => route.path))].filter((path) => path !== "/" && PLAIN_ROUTE.test(path)).sort().slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * How the site routes, from its saved source:
 *   history: client routes are real URL paths (react-router browser routers,
 *            or a router reading location.pathname), so a direct request for
 *            a nested path must be answered with the app (SPA fallback);
 *   hash:    routes live after "#", the server only ever sees "/";
 *   none:    no client routing.
 * Mixed signals resolve to history: a fallback never breaks hash routing,
 * while a missing one makes every directly opened nested page a 404.
 */
export function analyzeSiteRouting(sourceFiles: Readonly<Record<string, string>>): SiteRouting {
  const sources = Object.entries(sourceFiles).filter(([path]) => SOURCE_FILE.test(path));
  const text = sources.map(([, content]) => content).join("\n");
  const routes = sourceRoutes(sources);
  const pathRouter = PATHNAME.test(text) && (HISTORY_API.test(text) || routes.length > 0);
  if (BROWSER_ROUTER.test(text) || pathRouter) return { mode: "history", routes };
  if (HASH_ROUTER.test(text) || (HASH_ROUTING.test(text) && HASH_EVENTS.test(text))) return { mode: "hash", routes: [] };
  // Path routes resolved from routing syntax under a router named differently (never a memory router).
  if (routes.length && !MEMORY_ROUTER.test(text)) return { mode: "history", routes };
  return { mode: "none", routes: [] };
}

/** Routing mode from the saved source (path-based client routing needs deep-link rewrites). */
export function detectRoutingMode(sourceFiles: Readonly<Record<string, string>>): SiteRoutingMode {
  return analyzeSiteRouting(sourceFiles).mode;
}

/**
 * The SPA fallback: any path without a file extension, outside /assets and
 * /api, is answered with index.html. Vercel serves existing files before
 * rewrites, so real files always win; a missing script, stylesheet, image or
 * other file (anything with an extension) stays a real 404 instead of HTML.
 */
export const SPA_FALLBACK_SOURCE = "/((?!assets/|api/)(?!.*\\.[A-Za-z0-9]+$).*)";

/**
 * Platform configuration generated for the artifact (never taken from the
 * build). Vercel serves existing files before applying rewrites, so the
 * rewrite only affects unknown paths; hashed assets keep a real 404.
 */
export function staticHostingConfig(routing: SiteRoutingMode): StaticFile {
  const config = {
    ...(routing === "history"
      ? { rewrites: [{ source: SPA_FALLBACK_SOURCE, destination: "/index.html" }] }
      : {}),
    headers: [
      {
        source: "/assets/(.*)",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ],
  };
  return { path: "vercel.json", content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`) };
}

export interface StaticArtifactSummary {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly scripts: number;
  readonly stylesheets: number;
  readonly images: number;
  readonly fonts: number;
  readonly referencesChecked: number;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const FONT = /\.(?:woff2?|ttf|otf|eot)$/i;
const ASSET_REL = new Set(["stylesheet", "icon", "shortcut icon", "apple-touch-icon", "modulepreload", "preload", "manifest", "mask-icon"]);

/** Local file a reference points to, or undefined for external/data/fragment references. */
function resolveReference(from: string, reference: string): string | undefined {
  const value = reference.trim().replace(/&amp;/g, "&");
  if (!value || EXTERNAL.test(value)) return undefined;
  const clean = value.split(/[?#]/)[0]!;
  if (!clean) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    throw invalid("Production output contains a malformed reference", { from, reference: value.slice(0, 200) });
  }
  const joined = decoded.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(from), decoded);
  const normalized = posix.normalize(joined);
  if (normalized.startsWith("../") || normalized === "..")
    throw invalid("Production output references a file outside the site", { from, reference: value.slice(0, 200) });
  return normalized === "." ? "index.html" : normalized.replace(/\/$/, "/index.html");
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/**
 * Checks the output is a complete static site: index.html exists, loads at
 * least one local module script, and every local script, stylesheet, image,
 * font and preload it (or a stylesheet/chunk) references is present. For
 * history routing the entry HTML must use root-absolute asset paths, or deep
 * links like /menu/item would resolve assets under the wrong directory.
 */
export function validateStaticArtifact(
  files: readonly StaticFile[],
  routing: SiteRoutingMode,
): StaticArtifactSummary {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const index = byPath.get("index.html");
  if (!index || !index.content.length) throw invalid("The production build has no index.html");
  const missing = new Set<string>();
  let referencesChecked = 0;
  const check = (from: string, reference: string) => {
    const target = resolveReference(from, reference);
    if (!target) return;
    referencesChecked++;
    if (!byPath.has(target)) missing.add(`${from} -> ${target}`);
  };

  let indexScripts = 0;
  for (const file of files) {
    if (/\.html?$/i.test(file.path)) {
      const html = file.content.toString("utf8");
      for (const match of html.matchAll(/<(script|link|img|source|video|audio)\b[^>]*>/gi)) {
        const tag = match[0];
        const name = match[1]!.toLowerCase();
        const refs: string[] = [];
        if (name === "script") {
          const src = attribute(tag, "src");
          if (src !== undefined) {
            refs.push(src);
            if (file.path === "index.html" && !EXTERNAL.test(src.trim())) indexScripts++;
          }
        } else if (name === "link") {
          const rel = (attribute(tag, "rel") ?? "").toLowerCase().trim();
          const href = attribute(tag, "href");
          if (href !== undefined && ASSET_REL.has(rel)) refs.push(href);
        } else {
          for (const key of ["src", "poster"]) {
            const value = attribute(tag, key);
            if (value !== undefined) refs.push(value);
          }
          const srcset = attribute(tag, "srcset");
          if (srcset) refs.push(...srcset.split(",").map((part) => part.trim().split(/\s+/)[0] ?? ""));
        }
        for (const ref of refs) {
          if (routing === "history" && file.path === "index.html" && ref.trim() && !EXTERNAL.test(ref.trim()) && !ref.trim().startsWith("/"))
            throw invalid("index.html uses relative asset paths, which break deep links; the build must use root-absolute paths", { reference: ref.slice(0, 200) });
          check(file.path, ref);
        }
      }
    } else if (/\.css$/i.test(file.path)) {
      const css = file.content.toString("utf8");
      for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi))
        check(file.path, (match[1] ?? match[2] ?? match[3] ?? "").trim());
      for (const match of css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) check(file.path, match[1]!);
    } else if (/\.m?js$/i.test(file.path)) {
      const js = file.content.toString("utf8");
      // Vite emits root-absolute asset URLs and relative hashed chunk imports.
      for (const match of js.matchAll(/["'`](\/assets\/[A-Za-z0-9._@~+-]+(?:\/[A-Za-z0-9._@~+-]+)*)["'`]/g)) check(file.path, match[1]!);
      for (const match of js.matchAll(/["'`](\.\/[A-Za-z0-9_.@~+-]+-[A-Za-z0-9_-]{8}\.(?:m?js|css))["'`]/g)) check(file.path, match[1]!);
    }
  }
  if (!indexScripts) throw invalid("index.html does not load a local script");
  if (missing.size)
    throw invalid("The production build references files that are missing from its output", {
      missing: [...missing].slice(0, 10),
      missingCount: missing.size,
    });
  new SiteArtifactSecurityScanner().scan(files.map(({ path, content }) => ({ path, content })), "deployment");
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.content.length, 0),
    scripts: files.filter((file) => /\.m?js$/i.test(file.path)).length,
    stylesheets: files.filter((file) => /\.css$/i.test(file.path)).length,
    images: files.filter((file) => IMAGE.test(file.path)).length,
    fonts: files.filter((file) => FONT.test(file.path)).length,
    referencesChecked,
  };
}

// ---------------------------------------------------------------------------
// Serialized artifact (stored in the artifact store, consumed in Stage 3).

export interface PreparedArtifactFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Vercel's file upload API addresses files by SHA-1. */
  readonly sha1: string;
  readonly contentBase64: string;
  /** Generated by AI Sites (platform config), not produced by the site's build. */
  readonly generated?: true;
}
export interface PreparedArtifactDocument {
  readonly schemaVersion: 1;
  readonly kind: "STATIC_SITE";
  readonly siteId: string;
  readonly versionId: string;
  readonly sourceSha256: string;
  readonly routing: SiteRoutingMode;
  readonly entrypoint: "index.html";
  readonly files: readonly PreparedArtifactFile[];
  readonly createdAt: string;
  /** HOSTING_CONFIG_VERSION the generated vercel.json was made with (absent: 1). */
  readonly hostingVersion?: number;
  /** Representative static client routes (history routing) the public verifier requests directly. */
  readonly routes?: readonly string[];
}

const sha = (algorithm: "sha256" | "sha1", data: Uint8Array) => createHash(algorithm).update(data).digest("hex");

export function serializePreparedArtifact(input: {
  readonly siteId: string;
  readonly versionId: string;
  readonly sourceSha256: string;
  readonly routing: SiteRoutingMode;
  readonly routes?: readonly string[];
  readonly files: readonly StaticFile[];
  readonly generated: readonly StaticFile[];
  readonly createdAt: Date;
}): { readonly bytes: Buffer; readonly sha256: string; readonly indexSha256: string } {
  const describe = (file: StaticFile, generated: boolean): PreparedArtifactFile => ({
    path: file.path,
    sizeBytes: file.content.length,
    sha256: sha("sha256", file.content),
    sha1: sha("sha1", file.content),
    contentBase64: file.content.toString("base64"),
    ...(generated ? { generated: true as const } : {}),
  });
  const document: PreparedArtifactDocument = {
    schemaVersion: 1,
    kind: "STATIC_SITE",
    siteId: input.siteId,
    versionId: input.versionId,
    sourceSha256: input.sourceSha256,
    routing: input.routing,
    entrypoint: "index.html",
    files: [...input.files.map((file) => describe(file, false)), ...input.generated.map((file) => describe(file, true))]
      .sort((a, b) => a.path.localeCompare(b.path)),
    createdAt: input.createdAt.toISOString(),
    hostingVersion: HOSTING_CONFIG_VERSION,
    ...(input.routing === "history" && input.routes?.length ? { routes: input.routes.slice(0, 5) } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(document));
  return { bytes, sha256: sha("sha256", bytes), indexSha256: document.files.find((file) => file.path === "index.html")!.sha256 };
}

/**
 * Loads a stored artifact and proves it is the one recorded: whole-document
 * SHA-256, per-file size and SHA-256, and the exact site/version/source.
 */
export function parsePreparedArtifact(
  bytes: Uint8Array | undefined,
  expected: { readonly sha256: string; readonly siteId: string; readonly versionId: string; readonly sourceSha256: string },
): PreparedArtifactDocument {
  if (!bytes) throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared production build is missing");
  if (sha("sha256", bytes) !== expected.sha256)
    throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared production build failed integrity verification");
  let document: PreparedArtifactDocument;
  try {
    document = JSON.parse(Buffer.from(bytes).toString("utf8")) as PreparedArtifactDocument;
  } catch {
    throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared production build is unreadable");
  }
  const files: unknown = document.files;
  if (
    document.schemaVersion !== 1 ||
    document.siteId !== expected.siteId ||
    document.versionId !== expected.versionId ||
    document.sourceSha256 !== expected.sourceSha256 ||
    !Array.isArray(files)
  )
    throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared production build belongs to a different version");
  const routes: unknown = document.routes;
  if (routes !== undefined && !(Array.isArray(routes) && routes.length <= 5 && routes.every((route) => typeof route === "string" && PLAIN_ROUTE.test(route))))
    throw invalid("The prepared production build lists unexpected routes");
  for (const file of document.files) {
    if (file.generated) {
      if (file.path !== "vercel.json") throw invalid("The prepared production build has an unexpected generated file");
    } else validateArtifactPath(file.path);
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.length !== file.sizeBytes || sha("sha256", content) !== file.sha256)
      throw new PublishingError("PUBLISH_ARTIFACT_UNAVAILABLE", "The prepared production build failed integrity verification");
  }
  return document;
}
