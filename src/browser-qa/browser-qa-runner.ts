import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import {
  BROWSER_QA_VIEWPORTS,
  createBrowserQACheckResult,
  createBrowserQAReport,
  type BrowserQACheckResult,
  type BrowserQAEvidence,
  type BrowserQAReport,
  type BrowserQAScreenshotDescriptor,
  type BrowserQAViewport,
} from "./browser-qa-domain.js";
import type { BrowserQACheckDefinition } from "./browser-qa-check-registry.js";

export interface BrowserQAPreviewTarget {
  readonly baseUrl: string;
  readonly projectId?: string;
  readonly siteVersionId?: string;
  readonly jobId?: string;
  readonly allowedOrigins?: readonly string[];
}

export interface BrowserQAObservedEvents {
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly BrowserQAEvidence[];
  readonly consoleWarnings: readonly BrowserQAEvidence[];
  readonly failedRequests: readonly BrowserQAEvidence[];
  readonly badResponses: readonly BrowserQAEvidence[];
  readonly blockedRequests: readonly BrowserQAEvidence[];
  readonly dialogs: readonly BrowserQAEvidence[];
  readonly popups: readonly BrowserQAEvidence[];
  readonly downloads: readonly BrowserQAEvidence[];
}

interface MutableBrowserQAObservedEvents {
  readonly pageErrors: string[];
  readonly consoleErrors: BrowserQAEvidence[];
  readonly consoleWarnings: BrowserQAEvidence[];
  readonly failedRequests: BrowserQAEvidence[];
  readonly badResponses: BrowserQAEvidence[];
  readonly blockedRequests: BrowserQAEvidence[];
  readonly dialogs: BrowserQAEvidence[];
  readonly popups: BrowserQAEvidence[];
  readonly downloads: BrowserQAEvidence[];
}

export interface BrowserQAPageContext {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly route: string;
  readonly viewport: BrowserQAViewport;
  readonly events: BrowserQAObservedEvents;
  readonly screenshotRef?: string;
}

export interface BrowserQACheckExecutor {
  readonly definition: BrowserQACheckDefinition;
  execute(context: BrowserQAPageContext): Promise<BrowserQACheckResult>;
}

export interface BrowserQARunnerPolicy {
  readonly browserLaunchTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly perPageTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly captureScreenshots: boolean;
  readonly reducedMotion: boolean;
  readonly permissions: readonly string[];
  readonly allowDownloads: boolean;
}

export const DEFAULT_BROWSER_QA_RUNNER_POLICY: BrowserQARunnerPolicy = Object.freeze({
  browserLaunchTimeoutMs: 15_000,
  navigationTimeoutMs: 15_000,
  perPageTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  captureScreenshots: true,
  reducedMotion: false,
  permissions: Object.freeze([]),
  allowDownloads: false,
});

export interface BrowserQARunRequest {
  readonly runId: string;
  readonly target: BrowserQAPreviewTarget;
  readonly routes?: readonly string[];
  readonly viewports?: readonly BrowserQAViewport[];
  readonly checks?: readonly BrowserQACheckExecutor[];
  readonly artifactPrefix?: string;
  readonly policy?: Partial<BrowserQARunnerPolicy>;
}

export interface BrowserQARunnerOptions {
  readonly artifacts?: ArtifactStore;
  readonly now?: () => Date;
}

export class BrowserQARunner {
  readonly #artifacts: ArtifactStore | undefined;
  readonly #now: () => Date;
  #activeBrowsers = 0;

  constructor(options: BrowserQARunnerOptions = {}) {
    this.#artifacts = options.artifacts;
    this.#now = options.now ?? (() => new Date());
  }

  get activeBrowserCount(): number {
    return this.#activeBrowsers;
  }

