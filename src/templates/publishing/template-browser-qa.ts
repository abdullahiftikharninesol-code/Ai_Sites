import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { browserQACoreCheckExecutors } from "../../browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../../browser-qa/browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "../../browser-qa/browser-qa-runtime-checks.js";
import {
  BROWSER_QA_VIEWPORTS,
  createBrowserQACheckResult,
  type BrowserQACheckResult,
  type BrowserQAReport,
  type BrowserQAViewport,
} from "../../browser-qa/browser-qa-domain.js";
import {
  BrowserQARunner,
  type BrowserQACheckExecutor,
  type BrowserQAPageContext,
  type BrowserQARunRequest,
} from "../../browser-qa/browser-qa-runner.js";
import {
  StaticTemplatePreviewServer,
  type TemplatePreviewServer,
  type TemplatePreviewServerSession,
} from "./template-preview-server.js";

export const TEMPLATE_PREVIEW_NAMES = ["desktop", "tablet", "mobile"] as const;
export type TemplatePreviewName = (typeof TEMPLATE_PREVIEW_NAMES)[number];

export interface GeneratedTemplatePreview {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface TemplateBrowserQAResult {
  readonly passed: true;
  readonly routesChecked: number;
  readonly viewportsChecked: number;
  readonly report: BrowserQAReport;
  readonly previews: Readonly<Record<TemplatePreviewName, GeneratedTemplatePreview>>;
}

export interface TemplateBrowserQAInput {
  readonly buildDirectory: string;
  readonly routes: readonly string[];
  readonly previewDirectory: string;
}

export interface TemplateBrowserQA {
  run(input: TemplateBrowserQAInput): Promise<TemplateBrowserQAResult>;
}

interface TemplateBrowserRunner {
  readonly activeBrowserCount: number;
  run(request: BrowserQARunRequest): Promise<BrowserQAReport>;
}

const corePageError = requireExecutor(browserQACoreCheckExecutors, "runtime.page-error");
const coreRouteLoad = requireExecutor(browserQACoreCheckExecutors, "route.load");
const sharedOverflow = requireExecutor(
  browserQAResponsiveAndInteractionChecks,
  "responsive-overflow",
);
const sharedInteraction = requireExecutor(
  browserQAResponsiveAndInteractionChecks,
  "interaction-smoke",
);
const sharedSafetyEvents = requireExecutor(
  browserQAResponsiveAndInteractionChecks,
  "browser-safety-events",
);
const sharedBrokenImages = requireExecutor(browserQARuntimeChecks, "broken-images");

export interface PlaywrightTemplateBrowserQAOptions {
  readonly previewServer?: TemplatePreviewServer;
  readonly runner?: TemplateBrowserRunner;
}

export class PlaywrightTemplateBrowserQA implements TemplateBrowserQA {
  readonly #previewServer: TemplatePreviewServer;
  readonly #runner: TemplateBrowserRunner;

  constructor(options: PlaywrightTemplateBrowserQAOptions = {}) {
    this.#previewServer = options.previewServer ?? new StaticTemplatePreviewServer();
    this.#runner = options.runner ?? new BrowserQARunner();
  }

  get activeBrowserCount(): number {
    return this.#runner.activeBrowserCount;
  }

  get activeServerCount(): number {
    return this.#previewServer.activeSessionCount;
  }

  async run(input: TemplateBrowserQAInput): Promise<TemplateBrowserQAResult> {
    await mkdir(input.previewDirectory, { recursive: true });
    let session: TemplatePreviewServerSession;
    try {
      session = await this.#previewServer.start(join(input.buildDirectory, "dist"));
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "TEMPLATE_PREVIEW_SERVER_FAILED")
        throw error;
      throw new ApplicationError(
        "TEMPLATE_PREVIEW_SERVER_FAILED",
        "Unable to start the template preview server",
        { cause: error },
      );
    }

