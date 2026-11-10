import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { BrowserQARunner, type BrowserQACheckExecutor } from "../src/browser-qa/browser-qa-runner.js";
import { createBrowserQACheckResult, createBrowserQAReport, type BrowserQACheckResult, type BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import { browserQARuntimeChecks } from "../src/browser-qa/browser-qa-runtime-checks.js";
import { parseEditRequirements } from "../src/cli/runtime/edit-requirements.js";
import { analyzeEditImpact, checksForPlan, evaluateQAVerification, requestedEditRequirements, selectEditQAPlan, selectGenerationQAPlan, type BrowserQAPlan } from "../src/sites/generation/adaptive-qa-policy.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import type { SiteJob } from "../src/sites/domain/entities.js";

afterEach(() => { vi.restoreAllMocks(); });

const routes = ["/", "/shop", "/about"];
const site = (parts: { shop?: string; about?: string; header?: string } = {}) => `import { useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
const products = [{ name: "Vase", price: 40 }, { name: "Bowl", price: 25 }];
function Header(){return <header>${parts.header ?? '<a href="/">Home</a><a href="/shop">Shop</a><a href="/about">About</a>'}</header>}
function Home(){return <main><h1>Studio</h1><p>Handmade ceramics.</p></main>}
function Shop(){${parts.shop ?? 'return <main><h1>Shop</h1><ul>{products.map(p => <li key={p.name}>{p.name} ${"$"}{p.price}</li>)}</ul></main>'}}
function About(){return <main><h1>About</h1><p>${parts.about ?? "We are a small studio."}</p></main>}
export function App(){return <BrowserRouter><Header/><Routes><Route path="/" element={<Home/>}/><Route path="/shop" element={<Shop/>}/><Route path="/about" element={<About/>}/></Routes></BrowserRouter>}`;
const files = (content: string, css = ".card{padding:8px}") => new Map([["src/App.tsx", content], ["src/styles.css", css]]);
const impact = (before: Map<string, string>, after: Map<string, string>) =>
  analyzeEditImpact(before, after, [...after.keys()].filter(path => before.get(path) !== after.get(path)), routes);
// A closed, static render graph: missing controls are provable (a .map over data is not).
const staticShop = 'return <main><h1>Shop</h1><ul><li>Vase</li><li>Bowl</li></ul></main>';
const search = 'const [q,setQ]=useState("");return <main><h1>Shop</h1><input type="search" aria-label="Search products" value={q} onChange={e=>setQ(e.target.value)}/><ul>{products.filter(p=>p.name.toLowerCase().includes(q)).map(p=><li key={p.name}>{p.name}</li>)}</ul></main>';

describe("Adaptive QA policy (offline, deterministic)", () => {
  it("1. a proven copy edit needs no browser; an unproven text edit is one desktop visit with core checks only", () => {
    const before = files(site()), after = files(site({ about: "We are an independent studio." }));
    const change = impact(before, after);
    expect(change).toMatchObject({ kind: "TEXT", routes: ["/about"], allRoutes: false });
    const proven = selectEditQAPlan({ impact: change, scope: parseEditRequirements('Change the about paragraph to "We are an independent studio."').scope!, requirements: [], routes });
    expect(proven).toMatchObject({ mode: "SOURCE_BUILD_ONLY", targets: [] });
    const vague = selectEditQAPlan({ impact: change, scope: parseEditRequirements("Make the about text warmer").scope!, requirements: [], routes });
    expect(vague).toMatchObject({ mode: "TARGETED", profile: "TEXT", checkGroups: ["CORE"], screenshotTargets: [] });
    expect(vague.targets.map(target => `${target.viewport.id} ${target.route}`)).toEqual(["DESKTOP /about"]);
  });

  it("2. a functional edit targets the affected route at desktop and mobile with interaction checks and a requested-behavior assertion", () => {
    const before = files(site()), after = files(site({ shop: search }));
    const change = impact(before, after);
    expect(change).toMatchObject({ kind: "FUNCTIONAL", routes: ["/shop"], allRoutes: false });
    const requirements = requestedEditRequirements("Add a product search to the shop page", after);
    expect(requirements).toEqual([expect.objectContaining({ capability: "search", routes: ["/shop"], policy: "REQUIRED", reason: "SOURCE_RECOGNIZED" })]);
    const plan = selectEditQAPlan({ impact: change, requirements, routes });
    expect(plan).toMatchObject({ mode: "TARGETED", profile: "FUNCTIONAL", checkGroups: ["CORE", "LAYOUT", "INTERACTION"] });
    expect(plan.targets.map(target => `${target.viewport.id} ${target.route}`).sort()).toEqual(["DESKTOP /shop", "MOBILE /shop"]);
  });

  it("3. a shared component edit expands to every route; unproven route reach falls back to full QA", () => {
    const shared = impact(files(site()), files(site({ header: '<a href="/">Home</a><a href="/shop">Shop</a><a href="/about">About</a><button onClick={() => alert("x")}>Menu</button>' })));
    expect(shared).toMatchObject({ kind: "FUNCTIONAL", allRoutes: true, scopeProven: true });
    expect(selectEditQAPlan({ impact: shared, requirements: [], routes })).toMatchObject({ mode: "TARGETED", profile: "FUNCTIONAL" });
    expect(selectEditQAPlan({ impact: shared, requirements: [], routes }).targets).toHaveLength(routes.length * 2);
    // Shared data used by one route only stays on that route.
    const data = impact(files(site()), files(site().replace('price: 40', 'price: 45')));
    expect(data).toMatchObject({ kind: "FUNCTIONAL", routes: ["/shop"] });
    // Routing the app cannot be bound statically: strongest QA.
    const dynamic = (body: string) => `export function App(){const page=location.pathname;return <main>${body}</main>}`;
    const unresolved = impact(files(dynamic("{page}")), files(dynamic("{page.toUpperCase()}")));
    expect(unresolved).toMatchObject({ allRoutes: true, scopeProven: false });
    const full = selectEditQAPlan({ impact: unresolved, requirements: [], routes });
    expect(full).toMatchObject({ mode: "FULL", screenshotTargets: "ALL" });
    expect(full.targets).toHaveLength(routes.length * 3);
    // Entry points and manifests are never scoped.
    expect(analyzeEditImpact(files(site()), new Map([...files(site()), ["package.json", "{}"]]), ["package.json"], routes)).toMatchObject({ kind: "UNCERTAIN" });
  });

  it("3b. a style change reaches only routes whose markup uses the changed selector; global rules reach every route", () => {
    const markup = site({ about: 'We are a <span className="card">small</span> studio.' });
    const scoped = analyzeEditImpact(files(markup), files(markup, ".card{padding:12px}"), ["src/styles.css"], routes);
    expect(scoped).toMatchObject({ kind: "STYLE", routes: ["/about"], allRoutes: false });
    const plan = selectEditQAPlan({ impact: scoped, requirements: [], routes });
    expect(plan).toMatchObject({ profile: "VISUAL", checkGroups: ["CORE", "LAYOUT"], fullPageScreenshots: false });
    expect(plan.screenshotTargets).toHaveLength(2);
    expect(analyzeEditImpact(files(markup), files(markup, ".card{padding:8px}body{margin:2px}"), ["src/styles.css"], routes)).toMatchObject({ kind: "STYLE", allRoutes: true });
  });

  it("4. generation smoke-tests every required route at desktop and mobile and asserts recognized requirements", () => {
    const plan = selectGenerationQAPlan(["/", "/services", "/contact"], { version: 1, pages: [], actualRoutes: ["/", "/services", "/contact"], requirements: [
      { id: "faq", capability: "accordion", target: { kind: "PAGE", pageId: "home" }, expectedBehavior: "x", mandatory: true, validation: "BROWSER_BEHAVIOR", routes: ["/"], sourceAssessment: { state: "RECOGNIZED", reason: "STRUCTURAL_MATCH_REQUIRES_BEHAVIOR" } },
      { id: "tabs", capability: "tabs", target: { kind: "PAGE", pageId: "services" }, expectedBehavior: "x", mandatory: true, validation: "BROWSER_BEHAVIOR", routes: ["/services"], sourceAssessment: { state: "UNCERTAIN", reason: "DYNAMIC_OR_CUSTOM_IMPLEMENTATION" } },
    ] });
    expect(plan.targets.map(target => `${target.viewport.id} ${target.route}`).sort()).toEqual(["DESKTOP /", "DESKTOP /contact", "DESKTOP /services", "MOBILE /", "MOBILE /contact", "MOBILE /services"]);
    expect(plan.requirements.map(item => [item.id, item.policy])).toEqual([["faq", "REQUIRED"], ["tabs", "OPTIONAL"]]);
    expect(plan.screenshotTargets).toHaveLength(2);
    const retry = selectGenerationQAPlan(["/", "/services", "/contact"], undefined, { failed: [{ route: "/services", viewport: "DESKTOP" }] });
    expect(retry.targets.filter(target => target.viewport.id === "MOBILE").map(target => target.route)).toEqual(["/"]);
    expect(retry.targets.filter(target => target.viewport.id === "DESKTOP")).toHaveLength(3);
  });

  it("5. a requested-to-be-built feature proven absent rejects the edit; a failed reliable assertion is FAILED", () => {
    // A dynamic list cannot prove absence: limited coverage, never a false rejection.
    expect(requestedEditRequirements("Add a product search to the shop page", files(site()))).toEqual([expect.objectContaining({ capability: "search", policy: "OPTIONAL" })]);
    let rejection: unknown;
    try { requestedEditRequirements("Add a product search to the shop page", files(site({ shop: staticShop }))); } catch (cause) { rejection = cause; }
    expect(rejection).toMatchObject({ code: "EDIT_REQUIREMENT_INCOMPLETE", metadata: { reason: "REQUESTED_CAPABILITY_NOT_IMPLEMENTED", capability: "search" } });
    // A removal request is not evidence of a missing feature.
    expect(requestedEditRequirements("Remove the product search from the shop page", files(site({ shop: staticShop })))).toEqual([]);
    const plan = selectEditQAPlan({ impact: impact(files(site()), files(site({ shop: search }))), requirements: requestedEditRequirements("Add a product search", files(site({ shop: search }))), routes });
    const verification = evaluateQAVerification(plan, report([probe("edit.search", "FAIL", "FUNCTIONAL_FAILURE")]));
    expect(verification).toMatchObject({ outcome: "FAILED", requirements: [{ id: "edit.search", status: "FAILED" }] });
  });

  it("6. uncertain or unexercised requirements are never reported as verified", () => {
    const optional = requestedEditRequirements("Add category filters to the shop", files(site({ shop: 'const [c,setC]=useState("All");return <main><h1>Shop</h1>{["All","Vases"].map(x=><button key={x} aria-pressed={c===x} onClick={()=>setC(x)}>{x}</button>)}</main>' })));
    expect(optional).toEqual([expect.objectContaining({ capability: "category-filter", policy: "OPTIONAL" })]);
    const plan = selectEditQAPlan({ impact: impact(files(site()), files(site({ shop: search }))), requirements: optional, routes });
    const smoke = evaluateQAVerification(plan, report([pass("route.load")]));
    expect(smoke).toMatchObject({ outcome: "VERIFIED", coverage: "BROWSER_SMOKE", limitedCoverage: true, requirements: [{ status: "UNVERIFIED" }] });
    const failedOptional = evaluateQAVerification(plan, report([probe(optional[0]!.id, "FAIL", "FUNCTIONAL_FAILURE", "WARNING")]));
    expect(failedOptional).toMatchObject({ outcome: "VERIFIED", limitedCoverage: true, requirements: [{ status: "UNVERIFIED" }] });
    const unplanned = { ...selectGenerationQAPlan(["/"], undefined), unplannedRequests: ["Requested tabs has no recognized control"] };
    expect(evaluateQAVerification(unplanned, report([pass("route.load")]))).toMatchObject({ coverage: "BROWSER_SMOKE", limitedCoverage: true });
  });

  it("7. browser startup failure and timeouts are INCONCLUSIVE, never a site defect", async () => {
    const runner = new BrowserQARunner({ launchBrowser: async () => { throw new Error("browserType.launch: Executable doesn't exist"); } });
    const launched = await runner.run({ runId: "offline", target: { baseUrl: "http://127.0.0.1:9/" }, checks: [] });
    const plan = selectGenerationQAPlan(["/"], undefined);
    expect(evaluateQAVerification(plan, launched)).toMatchObject({ outcome: "INCONCLUSIVE", failureKinds: ["QA_INFRASTRUCTURE_FAILURE"], metrics: { browserLaunched: false } });
    expect(runner.metrics.browserLaunches).toBe(0);
    expect(evaluateQAVerification(plan, report([fail("qa.run-budget", "RUN_DEADLINE_EXCEEDED")])).outcome).toBe("INCONCLUSIVE");
    expect(evaluateQAVerification(plan, report([fail("qa.run-budget", "RUN_DEADLINE_EXCEEDED"), fail("runtime.page-error", "BROWSER_RUNTIME_ERROR")])).outcome).toBe("FAILED");
  });

  it("checksForPlan keeps only planned groups and limits interaction probes to planned viewports", () => {
    const all = [...browserQACoreCheckExecutors, ...browserQAResponsiveAndInteractionChecks, ...browserQARuntimeChecks];
    const text = checksForPlan(selectEditQAPlan({ impact: { kind: "TEXT", routes: ["/"], allRoutes: false, scopeProven: true, files: [], reasons: [] }, requirements: [], routes }), all);
    expect(text.map(check => check.definition.checkId).sort()).toEqual(browserQACoreCheckExecutors.map(check => check.definition.checkId).concat("browser-safety-events").sort());
    const generation = checksForPlan(selectGenerationQAPlan(routes, undefined), all);
    const smoke = generation.find(check => check.definition.checkId === "interaction-smoke")!;
    expect(smoke.appliesTo?.("/", { id: "MOBILE", width: 390, height: 844 })).toBe(false);
    expect(smoke.appliesTo?.("/", { id: "DESKTOP", width: 1440, height: 900 })).toBe(true);
    expect(generation.find(check => check.definition.checkId === "interaction.mobile-nav")?.appliesTo).toBe(browserQAResponsiveAndInteractionChecks.find(check => check.definition.checkId === "interaction.mobile-nav")?.appliesTo);
  });
});

// ---------------------------------------------------------------------------
// Offline edit pipeline: persistence and billing per QA outcome (8-10)
// ---------------------------------------------------------------------------

async function editHarness(instruction: string, after: string, qa: (product: ReturnType<typeof createLocalSitesProduct>) => void) {
  const root = await mkdtemp(join(tmpdir(), "phase2-edit-"));
  const execution = new MockExecutionProvider();
  const execute = execution.executeCommand.bind(execution);
  vi.spyOn(execution, "executeCommand").mockImplementation(async (id, command) => {
    if (command.args?.[0] === "ci") { const now = new Date(); return { exitCode: 0, stdout: "offline install", stderr: "", timedOut: false, durationMs: 0, startedAt: now, finishedAt: now }; }
    const result = await execute(id, command);
    if (result.exitCode === 0) await execution.writeFile(id, "dist/index.html", '<div id="root"></div>');
    return result;
  });
  const original = site();
  const mock = new MockAgentProvider({ customResponse: request => ({ id: "offline-edit", model: request.model,
    message: { role: "assistant", content: JSON.stringify({ patches: [{ path: "src/App.tsx", mode: "unique", find: original, replace: after }] }) },
    toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 }, latencyMs: 0, finishReason: "stop" }) });
  const provider = { id: "offline-phase2-edit", getCapabilities: () => mock.getCapabilities(), createResponse: mock.createResponse.bind(mock) };
  const registry = new AgentProviderRegistry(); registry.register(provider);
  const finalize = vi.fn(async (job: SiteJob) => ({ ...job, billingStatus: "CHARGED" as const, creditsCharged: 1 }));
  const preflight = vi.fn(async () => ({ ownerId: "offline", modelRate: { model: "mock-sites-v1", platform: "mock-agent", type: "ai_chat", creditsPer500Tokens: 1 } }));
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), execution: execution as never,
    agentRegistry: registry, orchestrationAgent: provider, billing: { preflight, finalizeSuccessfulJob: finalize } as unknown as SiteCreditBillingService });
  qa(product);
  const siteId = "phase2-edit-project" as SiteId, ownerId = "offline" as UserId, versionId = "initial-version" as VersionId;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<div id="root"></div>'));
  const environment = await execution.createEnvironment({});
  for (const [path, content] of Object.entries({ "src/App.tsx": original, "src/main.tsx": "// managed entry", "index.html": '<div id="root"></div>',
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }) })) await execution.writeFile(environment.id, path, content);
  const sourceRef = "sites/phase2-edit-project/current/source.json";
  await new SiteSourceSnapshotService(product.artifacts).capture(execution as never, environment.id, sourceRef, { technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1 });
  await execution.destroyEnvironment(environment.id);
  const now = new Date();
  await product.projects.save({ id: siteId, ownerId, name: "Existing", slug: "existing", status: "ACTIVE", latestVersionId: versionId, createdAt: now, updatedAt: now });
  // No stored SiteSpec: QA routes come from the edited source's discovered routes.
  await product.versions.save({ id: versionId, siteId, versionNumber: 1, sourceArtifactRef: sourceRef, buildStatus: "SUCCEEDED", createdAt: now });
  const run = () => product.pipeline.edit({ userId: ownerId, siteId, instruction, agentProvider: provider.id, browserQAEnabled: true });
  const cleanup = async () => { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); };
  return { product, run, finalize, siteId, versionId, cleanup };
}