  async run(request: BrowserQARunRequest): Promise<BrowserQAReport> {
    const started = this.#now();
    const policy = { ...DEFAULT_BROWSER_QA_RUNNER_POLICY, ...request.policy };
    const baseUrl = validatePreviewUrl(request.target.baseUrl);
    const allowedOrigins = new Set([
      baseUrl.origin,
      ...(request.target.allowedOrigins ?? []).map(validateOrigin),
    ]);
    const routes = normalizeRoutes(request.routes ?? [baseUrl.pathname || "/"]);
    const viewports = [...(request.viewports ?? BROWSER_QA_VIEWPORTS)];
    const checks: BrowserQACheckResult[] = [];
    const screenshotRefs: string[] = [];
    const screenshots: BrowserQAScreenshotDescriptor[] = [];
    const browser = await chromium.launch({ headless: true, timeout: policy.browserLaunchTimeoutMs });
    this.#activeBrowsers++;
    try {
      for (const viewport of viewports) {
        for (const route of routes) {
          if (this.#now().getTime() - started.getTime() > policy.totalTimeoutMs)
            throw new BrowserQATimeoutError("Browser QA total run timeout exceeded");
          const pageResult = await this.#runPage({
            browser,
            baseUrl,
            allowedOrigins,
            route,
            viewport,
            checks: request.checks ?? [],
            ...(request.artifactPrefix === undefined ? {} : { artifactPrefix: request.artifactPrefix }),
            policy,
            screenshotRefs,
            screenshots,
          });
          checks.push(...pageResult.checks);
        }
      }
    } finally {
      await browser.close();
      this.#activeBrowsers--;
    }
    const completed = this.#now();
    return createBrowserQAReport({
      runId: request.runId,
      ...(request.target.projectId === undefined ? {} : { projectId: request.target.projectId }),
      ...(request.target.siteVersionId === undefined ? {} : { siteVersionId: request.target.siteVersionId }),
      ...(request.target.jobId === undefined ? {} : { jobId: request.target.jobId }),
      browser: { name: "chromium", version: browser.version() },
      viewports,
      routes,
      checks,
      artifactRefs: screenshotRefs,
      screenshots,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
    });
  }

  async #runPage(input: {
    readonly browser: Browser;
    readonly baseUrl: URL;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly route: string;
    readonly viewport: BrowserQAViewport;
    readonly checks: readonly BrowserQACheckExecutor[];
    readonly artifactPrefix?: string;
    readonly policy: BrowserQARunnerPolicy;
    readonly screenshotRefs: string[];
    readonly screenshots: BrowserQAScreenshotDescriptor[];
  }): Promise<{ readonly checks: readonly BrowserQACheckResult[] }> {
    const events: MutableBrowserQAObservedEvents = {
      pageErrors: [],
      consoleErrors: [],
      consoleWarnings: [],
      failedRequests: [],
      badResponses: [],
      blockedRequests: [],
      dialogs: [],
      popups: [],
      downloads: [],
    };
    const context = await input.browser.newContext({
      viewport: { width: input.viewport.width, height: input.viewport.height },
      permissions: [...input.policy.permissions],
      acceptDownloads: input.policy.allowDownloads,
      serviceWorkers: "block",
    });
    let page: Page | undefined;
    try {
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (isAllowedRequest(request, input.allowedOrigins)) {
          await route.continue();
          return;
        }
        events.blockedRequests.push(networkEvidence(request, undefined, "Blocked by Browser QA origin policy"));
        await route.abort("blockedbyclient");
      });
      page = await context.newPage();
      context.on("page", (popup) => {
        if (popup === page) return;
        events.popups.push(Object.freeze({ type: "network", url: popup.url() || "about:blank", failureText: "Unexpected popup blocked" }));
        void popup.close().catch(() => undefined);
      });
      page.on("pageerror", (error) => events.pageErrors.push(error.message.slice(0, 2_000)));
      page.on("console", (message) => {
        const evidence = Object.freeze({ type: "console" as const, level: message.type(), message: message.text().slice(0, 2_000) });
        if (message.type() === "error") events.consoleErrors.push(evidence);
        if (message.type() === "warning") events.consoleWarnings.push(evidence);
      });
      page.on("requestfailed", (request) => events.failedRequests.push(networkEvidence(request, undefined, request.failure()?.errorText ?? "failed")));
      page.on("response", (response) => {
        if (response.status() >= 400) events.badResponses.push(networkEvidence(response.request(), response.status()));
      });
      page.on("dialog", (dialog) => {
        events.dialogs.push(Object.freeze({ type: "console", level: dialog.type(), message: dialog.message().slice(0, 1_000) }));
        void dialog.dismiss().catch(() => undefined);
      });
      page.on("download", (download) => {
        events.downloads.push(Object.freeze({ type: "network", url: download.url(), failureText: "Unexpected download" }));
        if (!input.policy.allowDownloads) void download.cancel().catch(() => undefined);
      });
      await page.emulateMedia({ reducedMotion: input.policy.reducedMotion ? "reduce" : "no-preference" });
      const destination = new URL(input.route, input.baseUrl);
      if (destination.origin !== input.baseUrl.origin) throw new BrowserQAPolicyError("Browser QA routes must remain on the preview origin");
      const pageChecks: BrowserQACheckResult[] = [];
      try {
        const response = await page.goto(destination.toString(), { waitUntil: "domcontentloaded", timeout: input.policy.navigationTimeoutMs });
        if (!response || !response.ok())
          pageChecks.push(createBrowserQACheckResult({
            checkId: "page-readiness",
            category: "RUNTIME",
            status: "FAIL",
            severity: "ERROR",
            route: input.route,
            viewport: input.viewport,
            message: `Preview route did not return an acceptable response (${response?.status() ?? "no response"})`,
            ...(response ? { evidence: [networkEvidence(response.request(), response.status())] } : {}),
          }));
        else
          pageChecks.push(createBrowserQACheckResult({
            checkId: "page-readiness",
            category: "RUNTIME",
            status: "PASS",
            severity: "ERROR",
            route: input.route,
            viewport: input.viewport,
            message: "Preview route loaded",
          }));
      } catch (error) {
        pageChecks.push(createBrowserQACheckResult({
          checkId: "page-readiness",
          category: "RUNTIME",
          status: "FAIL",
          severity: "ERROR",
          route: input.route,
          viewport: input.viewport,
          message: `Preview route navigation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
        }));
      }
      // DOM readiness does not guarantee that console errors or blocked
      // requests emitted by startup scripts have reached their listeners.
      // Give those events a bounded settle window before checks receive the
      // immutable event snapshot; never let a long-lived request block QA.
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(2_000, input.policy.perPageTimeoutMs),
      }).catch(() => undefined);
      const screenshotRef = await this.#captureScreenshot(page, input, input.screenshotRefs, input.screenshots);
      const pageContext: BrowserQAPageContext = {
        page,
        context,
        route: input.route,
        viewport: input.viewport,
        events: freezeEvents(events),
        ...(screenshotRef === undefined ? {} : { screenshotRef }),
      };
      for (const check of input.checks) {
        try {
          pageChecks.push(await withTimeout(check.execute(pageContext), check.definition.timeoutMs, check.definition.checkId));
        } catch (error) {
          pageChecks.push(createBrowserQACheckResult({
            checkId: check.definition.checkId,
            category: check.definition.category,
            status: "FAIL",
            severity: "ERROR",
            route: input.route,
            viewport: input.viewport,
            message: `Browser QA check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
          }));
        }
      }
      return { checks: pageChecks };
    } finally {
      await context.close();
    }
  }

  async #captureScreenshot(
    page: Page,
    input: { readonly artifactPrefix?: string; readonly route: string; readonly viewport: BrowserQAViewport; readonly policy: BrowserQARunnerPolicy },
    screenshotRefs: string[],
    screenshots: BrowserQAScreenshotDescriptor[],
  ): Promise<string | undefined> {
    if (!input.policy.captureScreenshots || !this.#artifacts || input.artifactPrefix === undefined) return undefined;
    const bytes = await page.screenshot({ fullPage: true, type: "png", timeout: input.policy.navigationTimeoutMs });
    const routeKey = input.route === "/" ? "home" : input.route.replace(/^\/+/, "").replace(/[^a-zA-Z0-9_-]+/g, "-") || "route";
    const fullHash = createHash("sha256").update(bytes).digest("hex");
    const ref = `${input.artifactPrefix}/${input.viewport.id.toLowerCase()}-${routeKey}-${fullHash.slice(0, 16)}.png`;
    await this.#artifacts.put(ref, bytes, { kind: "SCREENSHOT", contentType: "image/png" });
    screenshotRefs.push(ref);
    screenshots.push({
      route: input.route,
      viewport: input.viewport,
      artifactRef: ref,
      contentHash: fullHash,
      capturedAt: this.#now().toISOString(),
    });
    return ref;
  }
}