    let report: BrowserQAReport | undefined;
    let failure: ApplicationError | undefined;
    try {
      const checks = templateChecks(session.baseUrl, input.previewDirectory);
      report = await this.#runner.run({
        runId: "template-publication-qa",
        target: { baseUrl: session.baseUrl },
        routes: input.routes,
        viewports: BROWSER_QA_VIEWPORTS,
        checks,
        policy: {
          browserLaunchTimeoutMs: 30_000,
          browserLaunchRetries: 1,
          navigationTimeoutMs: 15_000,
          perPageTimeoutMs: 30_000,
          totalTimeoutMs: 120_000,
          captureScreenshots: false,
          reducedMotion: true,
          permissions: [],
          allowDownloads: false,
        },
      });
    } catch (error) {
      failure = new ApplicationError(
        "TEMPLATE_BROWSER_QA_FAILED",
        `Template Browser QA runner failed: ${safeMessage(error)}`,
        {
          cause: error,
          metadata: { check: "browser-runner" },
        },
      );
    }

    try {
      await session.close();
    } catch (error) {
      failure ??= new ApplicationError(
        "TEMPLATE_PREVIEW_SERVER_FAILED",
        "Template preview server cleanup failed",
        { cause: error },
      );
    }
    if (failure) throw failure;
    if (!report) throw new ApplicationError("TEMPLATE_BROWSER_QA_FAILED", "Browser QA produced no report");

    const captureFailure = report.checks.find(
      (check) => check.checkId === "template.preview-capture" && check.status === "FAIL",
    );
    if (captureFailure)
      throw checkError("TEMPLATE_PREVIEW_CAPTURE_FAILED", captureFailure);

    const blockingFailure = report.checks.find(
      (check) => check.status === "FAIL" && check.severity === "ERROR",
    );
    if (blockingFailure) throw checkError("TEMPLATE_BROWSER_QA_FAILED", blockingFailure);

    const previews = await readGeneratedPreviews(input.previewDirectory);
    return {
      passed: true,
      routesChecked: [...new Set(input.routes)].length,
      viewportsChecked: BROWSER_QA_VIEWPORTS.length,
      report,
      previews,
    };
  }
}

function templateChecks(baseUrl: string, previewDirectory: string): readonly BrowserQACheckExecutor[] {
  return [
    corePageError,
    seriousConsoleCheck,
    localNetworkCheck(new URL(baseUrl).origin),
    coreRouteLoad,
    meaningfulContentCheck,
    blocking(sharedOverflow),
    localBrokenImagesCheck,
    blocking(sharedInteraction),
    sharedSafetyEvents,
    previewCaptureCheck(previewDirectory),
  ];
}

const seriousConsoleCheck: BrowserQACheckExecutor = {
  definition: definition("template.console-error", "CONSOLE", 1_000),
  execute(context) {
    const serious = context.events.consoleErrors.filter(
      (entry) =>
        entry.type === "console" &&
        !/^warning:/i.test(entry.message) &&
        !/failed to load resource|net::err_blocked_by_client/i.test(entry.message),
    );
    if (serious.length)
      return Promise.resolve(pageResult(context, {
        checkId: "template.console-error",
        category: "CONSOLE",
        status: "FAIL",
        severity: "ERROR",
        message: `${serious.length} serious console error${serious.length === 1 ? "" : "s"}`,
        evidence: serious,
      }));
    const advisory = [
      ...context.events.consoleWarnings,
      ...context.events.consoleErrors.filter((entry) => !serious.includes(entry)),
    ];
    return Promise.resolve(pageResult(context, advisory.length
      ? {
          checkId: "template.console-error",
          category: "CONSOLE",
          status: "WARNING",
          severity: "WARNING",
          message: `${advisory.length} non-fatal console warning${advisory.length === 1 ? "" : "s"}`,
          evidence: advisory,
        }
      : {
          checkId: "template.console-error",
          category: "CONSOLE",
          status: "PASS",
          severity: "ERROR",
          message: "No serious console errors",
        }));
  },
};

