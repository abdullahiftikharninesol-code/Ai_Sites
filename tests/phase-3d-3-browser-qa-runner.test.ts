import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserQARunner,
  DEFAULT_BROWSER_QA_RUNNER_POLICY,
} from "../src/browser-qa/browser-qa-runner.js";
import { PLACEHOLDER_PNG } from "../src/sites/assets/media-store.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureServer(
  body = "<div id=\"root\"><h1>Browser QA</h1></div>",
  assets: Readonly<Record<string, Uint8Array>> = {},
): Promise<string> {
  const server = createServer((request, response) => {
    const asset = request.url ? assets[request.url] : undefined;
    if (asset) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(asset);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body>${body}</body></html>`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return `http://127.0.0.1:${address.port}/`;
}

describe("Layer 3D.3 Browser QA runner", () => {
  it("enforces the configured route deadline and releases the browser", async () => {
    const runner = new BrowserQARunner();
    const report = await runner.run({ runId: "route-deadline", target: { baseUrl: await fixtureServer() },
      viewports: [{ id: "DESKTOP", width: 1440, height: 900 }],
      policy: { captureScreenshots: false, perPageTimeoutMs: 1000, totalTimeoutMs: 10000 },
      checks: [{ definition: { checkId: "slow.fixture", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 5000 },
        execute: async ({ page }) => { await page.waitForTimeout(3000); return { checkId: "slow.fixture", category: "INTERACTION", status: "PASS", severity: "ERROR", message: "Delayed fixture" }; } }],
    });
    expect(report.status).toBe("FAIL");
    expect(report.checks).toContainEqual(expect.objectContaining({ checkId: "qa.page-budget", status: "FAIL" }));
    expect(runner.activeBrowserCount).toBe(0);
  });
  it("allows normal Chromium startup time and retries a transient launch timeout", async () => {
    let attempts = 0;
    const runner = new BrowserQARunner({
      launchBrowser: async (options) => {
        attempts++;
        if (attempts === 1) {
          const error = new Error("browserType.launch: Timeout exceeded");
          error.name = "TimeoutError";
          throw error;
        }
        return chromium.launch(options);
      },
    });

    const report = await runner.run({
      runId: "runner-launch-retry",
      target: { baseUrl: await fixtureServer() },
      routes: ["/"],
      viewports: [{ id: "MOBILE", width: 390, height: 844 }],
      policy: { captureScreenshots: false },
    });

    expect(DEFAULT_BROWSER_QA_RUNNER_POLICY.browserLaunchTimeoutMs).toBe(30_000);
    expect(attempts).toBe(2);
    expect(report.status).toBe("PASS");
    expect(runner.activeBrowserCount).toBe(0);
  });

  it("loads a preview target in isolated Chromium contexts and cleans up", async () => {
    const runner = new BrowserQARunner();
    const report = await runner.run({
      runId: "runner-success",
      target: { baseUrl: await fixtureServer() },
      routes: ["/"],
      viewports: [{ id: "MOBILE", width: 390, height: 844 }],
      policy: { captureScreenshots: false },
    });
    expect(report.status).toBe("PASS");
    expect(report.browser.name).toBe("chromium");
    expect(report.checks[0]?.checkId).toBe("page-readiness");
    expect(runner.activeBrowserCount).toBe(0);
  });

  it("uses the remote-compatible base URL contract and keeps route scope local", async () => {
    const baseUrl = await fixtureServer();
    const runner = new BrowserQARunner();
    const report = await runner.run({
      runId: "runner-routes",
      target: { baseUrl, projectId: "project", siteVersionId: "version" },
      routes: ["/", "/secondary"],
      viewports: [{ id: "DESKTOP", width: 1440, height: 900 }],
      policy: { captureScreenshots: false },
    });
    expect(report.routes).toEqual(["/", "/secondary"]);
    expect(report.projectId).toBe("project");
    expect(report.siteVersionId).toBe("version");
    expect(runner.activeBrowserCount).toBe(0);
  });

  it("records browser events before navigation and blocks unexpected origins", async () => {
    const runner = new BrowserQARunner();
    const report = await runner.run({
      runId: "runner-events",
      target: { baseUrl: await fixtureServer("<div id=\"root\"><script>console.error('fixture-error'); fetch('https://example.invalid/secret')</script></div>") },
      viewports: [{ id: "TABLET", width: 768, height: 1024 }],
      checks: [{
        definition: { checkId: "event-check", version: 1, category: "NETWORK", defaultSeverity: "WARNING", scope: "PAGE", timeoutMs: 1_000 },
        async execute(context) {
          expect(context.events.consoleErrors.length).toBeGreaterThan(0);
          expect(context.events.blockedRequests.length).toBeGreaterThan(0);
          return { checkId: "event-check", category: "NETWORK", status: "PASS", severity: "WARNING", message: "events captured" };
        },
      }],
      policy: { captureScreenshots: false },
    });
    expect(report.summary.passed).toBe(2);
    expect(runner.activeBrowserCount).toBe(0);
  });

  it("does not report a broken image when a neutral fallback is served", async () => {
    const fallbackPath = `/__sites/assets/${createHash("sha256").update(PLACEHOLDER_PNG).digest("hex")}.png`;
    const runner = new BrowserQARunner();
    const report = await runner.run({
      runId: "runner-neutral-fallback",
      target: { baseUrl: await fixtureServer(`<img src="${fallbackPath}" alt="Neutral fallback" />`, { [fallbackPath]: PLACEHOLDER_PNG }) },
      viewports: [{ id: "DESKTOP", width: 1440, height: 900 }],
      checks: [{
        definition: { checkId: "fallback-image", version: 1, category: "RUNTIME", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 1_000 },
        async execute(context) {
          const broken = await context.page.locator("img").evaluate((image) => {
            const fallback = image as HTMLImageElement;
            return !fallback.complete || fallback.naturalWidth === 0;
          });
          return broken
            ? { checkId: "fallback-image", category: "RUNTIME", status: "FAIL", severity: "ERROR", message: "Fallback image did not load" }
            : { checkId: "fallback-image", category: "RUNTIME", status: "PASS", severity: "ERROR", message: "Neutral fallback image loaded" };
        },
      }],
      policy: { captureScreenshots: false },
    });
    expect(report.status).toBe("PASS");
    expect(runner.activeBrowserCount).toBe(0);
  });
});
