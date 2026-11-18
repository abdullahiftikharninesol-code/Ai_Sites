import { isIP } from "node:net";
import { posix, win32 } from "node:path";
import { loadProductionBuildLimits } from "../publishing/production-build-service.js";
import { DEFAULT_STATIC_ARTIFACT_LIMITS } from "../publishing/static-artifact.js";
import { DEFAULT_VERCEL_PUBLISH_LIMITS } from "../publishing/vercel-publish-service.js";
import { MAX_PREPARED_ARTIFACT_BYTES } from "./production-preparation-storage.js";

interface ConfigurationIssue { readonly variable: string; readonly reason: string }
export class ProductionConfigurationError extends Error {
  readonly code = "PRODUCTION_CONFIGURATION_INVALID";
  constructor(readonly issues: readonly ConfigurationIssue[]) {
    super(`Invalid production configuration: ${issues.map(issue => `${issue.variable}: ${issue.reason}`).join("; ")}`);
    this.name = "ProductionConfigurationError";
  }
}
function invalid(variable: string, reason: string): never { throw new ProductionConfigurationError([{ variable, reason }]); }
const hasControls = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const loopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
const dnsName = (host: string) => host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
const text = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  if (value !== undefined && (typeof value !== "string" || hasControls(value))) invalid(name, "must be plain text without control characters");
  return value;
};

