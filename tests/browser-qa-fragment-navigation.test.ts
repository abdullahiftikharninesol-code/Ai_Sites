import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "../src/browser-qa/browser-qa-runtime-checks.js";
import { BROWSER_QA_VIEWPORTS, type BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

async function fixture(body: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body><div id="root">${body}</div></body></html>`);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("Generic missing-fragment blocking policy (local fixtures only)", () => {
  it.each(BROWSER_QA_VIEWPORTS)("accepts an existing section on $id", async (viewport) => {
    const report = await new BrowserQARunner().run({
      runId: `fragment-valid-${viewport.id}`,
      target: { baseUrl: await fixture('<a href="#section">Section</a><section id="section">Destination</section>') },
      viewports: [viewport],
      checks: browserQACoreCheckExecutors,
      policy: { captureScreenshots: false },
    });
    expect(report.status).toBe("PASS");
    expect(report.checks.find(({ checkId }) => checkId === "internal-links")).toMatchObject({ status: "PASS", severity: "ERROR" });
  });

  it.each(BROWSER_QA_VIEWPORTS)("blocks a missing section on $id, even with other warnings", async (viewport) => {
    const report = await new BrowserQARunner().run({
      runId: `fragment-missing-${viewport.id}`,
      target: { baseUrl: await fixture('<a href="#section">Section</a><script>console.warn("non-blocking fixture warning")</script>') },
      viewports: [viewport],
      checks: browserQACoreCheckExecutors,
      policy: { captureScreenshots: false },
    });
    expect(report.status).toBe("FAIL");
    expect(report.checks.find(({ checkId }) => checkId === "internal-links")).toMatchObject({
      status: "FAIL", severity: "ERROR",
      evidence: [{ type: "element", accessibleName: "missing fragment target: #section" }],
    });
    expect(report.checks.find(({ checkId }) => checkId === "runtime.console-error")).toMatchObject({ status: "WARNING", severity: "WARNING" });
  });

  it.each([
    ["console warning", '<script>console.warn("ordinary warning")</script>'],
    ["empty href advisory", '<a href="">Empty</a>'],
    ["protocol-relative link advisory", '<a href="//example.invalid/">External link (not followed)</a>'],
  ])("preserves PASS_WITH_WARNINGS for an unrelated %s", async (_label, body) => {
    const report = await new BrowserQARunner().run({
      runId: "unrelated-warning",
      target: { baseUrl: await fixture(body) },
      viewports: [BROWSER_QA_VIEWPORTS[0]!],
      checks: browserQACoreCheckExecutors,
      policy: { captureScreenshots: false },
    });
    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.checks.filter(({ status, severity }) => status === "FAIL" && severity === "ERROR")).toHaveLength(0);
  });
});

describe("Original Restaurant authoring template, offline build and Browser QA", () => {
  let temporaryRoot: string;
  let previewServer: PreviewServer | undefined;
  let browser: Browser | undefined;
  let baseUrl: string;
  let report: BrowserQAReport;
  let routes: string[];

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "restaurant-phase7k-"));
    const templateRoot = resolve("templates/restaurant");
    const metadata = JSON.parse(await readFile(join(templateRoot, "site-template.json"), "utf8")) as { routes: { path: string }[] };
    routes = metadata.routes.map(({ path }) => path);
    const buildDirectory = join(temporaryRoot, "dist");
    const build = await promisify(execFile)(process.execPath, [
      join(templateRoot, "node_modules/vite/bin/vite.js"), "build", "--outDir", buildDirectory, "--emptyOutDir",
    ], { cwd: templateRoot, timeout: 60_000 });
    const evidenceDirectory = resolve(".sites-runtime/phase7k");
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, "restaurant-build.log"), `${build.stdout}\n${build.stderr}`);
    previewServer = await preview({ root: templateRoot, configFile: false, build: { outDir: buildDirectory }, preview: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
    const address = previewServer.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Restaurant preview did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    report = await new BrowserQARunner().run({
      runId: "phase7k-restaurant-offline",
      target: { baseUrl },
      routes,
      viewports: BROWSER_QA_VIEWPORTS,
      checks: [...browserQACoreCheckExecutors, ...browserQAResponsiveAndInteractionChecks, ...browserQARuntimeChecks],
      policy: { captureScreenshots: false },
    });
    await writeFile(join(evidenceDirectory, "restaurant-browser-qa.json"), JSON.stringify(report, null, 2));
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (previewServer) await new Promise<void>((done) => previewServer!.httpServer.close(() => done()));
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("builds and loads every declared route with no blocking or missing-fragment failures", () => {
    expect(report.status).not.toBe("FAIL");
    expect(report.routes).toEqual([...routes].sort());
    expect(report.checks.filter(({ status, severity }) => status === "FAIL" && severity === "ERROR")).toHaveLength(0);
    expect(report.checks.filter(({ message, evidence }) => /missing fragment/i.test(message) || evidence?.some((item) => item.type === "element" && /missing fragment/i.test(item.accessibleName ?? "")))).toHaveLength(0);
    expect(report.checks.filter(({ checkId }) => checkId === "page-readiness")).toHaveLength(routes.length * 3);
    expect(report.checks.filter(({ checkId }) => checkId === "runtime.page-error").every(({ status }) => status === "PASS")).toBe(true);
  });

  it.each(BROWSER_QA_VIEWPORTS)("preserves routes and working location navigation on $id", async (viewport) => {
    const viewportChecks = report.checks.filter((check) => check.viewport?.id === viewport.id);
    expect(viewportChecks.filter(({ status, severity }) => status === "FAIL" && severity === "ERROR")).toHaveLength(0);
    expect(viewportChecks.filter(({ checkId }) => checkId === "internal-links").every(({ status }) => status === "PASS")).toBe(true);
    expect(viewportChecks.filter(({ checkId }) => checkId === "route.load").every(({ status }) => status === "PASS")).toBe(true);
    if (!browser) throw new Error("Browser unavailable");
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      for (const route of routes) {
        const response = await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        await page.locator('footer a[href="/contact#map"]').click();
        await page.waitForURL(`${baseUrl}/contact#map`);
        await expect.poll(() => page.locator("#map.map-art").count()).toBe(1);
        await expect.poll(() => page.locator("#map").evaluate((element) => {
          const rectangle = element.getBoundingClientRect();
          return rectangle.bottom > 0 && rectangle.top < window.innerHeight;
        })).toBe(true);
      }
      await page.goto(`${baseUrl}/contact`, { waitUntil: "networkidle" });
      await page.locator('.visit-details a[href="#map"]').click();
      expect(new URL(page.url()).hash).toBe("#map");
      expect(await page.locator("#map").isVisible()).toBe(true);
      expect(pageErrors).toHaveLength(0);
    } finally { await page.close(); }
  }, 60_000);
});