export class BrowserQATimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserQATimeoutError";
  }
}

export class BrowserQAPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserQAPolicyError";
  }
}

function validatePreviewUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserQAPolicyError("Browser QA preview target must be an absolute URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new BrowserQAPolicyError("Browser QA preview target must use HTTP(S)");
  return url;
}

function validateOrigin(value: string): string {
  const url = validatePreviewUrl(value);
  return url.origin;
}

function normalizeRoutes(routes: readonly string[]): readonly string[] {
  if (routes.length === 0) return ["/"];
  const normalized = [...new Set(routes)].map((route) => {
    if (!route.startsWith("/") || route.startsWith("//") || /^(?:javascript|data|file):/i.test(route))
      throw new BrowserQAPolicyError(`Invalid Browser QA route '${route}'`);
    return route;
  });
  return normalized.sort((a, b) => a.localeCompare(b));
}

function isAllowedRequest(request: Request, allowedOrigins: ReadonlySet<string>): boolean {
  const url = request.url();
  if (/^(?:data|blob|about|chrome-extension):/i.test(url)) return true;
  try {
    const parsed = new URL(url);
    const normalizedOrigin = parsed.protocol === "ws:" ? `http://${parsed.host}` : parsed.protocol === "wss:" ? `https://${parsed.host}` : parsed.origin;
    return allowedOrigins.has(normalizedOrigin);
  } catch {
    return false;
  }
}