/** Lexical checks only. Existing readers/builders still check actual directory/link ownership at use time. */
export function validateProductionDataRoot(value: string, platform: NodeJS.Platform = process.platform, variable = "SITES_DATA_ROOT"): string {
  if (typeof value !== "string" || !value || value !== value.trim() || hasControls(value) || /\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%/.test(value))
    return invalid(variable, "must be an explicit absolute application data directory");
  const windows = platform === "win32", paths = windows ? win32 : posix;
  if (!paths.isAbsolute(value) || (!windows && (value.startsWith("//") || value.includes("\\"))) || (windows && /^(?:\\\\[?.]\\|\/\/[?.]\/)/.test(value)))
    return invalid(variable, "must be a native absolute path without device namespaces");
  if (windows && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/\/[^\\/]+\/[^\\/]+\/)/i.test(value))
    return invalid(variable, "must include an absolute drive or an explicit share and child directory");
  const root = paths.parse(value).root, tail = value.slice(root.length).replace(windows ? /[\\/]+$/ : /\/+$/, "");
  if (windows && /^[\\/]{2}/.test(root)) {
    const [server, share] = root.slice(2).split(/[\\/]/);
    if (!server || !share || !dnsName(server) || /^[. ]|[. ]$|[<>:"|?*]/.test(share)) return invalid(variable, "must use an unambiguous share namespace");
  }
  const segments = tail.split(windows ? /[\\/]/ : /\//);
  if (!tail || segments.some(part => !part || part === "." || part === ".." || part !== part.trim() || /[<>:"|?*]/.test(part) ||
    (windows && (/[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))))
    return invalid(variable, "must not be a filesystem/share root or contain ambiguous path components");
  if ((!windows && /^(?:dev|proc|sys|etc|bin|sbin|lib|lib64|boot)$/.test(segments[0]!)) ||
    (windows && /^(?:windows|program files(?: \(x86\))?)$/i.test(segments[0]!)))
    return invalid(variable, "must not use an operating-system directory");
  return paths.normalize(paths.join(root, ...segments));
}

export interface ProductionConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly dataRoot?: string;
  readonly provider: "local" | "cloud";
  readonly trustedSiteIds: readonly string[];
  readonly projectLinking: boolean;
  readonly livePublishing: boolean;
  readonly reconciliation: boolean;
}

/** Pure validation: no filesystem access, model/index initialization, execution or provider requests. */
export function loadProductionConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ProductionConfig {
  if (!env || typeof env !== "object" || Array.isArray(env)) return invalid("configuration", "must be an environment name/value map");
  let host = text(env, "SITES_HTTP_HOST") ?? "127.0.0.1";
  if (host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6) host = host.slice(1, -1);
  if (!host || host !== host.trim() || (!isIP(host) && (!dnsName(host) || /^[0-9.]+$/.test(host)))) invalid("SITES_HTTP_HOST", "must be an IP address or DNS hostname without a scheme, port or path");
  host = host.toLowerCase();
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = text(env, name);
    if (raw === undefined) return fallback;
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) invalid(name, "must be an integer within its supported range");
    return Number(raw);
  };
  const port = integer("SITES_HTTP_PORT", 4312, 0, 65_535);
  if (port === 0 && !loopback(host)) invalid("SITES_HTTP_PORT", "an ephemeral port requires a loopback listener");
  const origins = text(env, "SITES_HTTP_ORIGINS"), allowedOrigins: string[] = [];
  if (origins !== undefined) for (const item of origins.split(",")) {
    const origin = item.trim(); let url: URL;
    try { url = new URL(origin); } catch { return invalid("SITES_HTTP_ORIGINS", "must contain explicit HTTP(S) origins without empty entries"); }
    const originHost = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (!origin || url.origin !== origin || !["https:", "http:"].includes(url.protocol) ||
      (!isIP(originHost) && !dnsName(originHost)) ||
      (url.protocol === "http:" && !loopback(url.hostname) && env.NODE_ENV !== "development")) invalid("SITES_HTTP_ORIGINS", "must contain canonical HTTPS origins; HTTP is limited to loopback or explicit development");
    allowedOrigins.push(origin);
  }
  const flag = (name: string) => {
    const value = text(env, name);
    if (value !== undefined && value !== "true" && value !== "false") invalid(name, "must be an explicit boolean or unset");
    return value === "true";
  };
  const projectLinking = flag("VERCEL_PROJECT_LINKING_ENABLED"), livePublishing = flag("VERCEL_LIVE_PUBLISHING_ENABLED"), reconciliation = flag("SITES_PUBLISH_RECONCILE_ENABLED");
  const provider = text(env, "SITES_PUBLISH_BUILD_PROVIDER") ?? "local";
  if (provider !== "local" && provider !== "cloud") invalid("SITES_PUBLISH_BUILD_PROVIDER", "must name a recognized provider; no fallback is allowed");
  const list = text(env, "SITES_PUBLISH_TRUSTED_SITE_IDS");
  const trustedSiteIds = list?.trim() ? list.split(",").map(id => id.trim()) : [];
  if (trustedSiteIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) invalid("SITES_PUBLISH_TRUSTED_SITE_IDS", "must contain valid site identifiers without empty entries");
  const configuredRoot = text(env, "SITES_DATA_ROOT");
  const legacyRoot = configuredRoot === undefined && env.NODE_ENV === "development" ? text(env, "SITES_DEV_DATA_ROOT") : undefined;
  const dataRoot = configuredRoot !== undefined ? validateProductionDataRoot(configuredRoot, platform) : legacyRoot !== undefined ? validateProductionDataRoot(legacyRoot, platform, "SITES_DEV_DATA_ROOT") : undefined;
  if (!dataRoot && (trustedSiteIds.length > 0 || projectLinking && livePublishing && reconciliation)) invalid("SITES_DATA_ROOT", "is required before trusted builds or scheduled recovery can be enabled");
  integer("SITES_PUBLISH_MAX_CONCURRENT", 1, 1, 4); integer("SITES_PUBLISH_MAX_CONCURRENT_DEPLOYS", 1, 1, 4);
  integer("SITES_PUBLISH_INSTALL_TIMEOUT_MS", 300_000, 30_000, 900_000); integer("SITES_PUBLISH_BUILD_TIMEOUT_MS", 180_000, 15_000, 600_000);
  integer("SITES_PUBLISH_BUILD_MEMORY_MB", 1_536, 256, 8_192); integer("SITES_PUBLISH_MAX_OUTPUT_MB", 30, 1, 200);
  integer("SITES_PUBLISH_RECONCILE_INTERVAL_MS", 300_000, 60_000, 3_600_000); integer("SITES_PUBLISH_RECONCILE_PASS_TIMEOUT_MS", 120_000, 10_000, 600_000);
  const outputBytes = loadProductionBuildLimits(env).output.maxTotalBytes, fileCount = DEFAULT_STATIC_ARTIFACT_LIMITS.maxFiles + 1;
  // Base64 padding per file, worst-case JSON path escaping and bounded metadata/hosting config.
  const rawBytes = outputBytes + 64_000;
  const documentBound = 4 * Math.ceil(rawBytes / 3) + 4 * fileCount + fileCount * (6 * 1_024 + 512) + 64_000;
  if (rawBytes > DEFAULT_VERCEL_PUBLISH_LIMITS.maxUploadBytes || documentBound > MAX_PREPARED_ARTIFACT_BYTES)
    invalid("SITES_PUBLISH_MAX_OUTPUT_MB", "exceeds compatible artifact document or upload limits");
  return Object.freeze({ host, port, allowedOrigins: Object.freeze([...new Set(allowedOrigins)]), ...(dataRoot ? { dataRoot } : {}), provider,
    trustedSiteIds: Object.freeze([...new Set(trustedSiteIds)]), projectLinking, livePublishing, reconciliation });
}

export function requireProductionDataRoot(config: ProductionConfig): string {
  return config.dataRoot ?? invalid("SITES_DATA_ROOT", "an explicit absolute application data directory is required for artifact access");
}
