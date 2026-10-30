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
import { classifyBrowserQAFailure } from "./browser-qa-failure.js";

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
  /** Deterministic route/viewport scope; an excluded check is recorded SKIPPED. */
  readonly appliesTo?: (route: string, viewport: BrowserQAViewport) => boolean;
  readonly afterInteractions?: boolean;
  execute(context: BrowserQAPageContext): Promise<BrowserQACheckResult>;
}

export interface BrowserQARunnerPolicy {
  readonly browserLaunchTimeoutMs: number;
  readonly browserLaunchRetries: number;
  readonly navigationTimeoutMs: number;
  readonly perPageTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly captureScreenshots: boolean;
  readonly reducedMotion: boolean;
  readonly permissions: readonly string[];
  readonly allowDownloads: boolean;
}

export const DEFAULT_BROWSER_QA_RUNNER_POLICY: BrowserQARunnerPolicy = Object.freeze({
  browserLaunchTimeoutMs: 30_000,
  browserLaunchRetries: 1,
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
  readonly launchBrowser?: (options: { readonly headless: boolean; readonly timeout: number }) => Promise<Browser>;
}

export class BrowserQARunner {
  readonly #artifacts: ArtifactStore | undefined;
  readonly #now: () => Date;
  readonly #launchBrowser: NonNullable<BrowserQARunnerOptions["launchBrowser"]>;
  #activeBrowsers = 0;

  constructor(options: BrowserQARunnerOptions = {}) {
    this.#artifacts = options.artifacts;
    this.#now = options.now ?? (() => new Date());
    this.#launchBrowser = options.launchBrowser ?? ((launchOptions) => chromium.launch(launchOptions));
  }

  get activeBrowserCount(): number {
    return this.#activeBrowsers;
  }

  async run(request: BrowserQARunRequest): Promise<BrowserQAReport> {
    const started = this.#now();
    const wallStarted = Date.now();
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
    let browser: Browser;
    try { browser = await this.#launchWithRetry(policy); }
    catch (error) {
      const completed = this.#now();
      return createBrowserQAReport({ runId: request.runId, ...request.target,
        browser: { name: "chromium" }, viewports, routes,
        checks: [createBrowserQACheckResult({ checkId: "qa.infrastructure", category: "RUNTIME", status: "FAIL", severity: "ERROR", failureKind: "QA_INFRASTRUCTURE_FAILURE",
          message: `Browser QA could not launch its browser: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) })],
        startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime() });
    }
    this.#activeBrowsers++;
    try {
      routeRuns: for (const viewport of viewports) {
        for (const route of routes) {
          const remainingMs = policy.totalTimeoutMs - Math.max(this.#now().getTime() - started.getTime(), Date.now() - wallStarted);
          if (remainingMs <= 0) {
            checks.push(createBrowserQACheckResult({ checkId: "qa.run-budget", category: "RUNTIME", status: "FAIL", severity: "ERROR", route, viewport,
              failureKind: "RUN_DEADLINE_EXCEEDED",
              message: "Browser QA total run timeout exceeded; remaining routes were not validated" }));
            break routeRuns;
          }
          let pageResult: { readonly checks: readonly BrowserQACheckResult[] };
          try { pageResult = await this.#runPage({
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
            budgetMs: Math.min(policy.perPageTimeoutMs, remainingMs),
            runBudget: remainingMs <= policy.perPageTimeoutMs,
          }); } catch (error) {
            checks.push(createBrowserQACheckResult({ checkId: "qa.infrastructure", category: "RUNTIME", status: "FAIL", severity: "ERROR", route, viewport,
              failureKind: "QA_INFRASTRUCTURE_FAILURE", message: `Browser QA route execution failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) }));
            break routeRuns;
          }
          checks.push(...pageResult.checks);
          if (pageResult.checks.some(check => check.failureKind === "RUN_DEADLINE_EXCEEDED")) break routeRuns;
        }
      }
    } finally {
      try { await browser.close(); } finally { this.#activeBrowsers--; }
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

  async #launchWithRetry(policy: BrowserQARunnerPolicy): Promise<Browser> {
    const retries = Math.max(0, Math.floor(policy.browserLaunchRetries));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#launchBrowser({ headless: true, timeout: policy.browserLaunchTimeoutMs });
      } catch (error) {
        if (attempt >= retries || !isPlaywrightTimeout(error)) throw error;
      }
    }
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
    readonly budgetMs: number;
    readonly runBudget: boolean;
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
    const pageStarted = Date.now();
    const context = await input.browser.newContext({
      viewport: { width: input.viewport.width, height: input.viewport.height },
      permissions: [...input.policy.permissions],
      acceptDownloads: input.policy.allowDownloads,
      serviceWorkers: "block",
    });
    let page: Page | undefined;
    const pageChecks: BrowserQACheckResult[] = [];
    let expired = false;
    // Cancel outstanding browser actions, not just the Promise awaiting them.
    const deadline = setTimeout(() => { expired = true; void context.close().catch(() => undefined); }, Math.max(1, input.budgetMs - (Date.now() - pageStarted)));
    const deadlineResult = () => ({ checks: [...pageChecks, createBrowserQACheckResult({
      checkId: input.runBudget ? "qa.run-budget" : "qa.page-budget", category: "RUNTIME", status: "FAIL", severity: "ERROR",
      failureKind: input.runBudget ? "RUN_DEADLINE_EXCEEDED" : "ROUTE_DEADLINE_EXCEEDED", route: input.route, viewport: input.viewport,
      message: input.runBudget ? "Browser QA total run timeout exceeded; remaining work was not validated" : "Browser QA route deadline exceeded; this route was not completely validated",
    })] });
    let openingProbe = false;
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
        if (popup === page || openingProbe) return;
        events.popups.push(Object.freeze({ type: "network", url: popup.url() || "about:blank", failureText: "Unexpected popup blocked" }));
        void popup.close().catch(() => undefined);
      });
      const observe = (observed: Page) => {
      observed.on("pageerror", (error) => events.pageErrors.push(error.message.slice(0, 2_000)));
      observed.on("console", (message) => {
        const evidence = Object.freeze({ type: "console" as const, level: message.type(), message: message.text().slice(0, 2_000) });
        if (message.type() === "error") events.consoleErrors.push(evidence);
        if (message.type() === "warning") events.consoleWarnings.push(evidence);
      });
      observed.on("requestfailed", (request) => events.failedRequests.push(networkEvidence(request, undefined, request.failure()?.errorText ?? "failed")));
      observed.on("response", (response) => {
        if (response.status() >= 400) events.badResponses.push(networkEvidence(response.request(), response.status()));
      });
      observed.on("dialog", (dialog) => {
        events.dialogs.push(Object.freeze({ type: "console", level: dialog.type(), message: dialog.message().slice(0, 1_000) }));
        void dialog.dismiss().catch(() => undefined);
      });
      observed.on("download", (download) => {
        events.downloads.push(Object.freeze({ type: "network", url: download.url(), failureText: "Unexpected download" }));
        if (!input.policy.allowDownloads) void download.cancel().catch(() => undefined);
      });
      };
      observe(page);
      await page.emulateMedia({ reducedMotion: input.policy.reducedMotion ? "reduce" : "no-preference" });
      const destination = new URL(input.route, input.baseUrl);
      if (destination.origin !== input.baseUrl.origin) throw new BrowserQAPolicyError("Browser QA routes must remain on the preview origin");
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
          failureKind: "NAVIGATION_FAILURE",
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
        get events() { return freezeEvents(events); },
        ...(screenshotRef === undefined ? {} : { screenshotRef }),
      };
      // Include errors raised by clicks/forms on isolated probe pages. Checking
      // startup errors before interactions would permanently record PASS even
      // when a later required control throws an uncaught exception.
      const finalEventChecks = new Set(["runtime.page-error", "runtime.console-error"]);
      const finalCheck = (check: BrowserQACheckExecutor) => check.afterInteractions || finalEventChecks.has(check.definition.checkId);
      const orderedChecks = [...input.checks.filter(check => !finalCheck(check)),
        ...input.checks.filter(check => check.afterInteractions && !finalEventChecks.has(check.definition.checkId)),
        ...input.checks.filter(check => finalEventChecks.has(check.definition.checkId))];
      for (const check of orderedChecks) {
        if (expired) return deadlineResult();
        let probe: Page | undefined;
        let routeLimitedCheck = false;
        try {
          if (check.appliesTo && !check.appliesTo(input.route, input.viewport)) {
            pageChecks.push(createBrowserQACheckResult({ checkId: check.definition.checkId, category: check.definition.category, status: "SKIPPED",
              severity: check.definition.defaultSeverity, route: input.route, viewport: input.viewport, message: "No requirement assigned to this route and viewport" }));
            continue;
          }
          // Interaction checks must not inherit overlays, scroll or modified
          // form/filter state from other probes. A separate page also lets us
          // abort a timed-out check without its pending clicks affecting the next.
          if (check.definition.category === "INTERACTION" || check.definition.category === "FORM") {
            openingProbe = true;
            try { probe = await context.newPage(); } finally { openingProbe = false; }
            observe(probe);
            await probe.emulateMedia({ reducedMotion: input.policy.reducedMotion ? "reduce" : "no-preference" });
            const response = await probe.goto(destination.toString(), { waitUntil: "load", timeout: input.policy.navigationTimeoutMs });
            if (!response?.ok()) throw new Error(`Interaction route failed to load (${response?.status() ?? "no response"})`);
            await probe.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          }
          const remainingMs = input.budgetMs - (Date.now() - pageStarted) - Math.min(250, input.budgetMs / 10);
          if (remainingMs <= 0) { expired = true; return deadlineResult(); }
          routeLimitedCheck = remainingMs < check.definition.timeoutMs;
          pageChecks.push(await withTimeout(check.execute(probe ? { ...pageContext, page: probe, get events() { return freezeEvents(events); } } : pageContext), Math.min(check.definition.timeoutMs, remainingMs), check.definition.checkId));
        } catch (error) {
          if (routeLimitedCheck && error instanceof BrowserQATimeoutError) expired = true;
          pageChecks.push(createBrowserQACheckResult({
            checkId: check.definition.checkId,
            category: check.definition.category,
            status: "FAIL",
            severity: "ERROR",
            failureKind: classifyBrowserQAFailure(error, check.definition.checkId),
            route: input.route,
            viewport: input.viewport,
            message: `Browser QA check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
          }));
        } finally {
          await probe?.close();
        }
      }
      return expired ? deadlineResult() : { checks: pageChecks };
    } catch (error) {
      if (expired) return deadlineResult();
      throw error;
    } finally {
      clearTimeout(deadline);
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

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
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