function localNetworkCheck(origin: string): BrowserQACheckExecutor {
  return {
    definition: definition("template.local-resources", "NETWORK", 1_000),
    execute(context) {
      const observed = [...context.events.failedRequests, ...context.events.badResponses];
      const localFailures = observed.filter((entry) => {
        if (entry.type !== "network" || !sameOrigin(entry.url, origin)) return false;
        return ["document", "script", "stylesheet", "fetch", "xhr", "font"].includes(
          entry.resourceType ?? "",
        );
      });
      if (localFailures.length)
        return Promise.resolve(pageResult(context, {
          checkId: "template.local-resources",
          category: "NETWORK",
          status: "FAIL",
          severity: "ERROR",
          message: `${localFailures.length} required local application resource${localFailures.length === 1 ? "" : "s"} failed`,
          evidence: localFailures,
        }));
      const external = [
        ...context.events.blockedRequests,
        ...observed.filter((entry) => entry.type === "network" && !sameOrigin(entry.url, origin)),
      ];
      return Promise.resolve(pageResult(context, external.length
        ? {
            checkId: "template.local-resources",
            category: "NETWORK",
            status: "WARNING",
            severity: "WARNING",
            message: `${external.length} optional external request${external.length === 1 ? " was" : "s were"} unavailable`,
            evidence: external,
          }
        : {
            checkId: "template.local-resources",
            category: "NETWORK",
            status: "PASS",
            severity: "ERROR",
            message: "Required local application resources loaded",
          }));
    },
  };
}

const meaningfulContentCheck: BrowserQACheckExecutor = {
  definition: definition("template.meaningful-content", "RUNTIME", 2_000),
  async execute(context) {
    const content = await context.page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("#root, [data-sites-page]") ?? document.body;
      const bodyBox = document.body.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      const visibleMedia = [...root.querySelectorAll("img, svg, video, canvas")].some((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      return {
        bodyWidth: bodyBox.width,
        bodyHeight: bodyBox.height,
        rootWidth: rootBox.width,
        rootHeight: rootBox.height,
        visibleTextLength: (root.innerText ?? "").replace(/\s+/g, " ").trim().length,
        childCount: root.children.length,
        visibleMedia,
      };
    });
    const dimensionsValid =
      content.bodyWidth > 0 &&
      content.bodyHeight > 0 &&
      content.rootWidth > 0 &&
      content.rootHeight > 0;
    const meaningful =
      dimensionsValid &&
      content.childCount > 0 &&
      (content.visibleTextLength > 0 || content.visibleMedia);
    return pageResult(context, meaningful
      ? {
          checkId: "template.meaningful-content",
          category: "RUNTIME",
          status: "PASS",
          severity: "ERROR",
          message: "Page contains visible content with nonzero body and root dimensions",
        }
      : {
          checkId: "template.meaningful-content",
          category: "RUNTIME",
          status: "FAIL",
          severity: "ERROR",
          message: "Page is blank, lacks meaningful visible content, or has collapsed dimensions",
        });
  },
};

const localBrokenImagesCheck: BrowserQACheckExecutor = {
  ...sharedBrokenImages,
  definition: { ...sharedBrokenImages.definition, checkId: "template.broken-images" },
  async execute(context) {
    const shared = await sharedBrokenImages.execute(context);
    const localEvidence = shared.evidence?.filter(
      (entry) => entry.type === "network" && sameOrigin(entry.url, new URL(context.page.url()).origin),
    );
    if (shared.status === "FAIL" && localEvidence?.length)
      return createBrowserQACheckResult({
        ...shared,
        checkId: "template.broken-images",
        severity: "ERROR",
        evidence: localEvidence,
        message: `${localEvidence.length} visible local image${localEvidence.length === 1 ? "" : "s"} failed to load`,
      });
    return createBrowserQACheckResult({
      ...shared,
      checkId: "template.broken-images",
      ...(shared.status === "FAIL" ? { status: "WARNING", severity: "WARNING" } : {}),
    });
  },
};

