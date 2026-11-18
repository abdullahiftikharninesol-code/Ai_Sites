import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { preparationDirectory } from "./production-preparation-storage.js";
import { ProductionConfigurationError, type ProductionConfig } from "./production-config.js";

const COMPONENTS = ["configuration", "startup", "database", "authentication", "storage", "oauth", "preparation", "publishing", "reconciliation", "http", "shutdown"] as const;
const STATES = ["uninitialized", "initializing", "ready", "disabled", "unavailable", "failed", "stopping", "stopped"] as const;
const REASONS = ["INITIALIZATION_PENDING", "INITIALIZED", "DISABLED", "CONFIGURATION_UNAVAILABLE", "CONFIGURATION_INVALID", "STORAGE_NOT_CONFIGURED", "STORAGE_MISSING", "STORAGE_ACCESS_DENIED", "STORAGE_UNSAFE_OR_UNAVAILABLE", "STORAGE_CHECK_TIMEOUT", "INDEX_OR_SERVICE_INITIALIZATION_FAILED", "DATABASE_DISCONNECTED", "DATABASE_CONNECT_FAILED", "DATABASE_DISCONNECT_FAILED", "DATABASE_STATUS_UNAVAILABLE", "AUTHENTICATION_UNAVAILABLE", "HTTP_LISTEN_FAILED", "STARTUP_FAILED", "SHUTTING_DOWN", "DRAIN_FAILED", "STOPPED", "ISOLATION_UNAVAILABLE", "TRUST_REQUIRED"] as const;
const SETTINGS = new Set(["JWTKEY", "DATABASE", "SITES_DATA_ROOT", "SITES_DEV_DATA_ROOT", "SITES_HTTP_HOST", "SITES_HTTP_PORT", "SITES_HTTP_ORIGINS", "SITES_PUBLISH_BUILD_PROVIDER", "SITES_PUBLISH_TRUSTED_SITE_IDS", "VERCEL_PROJECT_LINKING_ENABLED", "VERCEL_LIVE_PUBLISHING_ENABLED", "SITES_PUBLISH_RECONCILE_ENABLED", "SITES_PUBLISH_MAX_CONCURRENT", "SITES_PUBLISH_MAX_CONCURRENT_DEPLOYS", "SITES_PUBLISH_INSTALL_TIMEOUT_MS", "SITES_PUBLISH_BUILD_TIMEOUT_MS", "SITES_PUBLISH_BUILD_MEMORY_MB", "SITES_PUBLISH_MAX_OUTPUT_MB", "SITES_PUBLISH_RECONCILE_INTERVAL_MS", "SITES_PUBLISH_RECONCILE_PASS_TIMEOUT_MS"]);
export type ProductionComponent = typeof COMPONENTS[number];
type State = typeof STATES[number];
type Reason = typeof REASONS[number];
export type InitializationState = "initializing" | "ready" | "failed";
export interface ProductionDiagnostic {
  readonly event: "sites.production";
  readonly component: ProductionComponent;
  readonly state: State;
  readonly reason: Reason;
  readonly setting?: string;
}
export type ProductionDiagnosticSink = (event: ProductionDiagnostic) => void;
export function productionDiagnostics(sink: ProductionDiagnosticSink = event => console.info("[sites][production]", event)) {
  const states = new Map<ProductionComponent, ProductionDiagnostic>();
  return {
    report(component: ProductionComponent, state: State, reason: Reason, setting?: string) {
      // Runtime allowlist as well as types: never serialize exceptions, configuration values or arbitrary metadata.
      if (!COMPONENTS.includes(component) || !STATES.includes(state) || !REASONS.includes(reason)) return;
      const previous = states.get(component);
      const safeSetting = setting && SETTINGS.has(setting) ? setting : undefined;
      if (previous?.state === state && previous.reason === reason && previous.setting === safeSetting) return;
      const event: ProductionDiagnostic = Object.freeze({ event: "sites.production", component, state, reason, ...(safeSetting ? { setting: safeSetting } : {}) });
      states.set(component, event);
      try { sink(event); } catch { /* Observability must not change admission or lifecycle behavior. */ }
    },
    state: (component: ProductionComponent) => states.get(component)?.state,
  };
}

export function productionStartupFailure(error: unknown, sink: ProductionDiagnosticSink = event => console.error("[sites][production]", event)): void {
  const diagnostics = productionDiagnostics(sink);
  if (error instanceof ProductionConfigurationError) {
    for (const issue of error.issues) diagnostics.report("configuration", "failed", "CONFIGURATION_INVALID", issue.variable);
  } else diagnostics.report("startup", "failed", "STARTUP_FAILED");
}

export type StorageReadiness = "ready" | "STORAGE_MISSING" | "STORAGE_ACCESS_DENIED" | "STORAGE_UNSAFE_OR_UNAVAILABLE" | "STORAGE_CHECK_TIMEOUT";
/** Existing canonical-directory/link checks, plus read/search access. No mkdir, writes, file contents or capacity probes. */
export async function checkProductionStorage(root: string): Promise<StorageReadiness> {
  try {
    const artifacts = await preparationDirectory(root, ["artifacts"]);
    await access(root, constants.R_OK | constants.X_OK);
    await access(artifacts, constants.R_OK | constants.X_OK);
    return "ready";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" ? "STORAGE_MISSING" : code === "EACCES" || code === "EPERM" ? "STORAGE_ACCESS_DENIED" : "STORAGE_UNSAFE_OR_UNAVAILABLE";
  }
}

export interface ProductionReadinessDependencies {
  readonly log?: ProductionDiagnosticSink;
  readonly storage?: (root: string) => Promise<StorageReadiness>;
}

