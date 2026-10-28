import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { functionalBrowserChecks } from "../src/browser-qa/functional-capability-checks.js";
import { BROWSER_QA_VIEWPORTS } from "../src/browser-qa/browser-qa-domain.js";
import type { ResolvedFunctionalContract } from "../src/sites/generation/functional-route-contract.js";
import { functionalBehaviors } from "../src/sites/generation/functional-route-contract.js";
import { summarizeGenerationReliability } from "../src/sites/generation/generation-development-telemetry.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
async function fixture(broken: boolean, section = false) {
  const server = createServer((request, response) => {
    const route = request.url?.split("?")[0];
    response.writeHead(200, { "content-type": "text/html" });
    const controls = `<div role="group" aria-label="Portfolio categories">${["All", "Design", "Strategy"].map(category => `<button aria-pressed="${category === "All"}" onclick="filter(this)">${category}</button>`).join("")}</div><div role="list"><div role="listitem" data-category="Design">Canvas Lab</div><div role="listitem" data-category="Strategy">Signal Atlas</div></div>`;
    response.end(`<!doctype html><html><body><main><h1>${route === "/work" ? "Our Work" : "Home"}</h1><p>A meaningful local page</p>${route === "/work" ? `<section id="portfolio">${controls}</section>${section ? `<section id="unrelated">${controls}</section>` : ""}` : ""}</main><script>function filter(button){${broken ? "return" : `const section=button.closest('section');section.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));section.querySelectorAll('[role=listitem]').forEach(item=>item.hidden=button.innerText!=='All'&&item.dataset.category!==button.innerText)`}}</script></body></html>`);
  }); servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture port");
  return `http://127.0.0.1:${address.port}`;
}
const contract = (section = false): ResolvedFunctionalContract => ({ version: 1, pages: [], actualRoutes: ["/", "/work"], requirements: [{
  id: "functional:category-filter:our-work", capability: "category-filter", target: section ? { kind: "SECTION", sectionId: "portfolio" } : { kind: "PAGE", pageId: "our-work", pageName: "Our Work" },
  expectedBehavior: functionalBehaviors["category-filter"], mandatory: true, validation: "BROWSER_BEHAVIOR", routes: ["/work"], sourceEvidence: [{ path: "src/App.tsx", line: 5 }],
}] });
describe("Observable route-scoped production probes", () => {
  it.each(["heading", "aria-label", "missing-form", "ambiguous", "hidden", "literal-missing"])("resolves semantic form sections without inventing IDs: %s", async kind => {
    const form = `<form onsubmit="event.preventDefault();this.querySelector('[role=status]').textContent='Demo only; nothing was sent'"><label>Name<input required name="name"></label><label>Email<input required type="email" name="email"></label><label>Message<textarea required name="message"></textarea></label><button type="submit">Send demo message</button><p role="status"></p></form>`;
    const requested = `<section id="generated-section-927" ${kind === "aria-label" ? 'aria-label="Project inquiry"' : ""} ${kind === "hidden" ? "hidden" : ""}>${kind === "aria-label" ? "" : "<h2>Project inquiry</h2>"}${kind === "missing-form" ? "<p>Please contact us later.</p>" : form}</section>`;
    const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><html><body><main><h1>Contact</h1><p>Start a project</p>${requested}${kind === "ambiguous" ? requested.replace("generated-section-927", "another-generated-id") : `<section><h2>Unrelated business contact</h2>${form}</section>`}</main></body></html>`); }); servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture port");
    const scope: ResolvedFunctionalContract = { version: 1, pages: [], actualRoutes: ["/contact"], requirements: [{ id: "functional:form:contact", capability: "form", target: { kind: "SECTION", ...(kind === "literal-missing" ? { sectionId: "project-inquiry" } : { sectionName: "Project inquiry" }) }, mandatory: true, validation: "BROWSER_BEHAVIOR", expectedBehavior: functionalBehaviors.form, routes: ["/contact"] }] };
    const checks = functionalBrowserChecks({ version: 1, capabilities: ["form"], backendRequired: false, unsupportedTransactions: false }, ["/contact"], false, scope);
    const report = await new BrowserQARunner().run({ runId: "semantic-form", target: { baseUrl: `http://127.0.0.1:${address.port}` }, routes: ["/contact"], checks: [checks[1]!], policy: { captureScreenshots: false } });
    expect(report.status).toBe(["heading", "aria-label"].includes(kind) ? "PASS" : "FAIL");
    expect(report.checks.filter(check => check.checkId === "functional.requirements")).toHaveLength(3);
  }, 60_000);
  it.each([false, true])("checks the actual portfolio route at every viewport (broken=%s)", async broken => {
    const checks = functionalBrowserChecks({ version: 1, capabilities: ["category-filter"], backendRequired: false, unsupportedTransactions: false }, ["/", "/work"], false, contract());
    const report = await new BrowserQARunner().run({ runId: "route-probe", target: { baseUrl: await fixture(broken) }, routes: ["/", "/work"],
      checks: [checks[1]!], policy: { captureScreenshots: false } });
    for (const viewport of BROWSER_QA_VIEWPORTS) {
      expect(report.checks.find(check => check.route === "/" && check.viewport?.id === viewport.id && check.checkId === "functional.requirements")?.status).toBe("SKIPPED");
      const work = report.checks.find(check => check.route === "/work" && check.viewport?.id === viewport.id && check.checkId === "functional.requirements")!;
      expect(work.status).toBe(broken ? "FAIL" : "PASS");
      expect(work.functionalProbes?.[0]).toMatchObject({ expectedRoute: "/work", actualRoute: "/work", result: broken ? "FAIL" : "PASS" });
    }
  }, 60_000);
  it("does not let a working filter in another section satisfy the assigned section", async () => {
    const url = await fixture(false, true);
    const checks = functionalBrowserChecks({ version: 1, capabilities: ["category-filter"], backendRequired: false, unsupportedTransactions: false }, ["/work"], false, contract(true));
    const report = await new BrowserQARunner().run({ runId: "section-probe", target: { baseUrl: url }, routes: ["/work"], viewports: [BROWSER_QA_VIEWPORTS[0]!], checks: [{ ...checks[1]!, execute: async context => {
      await context.page.locator("#portfolio button").evaluateAll(buttons => buttons.forEach(button => button.setAttribute("onclick", "void 0")));
      return checks[1]!.execute(context);
    } }], policy: { captureScreenshots: false } });
    expect(report.status).toBe("FAIL");
  }, 30_000);
  it("aggregates terminal metadata once per job without side effects", () => {
    expect(summarizeGenerationReliability([
      { jobId: "a", role: "generation", outcome: "SUCCEEDED", physicalRequests: 1, billingStatus: "CHARGED" },
      { jobId: "a", role: "generation", outcome: "SUCCEEDED", physicalRequests: 1, billingStatus: "CHARGED" },
      { jobId: "b", role: "generation", outcome: "FAILED", failureStage: "BROWSER_QA", validationCategory: "functional.requirements", physicalRequests: 2, billingStatus: "NOT_CHARGED" },
    ])).toEqual({ jobs: 2, completed: 1, completionRate: 0.5, failures: { "BROWSER_QA:functional.requirements": 1 }, physicalRequests: 3, successfulBilling: 1 });
  });
  it("retains a blocking report when the existing QA deadline expires", async () => {
    let tick = 0;
    const report = await new BrowserQARunner({ now: () => new Date(tick++ * 1000) }).run({ runId: "deadline", target: { baseUrl: await fixture(false) }, policy: { totalTimeoutMs: 0, captureScreenshots: false } });
    expect(report.status).toBe("FAIL");
    expect(report.checks).toContainEqual(expect.objectContaining({ checkId: "qa.run-budget", status: "FAIL", severity: "ERROR" }));
  }, 15_000);
  it("tests an accessible accordion that starts expanded without confusing it with navigation", async () => {
    const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><html><body><main><h1>FAQ</h1><button aria-expanded="true" aria-controls="answer" onclick="const expanded=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!expanded));document.getElementById('answer').hidden=expanded">How does navigation work?</button><p id="answer">Use the real page links to explore the studio.</p></main></body></html>`); }); servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const checks = functionalBrowserChecks({ version: 1, capabilities: ["accordion"], backendRequired: false, unsupportedTransactions: false }, ["/"]);
    const report = await new BrowserQARunner().run({ runId: "aria-accordion", target: { baseUrl: `http://127.0.0.1:${address.port}` }, checks: [checks[1]!], viewports: [BROWSER_QA_VIEWPORTS[0]!], policy: { captureScreenshots: false } });
    expect(report.status).toBe("PASS");
  }, 15_000);
});