describe("Edit pipeline QA outcomes (offline, mocked model and browser)", () => {
  it("1/10. a proven copy edit is verified without launching a browser, then saved and charged once", async () => {
    let qa!: MockInstance<BrowserQARunner["run"]>;
    const h = await editHarness('Change the about paragraph to "We are an independent studio."', site({ about: "We are an independent studio." }),
      product => { qa = vi.spyOn(product.browserQA, "run"); });
    try {
      const result = await h.run();
      expect(qa).not.toHaveBeenCalled();
      expect(result.qaVerification).toMatchObject({ outcome: "VERIFIED", coverage: "SOURCE_BUILD", plan: { mode: "SOURCE_BUILD_ONLY" } });
      expect(h.finalize).toHaveBeenCalledOnce();
      expect((await h.product.projects.getById(h.siteId))!.latestVersionId).toBe(result.newVersionId);
    } finally { await h.cleanup(); }
  });

  it("2/10. a functional edit runs targeted QA on the affected route, verifies the requested behavior, saves and charges", async () => {
    let request: Parameters<BrowserQARunner["run"]>[0] | undefined;
    const h = await editHarness("Add a product search to the shop page", site({ shop: search }), product => {
      vi.spyOn(product.browserQA, "run").mockImplementation(async input => { request = input; return report([pass("route.load", "/shop"), probe("edit.search", "PASS")]); });
    });
    try {
      const result = await h.run();
      expect(request?.targets?.map(target => `${target.viewport.id} ${target.route}`).sort()).toEqual(["DESKTOP /shop", "MOBILE /shop"]);
      expect(request?.checks?.some(check => check.definition.checkId === "functional.requirements")).toBe(true);
      expect(request?.screenshotTargets).toEqual([]);
      expect(result.qaVerification).toMatchObject({ outcome: "VERIFIED", coverage: "REQUIREMENTS", limitedCoverage: false, requirements: [{ id: "edit.search", status: "VERIFIED" }] });
      expect(h.finalize).toHaveBeenCalledOnce();
      expect((await h.product.projects.getById(h.siteId))!.latestVersionId).toBe(result.newVersionId);
    } finally { await h.cleanup(); }
  });

  it.each([
    ["8. a QA timeout", () => report([fail("qa.run-budget", "RUN_DEADLINE_EXCEEDED")]), "BROWSER_QA_INCONCLUSIVE", "INCONCLUSIVE"],
    ["7. a Playwright startup failure", "launch", "BROWSER_QA_INCONCLUSIVE", "INCONCLUSIVE"],
    ["9. a genuine functional failure", () => report([probe("edit.search", "FAIL", "FUNCTIONAL_FAILURE")]), "VALIDATION_FAILED", "FAILED"],
  ] as const)("%s preserves the previous version and never charges", async (_name, outcome, code, qaOutcome) => {
    const h = await editHarness("Add a product search to the shop page", site({ shop: search }), product => {
      vi.spyOn(product.browserQA, "run").mockImplementation(async input => outcome === "launch"
        ? new BrowserQARunner({ launchBrowser: async () => { throw new Error("browserType.launch: Executable doesn't exist"); } }).run(input)
        : outcome());
    });
    try {
      await expect(h.run()).rejects.toMatchObject({ code, metadata: { failureStage: "BROWSER_QA", qaOutcome } });
      expect(h.finalize).not.toHaveBeenCalled();
      expect((await h.product.projects.getById(h.siteId))!.latestVersionId).toBe(h.versionId);
      const job = (await h.product.jobs.listBySite(h.siteId)).items[0]!;
      expect([job.billingStatus, job.creditsCharged]).toEqual(["NOT_CHARGED", 0]);
    } finally { await h.cleanup(); }
  });

  it("5. an explicitly requested feature proven absent is rejected before any browser time", async () => {
    let qa!: MockInstance<BrowserQARunner["run"]>;
    const h = await editHarness("Add a product search to the shop page", site({ shop: staticShop, about: "Search coming soon." }), product => { qa = vi.spyOn(product.browserQA, "run"); });
    try {
      await expect(h.run()).rejects.toMatchObject({ code: "EDIT_REQUIREMENT_INCOMPLETE", metadata: { reason: "REQUESTED_CAPABILITY_NOT_IMPLEMENTED" } });
      expect(qa).not.toHaveBeenCalled(); expect(h.finalize).not.toHaveBeenCalled();
      expect((await h.product.projects.getById(h.siteId))!.latestVersionId).toBe(h.versionId);
    } finally { await h.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Measured resource use with real Chromium on a tiny local site
// ---------------------------------------------------------------------------

const page = (title: string, extra = "") => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font-family:sans-serif;margin:0}header{display:flex;gap:12px;padding:12px}main{padding:16px}</style></head><body>
<div id="root"><header><a href="/">Home</a><a href="/shop">Shop</a><a href="/about">About</a></header><main><h1>${title}</h1><p>Handmade ceramics for everyday use.</p>${extra}</main></div></body></html>`;
let server: Server, baseUrl = "";
beforeAll(async () => {
  const pages: Record<string, string> = { "/": page("Studio"), "/about": page("About"), "/shop": page("Shop",
    '<label>Search <input type="search" aria-label="Search products" oninput="for(const li of document.querySelectorAll(\'li\'))li.hidden=!li.textContent.toLowerCase().includes(this.value.toLowerCase())"></label><ul><li>Vase</li><li>Bowl</li></ul>') };
  server = createServer((request, response) => {
    const body = pages[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "missing");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("Measured QA cost with real Chromium (local static site, no network)", () => {
  it("adaptive plans use fewer page visits and screenshots than the historical exhaustive run, with zero failures", async () => {
    const all: BrowserQACheckExecutor[] = [...browserQACoreCheckExecutors, ...browserQAResponsiveAndInteractionChecks, ...browserQARuntimeChecks.filter(check => check.definition.checkId !== "broken-images")];
    const puts: string[] = [];
    const artifacts = { put: async (ref: string) => { puts.push(ref); } } as never;
    const measure = async (name: string, plan?: BrowserQAPlan) => {
      const runner = new BrowserQARunner({ artifacts }); const shots = puts.length; const started = Date.now();
      const result = await runner.run({ runId: name, target: { baseUrl }, routes, checks: plan ? checksForPlan(plan, all) : all, artifactPrefix: `measure/${name}`,
        ...(plan ? { targets: plan.targets, ...(plan.screenshotTargets === "ALL" ? {} : { screenshotTargets: plan.screenshotTargets }), policy: { fullPageScreenshots: plan.fullPageScreenshots } } : {}) });
      return { name, status: result.status, ms: Date.now() - started, ...runner.metrics, artifacts: puts.length - shots };
    };
    const shop = impact(files(site()), files(site({ shop: search })));
    const rows = [
      await measure("historical-exhaustive"),
      await measure("generation", selectGenerationQAPlan(routes, undefined)),
      await measure("functional-edit", selectEditQAPlan({ impact: shop, requirements: [], routes })),
      await measure("visual-edit", selectEditQAPlan({ impact: { kind: "STYLE", routes: ["/about"], allRoutes: false, scopeProven: true, files: [], reasons: [] }, requirements: [], routes })),
      await measure("text-edit-unproven", selectEditQAPlan({ impact: { kind: "TEXT", routes: ["/about"], allRoutes: false, scopeProven: true, files: [], reasons: [] }, requirements: [], routes })),
    ];
    console.log("QA_COST", JSON.stringify(rows));
    const [exhaustive, generation, functional, visual, text] = rows;
    for (const row of rows) { expect(row.status).not.toBe("FAIL"); expect(row.browserLaunches).toBe(1); }
    expect(exhaustive!.routeVisits).toBe(9); expect(exhaustive!.screenshots).toBe(9);
    expect(generation!.routeVisits).toBe(6); expect(generation!.screenshots).toBe(2);
    expect(functional!.routeVisits).toBe(2); expect(functional!.screenshots).toBe(0);
    expect(visual!.routeVisits).toBe(2); expect(visual!.screenshots).toBe(2);
    expect(text!.routeVisits).toBe(1); expect(text!.screenshots).toBe(0);
    expect(generation!.pagesOpened).toBeLessThan(exhaustive!.pagesOpened);
  }, 180_000);
});

// ---------------------------------------------------------------------------
function report(checks: readonly BrowserQACheckResult[]): BrowserQAReport {
  return createBrowserQAReport({ runId: "offline", browser: { name: "chromium" }, routes: ["/"], viewports: [], checks: [...checks],
    startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), durationMs: 1 });
}
function pass(checkId: string, route = "/"): BrowserQACheckResult {
  return createBrowserQACheckResult({ checkId, category: "RUNTIME", status: "PASS", severity: "ERROR", route, message: "ok" });
}
function fail(checkId: string, failureKind: NonNullable<BrowserQACheckResult["failureKind"]>): BrowserQACheckResult {
  return createBrowserQACheckResult({ checkId, category: "RUNTIME", status: "FAIL", severity: "ERROR", route: "/", failureKind, message: `${checkId} failed` });
}
function probe(requirementId: string, result: "PASS" | "FAIL", failureKind?: NonNullable<BrowserQACheckResult["failureKind"]>, severity: "ERROR" | "WARNING" = "ERROR"): BrowserQACheckResult {
  return createBrowserQACheckResult({ checkId: severity === "ERROR" ? "functional.requirements" : "functional.optional-requirements", category: "INTERACTION", status: result, severity, route: "/shop",
    ...(failureKind && result === "FAIL" ? { failureKind } : {}), message: result === "PASS" ? "Requested behavior passed" : "Search does not update visible results",
    functionalProbes: [{ requirementId, capability: "search", expectedRoute: "/shop", actualRoute: "/shop", result }] });
}
