import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { functionalRequirements, assertFunctionalBackendSupport, functionalGenerationContract } from "../src/sites/generation/functional-capabilities.js";
import { generationPromptCorpus } from "./fixtures/generation-prompt-corpus.js";
import { requestedPages } from "../src/sites/generation/requested-pages.js";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { functionalBrowserChecks } from "../src/browser-qa/functional-capability-checks.js";
import { BROWSER_QA_VIEWPORTS } from "../src/browser-qa/browser-qa-domain.js";
import { classifyBrowserQAFailure, FunctionalValidationError } from "../src/browser-qa/browser-qa-failure.js";
import { analyzeRequestProfile } from "../src/sites/generation/request-profile.js";

const servers: Server[] = [];
afterAll(async () => { await Promise.all(servers.map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
async function fixture(html: string) {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  servers.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  return `http://127.0.0.1:${address.port}`;
}

describe("General-purpose deterministic request corpus", () => {
  it.each(generationPromptCorpus)("preserves $name requirements independent of prompt length", ({ prompt, required, excluded }) => {
    for (const prefix of ["", "Use coherent typography, spacing and responsive layouts.\n".repeat(300)]) {
      const result = functionalRequirements(prefix + prompt);
      expect([...result.capabilities].sort()).toEqual([...required].sort());
      expect(() => assertFunctionalBackendSupport(result)).not.toThrow();
      for (const id of excluded ?? []) expect(result.capabilities).not.toContain(id);
      expect(new Set(result.requirements?.map(item => item.id)).size).toBe(result.requirements?.length);
      for (const requirement of result.requirements ?? []) {
        expect(requirement.expectedBehavior).toBeTruthy(); expect(requirement.mandatory).toBe(true);
        expect(requirement.validation).toBe("BROWSER_BEHAVIOR");
      }
    }
  });
  it.each([
    ["Search would be nice if possible.", [], ["search"]],
    ["Add a contact form and optionally include newsletter.", ["form"], ["newsletter"]],
    ["Optionally include search and newsletter. Add FAQ accordion.", ["accordion"], ["search", "newsletter"]],
    ["Optionally include search, add a contact form.", ["form"], ["search"]],
    ["Search would be nice if possible. Add working search.", ["search"], []],
    ["Add search and optionally include newsletter.", ["search"], ["newsletter"]],
    ["Add a contact form with an optional newsletter.", ["form"], ["newsletter"]],
  ])("keeps optional and mandatory intent separate: %s", (prompt, mandatory, optional) => {
    const result = functionalRequirements(prompt);
    expect([...result.capabilities].sort()).toEqual([...mandatory].sort());
    expect([...(result.optionalCapabilities ?? [])].sort()).toEqual([...optional].sort());
    if (optional.length) expect(functionalGenerationContract(result)).toContain("not mandatory completion gates");
  });
  it.each(["Implement a live payment processing system.", "Process real payments and charge credit cards.", "Add live reservations."])("rejects unconfigured transactions: %s", prompt => {
    expect(() => assertFunctionalBackendSupport(functionalRequirements(prompt))).toThrow(/no configured implementation/);
  });
  it("does not treat a ban on real transactions as a request for them", () => {
    expect(() => assertFunctionalBackendSupport(functionalRequirements("Add a contact form. Do not send real emails. Do not charge cards. Use honest local demo feedback."))).not.toThrow();
  });
  it("does not swallow an independent mandatory instruction after an exclusion", () => {
    const result = functionalRequirements("No search and add a contact form and do not include newsletter.");
    expect(result.capabilities).toEqual(["form"]);
    expect(result.excludedCapabilities).toEqual(["search", "newsletter"]);
  });
  it("does not turn bans on fake handlers into bans on the required capability", () => {
    const result = functionalRequirements("Add a contact form. No alert-only handlers for a contact form. No newsletter or shopping cart.");
    expect(result.capabilities).toEqual(["form"]);
    expect(result.excludedCapabilities).toEqual(["cart", "newsletter"]);
    expect(result.conflictingCapabilities).toBeUndefined();
    expect(functionalGenerationContract(result)).not.toContain("Explicitly excluded capabilities: form");
  });
  it("recognizes directly qualified exclusions without confusing explanatory keyword mentions", () => {
    expect(functionalRequirements("Do not include product search.").excludedCapabilities).toEqual(["search"]);
    expect(() => assertFunctionalBackendSupport(functionalRequirements("Add working product search. Do not include product search."))).toThrow(/Conflicting/);
    expect(() => assertFunctionalBackendSupport(functionalRequirements("Add a contact form. Do not include functional contact forms."))).toThrow(/Conflicting/);
  });
  it("uses the existing planner complexity rules only on affirmative requirements", () => {
    expect(analyzeRequestProfile("Build a consultancy. Do not include checkout or authenticated areas.").needsAgentPlanning).toBe(false);
    expect(analyzeRequestProfile("Build a member portal with authenticated areas.").needsAgentPlanning).toBe(true);
    expect(analyzeRequestProfile("Build an authenticated member portal with optional newsletter.").needsAgentPlanning).toBe(true);
    expect(analyzeRequestProfile("Build a business website. A checkout would be nice if possible.").needsAgentPlanning).toBe(false);
  });
  it("keeps explicit contradictions blocking and vague inspiration free of invented requirements", () => {
    expect(() => assertFunctionalBackendSupport(functionalRequirements("Add search. Do not include search."))).toThrow(/Conflicting/);
    expect(functionalRequirements("Make it like Amazon, using a polished design.").capabilities).toEqual([]);
  });
  it("preserves unusual explicit route names without inventing feature pages", () => {
    const pages = requestedPages("Pages: Home, Repair Collective (/repair-network), Learning Lab (/learn).\nAdd a contact form and team profiles.");
    expect(pages.map(page => page.path)).toEqual(["/", "/repair-network", "/learn"]);
  });
});

describe("Honest QA failure classification and pointer actionability", () => {
  it.each([
    ["TimeoutError", "locator.hover: Timeout 800ms exceeded; another subtree intercepts pointer events", "ACTIONABILITY_TIMEOUT"],
    ["TimeoutError", "locator.click: Timeout 800ms exceeded", "ACTIONABILITY_TIMEOUT"],
    ["TimeoutError", "locator.waitFor: Timeout exceeded", "READINESS_TIMEOUT"],
    ["BrowserQATimeoutError", "Browser QA check timed out", "CHECK_TIMEOUT"],
    ["Error", "strict mode violation: locator resolved to 2 elements", "QA_INFRASTRUCTURE_FAILURE"],
    ["Error", "Target page, context or browser has been closed", "QA_INFRASTRUCTURE_FAILURE"],
    ["Error", "Unexpected checker exception", "CHECK_EXECUTION_ERROR"],
  ])("classifies %s / %s without a provider retry", (name, message, expected) => {
    const error = new Error(message); error.name = name;
    expect(classifyBrowserQAFailure(error, "functional.controls")).toBe(expected);
  });
  it("requires an explicit failed behavioral assertion before declaring a functional defect", () => {
    expect(classifyBrowserQAFailure(new FunctionalValidationError("Required form is absent"), "functional.requirements")).toBe("FUNCTIONAL_FAILURE");
    expect(classifyBrowserQAFailure(new TypeError("Checker implementation bug"), "functional.requirements")).toBe("QA_INFRASTRUCTURE_FAILURE");
  });
  it.each(["own-svg", "hidden-responsive", "transient-overlay", "blocked", "decorative"])("validates real pointer behavior: %s", async kind => {
    const overlay = kind === "blocked" || kind === "transient-overlay" ? '<div id="overlay" style="position:fixed;inset:0;z-index:100;background:white">Overlay</div>' : "";
    const html = `<html><body><main><h1>Control fixture</h1>${kind === "hidden-responsive" ? '<button style="display:none">Hidden variant</button>' : ""}<button aria-label="Change display" onclick="${kind === "decorative" ? "" : "document.getElementById('result').textContent='Changed content'"}"><svg width="32" height="32"><path d="M0 0h32v32H0z"/></svg></button><p id="result">Original content</p></main>${overlay}${kind === "transient-overlay" ? '<script>setTimeout(()=>document.getElementById("overlay").remove(),200)</script>' : ""}</body></html>`;
    const runner = new BrowserQARunner();
    const report = await runner.run({ runId: "pointer-" + kind, target: { baseUrl: await fixture(html) }, viewports: BROWSER_QA_VIEWPORTS,
      checks: [functionalBrowserChecks(functionalRequirements("Simple portfolio"), ["/"])[0]!], policy: { captureScreenshots: false } });
    expect(report.status).toBe(["blocked", "decorative"].includes(kind) ? "FAIL" : "PASS");
    if (kind === "blocked") expect(report.checks.filter(check => check.checkId === "functional.controls").every(check => check.failureKind === "ACTIONABILITY_TIMEOUT")).toBe(true);
    if (kind === "decorative") expect(report.checks.filter(check => check.checkId === "functional.controls").every(check => check.failureKind === "FUNCTIONAL_FAILURE")).toBe(true);
    expect(runner.activeBrowserCount).toBe(0);
  });
  it("records browser launch failure as infrastructure, never a validated website", async () => {
    const runner = new BrowserQARunner({ launchBrowser: async () => { throw new Error("Browser executable unavailable"); } });
    const report = await runner.run({ runId: "no-browser", target: { baseUrl: "http://127.0.0.1:1" } });
    expect(report.status).toBe("FAIL");
    expect(report.checks[0]?.failureKind).toBe("QA_INFRASTRUCTURE_FAILURE"); expect(runner.activeBrowserCount).toBe(0);
  });
  it("retains a check timeout separately from a functional defect", async () => {
    const runner = new BrowserQARunner();
    const report = await runner.run({ runId: "check-timeout", target: { baseUrl: await fixture('<main><h1>Fixture</h1></main>') }, viewports: [BROWSER_QA_VIEWPORTS[0]!], policy: { captureScreenshots: false },
      checks: [{ definition: { checkId: "functional.fixture", category: "INTERACTION", version: 1, scope: "INTERACTION", defaultSeverity: "ERROR", timeoutMs: 20 },
        execute: async ({ page }) => { await page.waitForTimeout(5000); throw new Error("Must be cancelled"); } }] });
    expect(report.status).toBe("FAIL"); expect(report.checks.find(check => check.checkId === "functional.fixture")?.failureKind).toBe("CHECK_TIMEOUT");
    expect(runner.activeBrowserCount).toBe(0);
  });
  it("enforces the overall deadline within a route, not only between routes", async () => {
    const runner = new BrowserQARunner();
    const report = await runner.run({ runId: "run-deadline", target: { baseUrl: await fixture('<main><h1>Fixture</h1></main>') }, routes: ["/", "/other"],
      viewports: [BROWSER_QA_VIEWPORTS[0]!], policy: { captureScreenshots: false, totalTimeoutMs: 1200, perPageTimeoutMs: 10000 },
      checks: [{ definition: { checkId: "functional.fixture", category: "INTERACTION", version: 1, scope: "INTERACTION", defaultSeverity: "ERROR", timeoutMs: 8000 },
        execute: async ({ page }) => { await page.waitForTimeout(5000); throw new Error("Must be cancelled"); } }] });
    expect(report.status).toBe("FAIL"); expect(report.checks.some(check => check.failureKind === "RUN_DEADLINE_EXCEEDED")).toBe(true);
    expect(runner.activeBrowserCount).toBe(0);
  });
});