function previewCaptureCheck(previewDirectory: string): BrowserQACheckExecutor {
  return {
    definition: definition("template.preview-capture", "ASSET", 15_000),
    async execute(context) {
      if (context.route !== "/")
        return pageResult(context, {
          checkId: "template.preview-capture",
          category: "ASSET",
          status: "SKIPPED",
          severity: "INFO",
          message: "Gallery previews are captured from the home route only",
        });
      await stabilizeForScreenshot(context);
      const session = await context.context.newCDPSession(context.page);
      try {
        const value: unknown = await session.send("Page.captureScreenshot", {
          format: "webp",
          quality: 85,
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const data = screenshotData(value);
        const bytes = Buffer.from(data, "base64");
        if (!isWebP(bytes)) throw new Error("Chromium did not return a valid WebP screenshot");
        const name = viewportPreviewName(context.viewport);
        await writeFile(join(previewDirectory, `${name}.webp`), bytes);
        return pageResult(context, {
          checkId: "template.preview-capture",
          category: "ASSET",
          status: "PASS",
          severity: "ERROR",
          message: `${name}.webp generated (${bytes.byteLength} bytes)`,
        });
      } finally {
        await session.detach().catch(() => undefined);
      }
    },
  };
}

async function stabilizeForScreenshot(context: BrowserQAPageContext): Promise<void> {
  await context.page.addStyleTag({
    content: "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}",
  });
  await context.page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolvePromise) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise())),
    );
    window.scrollTo(0, 0);
  });
}

async function readGeneratedPreviews(
  directory: string,
): Promise<Readonly<Record<TemplatePreviewName, GeneratedTemplatePreview>>> {
  const result = {} as Record<TemplatePreviewName, GeneratedTemplatePreview>;
  for (const name of TEMPLATE_PREVIEW_NAMES) {
    const path = join(directory, `${name}.webp`);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size < 12) throw new Error("Generated preview is empty");
      result[name] = { path, sizeBytes: info.size };
    } catch (error) {
      throw new ApplicationError(
        "TEMPLATE_PREVIEW_CAPTURE_FAILED",
        `${name}.webp was not generated`,
        { cause: error, metadata: { route: "/", viewport: name.toUpperCase(), check: "template.preview-capture" } },
      );
    }
  }
  return Object.freeze(result);
}

function blocking(executor: BrowserQACheckExecutor): BrowserQACheckExecutor {
  return {
    ...executor,
    definition: { ...executor.definition, defaultSeverity: "ERROR" },
    async execute(context) {
      const result = await executor.execute(context);
      return result.status === "FAIL"
        ? createBrowserQACheckResult({ ...result, severity: "ERROR" })
        : result;
    },
  };
}

function definition(
  checkId: string,
  category: BrowserQACheckResult["category"],
  timeoutMs: number,
): BrowserQACheckExecutor["definition"] {
  return { checkId, version: 1, category, defaultSeverity: "ERROR", scope: "PAGE", timeoutMs };
}

function pageResult(
  context: BrowserQAPageContext,
  input: Omit<BrowserQACheckResult, "route" | "viewport">,
): BrowserQACheckResult {
  return createBrowserQACheckResult({ ...input, route: context.route, viewport: context.viewport });
}

function requireExecutor(
  executors: readonly BrowserQACheckExecutor[],
  checkId: string,
): BrowserQACheckExecutor {
  const executor = executors.find((candidate) => candidate.definition.checkId === checkId);
  if (!executor) throw new Error(`Missing shared Browser QA executor '${checkId}'`);
  return executor;
}

function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function viewportPreviewName(viewport: BrowserQAViewport): TemplatePreviewName {
  const name = viewport.id.toLowerCase();
  if (name === "desktop" || name === "tablet" || name === "mobile") return name;
  throw new Error(`Unsupported template preview viewport '${viewport.id}'`);
}

function screenshotData(value: unknown): string {
  if (typeof value === "object" && value !== null && "data" in value) {
    const data = (value as { readonly data?: unknown }).data;
    if (typeof data === "string" && data.length > 0) return data;
  }
  throw new Error("Chromium screenshot response did not contain image data");
}

function isWebP(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}

function checkError(
  code: "TEMPLATE_BROWSER_QA_FAILED" | "TEMPLATE_PREVIEW_CAPTURE_FAILED",
  check: BrowserQACheckResult,
): ApplicationError {
  const viewport = check.viewport?.id ?? "UNKNOWN";
  const route = check.route ?? "UNKNOWN";
  return new ApplicationError(
    code,
    `route=${route} viewport=${viewport} check=${check.checkId}: ${check.message}`,
    { metadata: { route, viewport, check: check.checkId, message: check.message } },
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
}
