import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { BROWSER_QA_VIEWPORTS, type BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { browserQARuntimeChecks } from "../src/browser-qa/browser-qa-runtime-checks.js";
import { TrustedInternalTemplateBuildRunner } from "../src/templates/publishing/template-build.js";
import { StaticTemplatePreviewServer, type TemplatePreviewServerSession } from "../src/templates/publishing/template-preview-server.js";
import { copyCleanTemplateSource, validateTemplateSource } from "../src/templates/publishing/template-source.js";

describe("Corporate Business offline instantiation Browser QA", () => {
  let temporaryRoot: string | undefined;
  let preview: TemplatePreviewServerSession | undefined;
  let browser: Browser | undefined;
  let report: BrowserQAReport;
  let routes: string[];

  beforeAll(async () => {
    // Frozen installation uses only the local npm cache; no product bootstrap,
    // provider, catalog, Mongo, Redis, GCS or SiteProject creation is involved.
    vi.stubEnv("npm_config_offline", "true");
    const templateRoot = resolve("templates/corporate-business");
    const manifest = JSON.parse(await readFile(join(templateRoot, "site-template.json"), "utf8")) as { routes: { path: string }[] };
    routes = manifest.routes.map(({ path }) => path);
    temporaryRoot = await mkdtemp(join(tmpdir(), "corporate-business-qa-"));
    const buildDirectory = join(temporaryRoot, "source");
    await copyCleanTemplateSource(await validateTemplateSource(templateRoot), buildDirectory);
    await new TrustedInternalTemplateBuildRunner().build(buildDirectory);
    preview = await new StaticTemplatePreviewServer().start(join(buildDirectory, "dist"));
    report = await new BrowserQARunner().run({
      runId: "corporate-business-offline-qa",
      target: { baseUrl: preview.baseUrl }, routes, viewports: BROWSER_QA_VIEWPORTS,
      // Exact check set used by TemplateInstantiationService.instantiate.
      checks: [
        ...browserQACoreCheckExecutors,
        ...browserQAResponsiveAndInteractionChecks,
        ...browserQARuntimeChecks.filter(({ definition }) => definition.checkId !== "broken-images"),
      ],
    });
    const evidenceDirectory = resolve(".sites-runtime/corporate-business-qa");
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, `${report.status.toLowerCase()}-report.json`), JSON.stringify(report, null, 2));
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await preview?.close();
    vi.unstubAllEnvs();
    if (temporaryRoot) {
      const target = resolve(temporaryRoot);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("corporate-business-qa-"))
        throw new Error("Refusing cleanup outside the allocated QA temporary directory");
      await rm(target, { recursive: true, force: true });
    }
  });

  it("passes instantiation gates on all five routes without page errors", () => {
    expect(routes).toEqual(["/", "/services", "/industries", "/about", "/contact"]);
    expect(report.checks.filter(({ status, severity }) => status === "FAIL" && severity === "ERROR")).toEqual([]);
    expect(report.status).not.toBe("FAIL");
    expect(report.checks.filter(({ checkId }) => checkId === "route.load")).toHaveLength(15);
    expect(report.checks.filter(({ checkId }) => checkId === "runtime.page-error")).toHaveLength(15);
    expect(report.checks.filter(({ checkId }) => checkId === "runtime.page-error").every(({ status }) => status === "PASS")).toBe(true);
  });

  it.each(BROWSER_QA_VIEWPORTS)("keeps real CTA navigation and all routes working on $id", async (viewport) => {
    const checks = report.checks.filter((check) => check.viewport?.id === viewport.id);
    expect(checks.filter(({ status, severity }) => status === "FAIL" && severity === "ERROR")).toEqual([]);
    expect(checks.filter(({ checkId }) => checkId === "internal-links")).toHaveLength(5);
    expect(checks.filter(({ checkId }) => checkId === "internal-links").every(({ status }) => status === "PASS")).toBe(true);
    expect(checks.filter(({ checkId }) => checkId === "route.load").every(({ status }) => status === "PASS")).toBe(true);
    if (!browser || !preview) throw new Error("Local QA browser/preview unavailable");
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      for (const route of routes) {
        const response = await page.goto(new URL(route, preview.baseUrl).toString(), { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        expect(await page.locator("main h1").count()).toBe(1);
      }
      for (const [route, selector, count] of [
        ["/", ".insight a", 1],
        ["/services", ".service-detail a", 4],
        ["/industries", ".sector-grid a", 6],
      ] as const) {
        for (let index = 0; index < count; index++) {
          await page.goto(new URL(route, preview.baseUrl).toString(), { waitUntil: "networkidle" });
          const link = page.locator(selector).nth(index);
          expect(await link.getAttribute("href")).toBe("/contact");
          await link.click();
          await page.waitForURL(`${preview.baseUrl}/contact`);
          expect(await page.locator("form").count()).toBe(1);
        }
      }
      expect(pageErrors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