export function productionReadiness(config: ProductionConfig, oauthConfigured: boolean, diagnostics: ReturnType<typeof productionDiagnostics>, dependencies: ProductionReadinessDependencies = {}) {
  let phase: "starting" | "ready" | "failed" | "stopping" | "stopped" = "starting";
  let storage: Promise<StorageReadiness> | undefined, checkedAt = 0;
  let probing: Promise<StorageReadiness> | undefined;
  const checkingAllowed = () => phase === "starting" || phase === "ready";
  const live = config.projectLinking && config.livePublishing;
  diagnostics.report("startup", "initializing", "INITIALIZATION_PENDING");
  diagnostics.report("oauth", oauthConfigured ? "uninitialized" : "unavailable", oauthConfigured ? "INITIALIZATION_PENDING" : "CONFIGURATION_UNAVAILABLE");
  diagnostics.report("preparation", !config.projectLinking ? "disabled" : config.provider !== "local" || !config.trustedSiteIds.length ? "unavailable" : "uninitialized",
    !config.projectLinking ? "DISABLED" : config.provider !== "local" ? "ISOLATION_UNAVAILABLE" : !config.trustedSiteIds.length ? "TRUST_REQUIRED" : "INITIALIZATION_PENDING");
  diagnostics.report("publishing", !live ? "disabled" : !oauthConfigured || !config.dataRoot ? "unavailable" : "uninitialized", !live ? "DISABLED" : !oauthConfigured || !config.dataRoot ? "CONFIGURATION_UNAVAILABLE" : "INITIALIZATION_PENDING");
  diagnostics.report("reconciliation", live && config.reconciliation ? "uninitialized" : "disabled", live && config.reconciliation ? "INITIALIZATION_PENDING" : "DISABLED");
  const checkStorage = (): Promise<StorageReadiness> => {
    if (!checkingAllowed()) return Promise.resolve("STORAGE_UNSAFE_OR_UNAVAILABLE");
    if (!config.dataRoot) { diagnostics.report("storage", "unavailable", "STORAGE_NOT_CONFIGURED"); return Promise.resolve("STORAGE_MISSING"); }
    if (storage && (probing || Date.now() - checkedAt < 1_000)) return storage;
    checkedAt = Date.now();
    probing = Promise.resolve().then(() => (dependencies.storage ?? checkProductionStorage)(config.dataRoot!));
    const probe = probing;
    void probe.finally(() => { if (probing === probe) probing = undefined; }).catch(() => undefined);
    storage = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          probe,
          new Promise<StorageReadiness>(resolve => { timer = setTimeout(() => resolve("STORAGE_CHECK_TIMEOUT"), 500); }),
        ]);
        if (checkingAllowed()) diagnostics.report("storage", result === "ready" ? "ready" : "unavailable", result === "ready" ? "INITIALIZED" : result);
        return result;
      } catch { if (checkingAllowed()) diagnostics.report("storage", "unavailable", "STORAGE_UNSAFE_OR_UNAVAILABLE"); return "STORAGE_UNSAFE_OR_UNAVAILABLE"; }
      finally { if (timer) clearTimeout(timer); }
    })();
    return storage;
  };
  return {
    checkStorage,
    observe: (component: "oauth" | "preparation" | "publishing" | "reconciliation") => (state: InitializationState) => {
      if (phase === "stopping" || phase === "stopped") return;
      if (state !== "failed") {
        if (component === "preparation" && !config.projectLinking || component === "publishing" && !live || component === "reconciliation" && !(live && config.reconciliation)) {
          diagnostics.report(component, "disabled", "DISABLED"); return;
        }
        if (!oauthConfigured) { diagnostics.report(component, "unavailable", "CONFIGURATION_UNAVAILABLE"); return; }
        if (component === "preparation" && (config.provider !== "local" || !config.trustedSiteIds.length)) {
          diagnostics.report(component, "unavailable", config.provider !== "local" ? "ISOLATION_UNAVAILABLE" : "TRUST_REQUIRED"); return;
        }
      }
      diagnostics.report(component, state, state === "failed" ? "INDEX_OR_SERVICE_INITIALIZATION_FAILED" : state === "ready" ? "INITIALIZED" : "INITIALIZATION_PENDING");
    },
    started() { if (phase !== "starting") return; phase = "ready"; diagnostics.report("startup", "ready", "INITIALIZED"); },
    failed() { if (phase !== "starting") return; phase = "failed"; diagnostics.report("startup", "failed", "STARTUP_FAILED"); },
    stopping() { phase = "stopping"; diagnostics.report("shutdown", "stopping", "SHUTTING_DOWN"); },
    drainFailed() { diagnostics.report("shutdown", "failed", "DRAIN_FAILED"); },
    stopped() { phase = "stopped"; diagnostics.report("shutdown", "stopped", "STOPPED"); },
    async check(connected: boolean, authenticated: boolean): Promise<boolean> {
      if (phase !== "ready") return false;
      diagnostics.report("database", connected ? "ready" : "unavailable", connected ? "INITIALIZED" : "DATABASE_DISCONNECTED");
      diagnostics.report("authentication", authenticated ? "ready" : "unavailable", authenticated ? "INITIALIZED" : "AUTHENTICATION_UNAVAILABLE");
      if (!connected || !authenticated) return false;
      const storageReady = !config.dataRoot || await checkStorage() === "ready";
      return phase === "ready" && storageReady && (!oauthConfigured || diagnostics.state("oauth") !== "failed") &&
        (!config.projectLinking || diagnostics.state("preparation") !== "failed") &&
        (!live || oauthConfigured && diagnostics.state("publishing") !== "failed") &&
        (!live || !config.reconciliation || diagnostics.state("reconciliation") === "ready");
    },
  };
}