function networkEvidence(request: Request, status?: number, failureText?: string): BrowserQAEvidence {
  const response = request.resourceType();
  return Object.freeze({
    type: "network",
    url: request.url().slice(0, 2_000),
    method: request.method().slice(0, 20),
    ...(status === undefined ? {} : { status }),
    ...(failureText === undefined ? {} : { failureText: failureText.slice(0, 500) }),
    resourceType: response,
  });
}

function freezeEvents(events: MutableBrowserQAObservedEvents): BrowserQAObservedEvents {
  return Object.freeze({
    pageErrors: Object.freeze([...events.pageErrors]),
    consoleErrors: Object.freeze([...events.consoleErrors]),
    consoleWarnings: Object.freeze([...events.consoleWarnings]),
    failedRequests: Object.freeze([...events.failedRequests]),
    badResponses: Object.freeze([...events.badResponses]),
    blockedRequests: Object.freeze([...events.blockedRequests]),
    dialogs: Object.freeze([...events.dialogs]),
    popups: Object.freeze([...events.popups]),
    downloads: Object.freeze([...events.downloads]),
  });
}

async function withTimeout(promise: Promise<BrowserQACheckResult>, timeoutMs: number, checkId: string): Promise<BrowserQACheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<BrowserQACheckResult>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserQATimeoutError(`Browser QA check '${checkId}' timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
