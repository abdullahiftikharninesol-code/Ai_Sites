import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FunctionalCoverageLimit, probeCalculation, probeComparison, probeFiltering, probeMultiStep, probeSorting, sortIntent } from "../src/browser-qa/behavior-probes.js";
import { FunctionalValidationError } from "../src/browser-qa/browser-qa-failure.js";
import { functionalBrowserChecks } from "../src/browser-qa/functional-capability-checks.js";
import { runRouteRequirements } from "../src/browser-qa/functional-route-probes.js";
import { BrowserQARunner, type BrowserQAPageContext } from "../src/browser-qa/browser-qa-runner.js";
import { BROWSER_QA_VIEWPORTS, createBrowserQACheckResult, createBrowserQAReport, type BrowserQACheckResult, type BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { functionalGenerationContract, functionalRequirements } from "../src/sites/generation/functional-capabilities.js";
import { functionalRouteGuidance, type ResolvedFunctionalContract } from "../src/sites/generation/functional-route-contract.js";
import { functionalSourceManifest } from "../src/sites/generation/functional-source-contract.js";
import { evaluateCalculationFormula, extractCalculationFormula } from "../src/sites/generation/calculation-formula.js";
import { analyzeEditImpact, evaluateQAVerification, requestedEditRequirements, selectEditQAPlan, type BrowserQAPlan } from "../src/sites/generation/adaptive-qa-policy.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import type { SiteJob } from "../src/sites/domain/entities.js";

afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Offline fixtures: plain semantic HTML + vanilla JS, no test IDs or classes.
// Each behavior has a correct and a deliberately broken implementation.
// ---------------------------------------------------------------------------

const doc = (body: string, script = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fixture</title></head><body>${body}<script>${script}</script></body></html>`;
const catalog = `const items=[{n:"Tall Vase",p:40,c:"Vases"},{n:"Bowl",p:25,c:"Bowls"},{n:"Mug",p:12,c:"Mugs"},{n:"Bud Vase",p:30,c:"Vases"},{n:"Serving Bowl",p:55,c:"Bowls"}];
const list=document.querySelector("ul");
function render(order){list.replaceChildren(...order.map(i=>{const li=document.createElement("li");li.innerHTML="<h3>"+i.n+"</h3><p>"+i.c+"</p><p>$"+i.p.toFixed(2)+"</p>";return li;}));}
render(items);`;
const sortSelect = `<label>Sort by <select><option value="featured">Featured</option><option value="pa">Price: Low to High</option><option value="pd">Price: High to Low</option><option value="az">Name A–Z</option></select></label>`;
const filterSelect = `<label>Category <select><option value="">All</option><option>Vases</option><option>Bowls</option><option>Mugs</option></select></label>`;

const fixtures: Record<string, string> = {
  "/sort": doc(`<main><h1>Shop</h1>${sortSelect}<ul></ul></main>`, `${catalog}
document.querySelector("select").addEventListener("change",e=>{const v=e.target.value,c=[...items];if(v==="pa")c.sort((a,b)=>a.p-b.p);if(v==="pd")c.sort((a,b)=>b.p-a.p);if(v==="az")c.sort((a,b)=>a.n.localeCompare(b.n));render(c);});`),
  // The dropdown changes, the list does not.
  "/sort-broken": doc(`<main><h1>Shop</h1>${sortSelect}<ul></ul></main>`, `${catalog}
document.querySelector("select").addEventListener("change",()=>{});`),
  "/sort-ambiguous": doc(`<main><h1>Shop</h1><label>Sort by <select><option>Featured</option><option>Popularity</option><option>Best match</option></select></label><ul></ul></main>`, catalog),
  "/filter": doc(`<main><h1>Shop</h1>${filterSelect}<ul></ul></main>`, `${catalog}
document.querySelector("select").addEventListener("change",e=>{const v=e.target.value;render(v?items.filter(i=>i.c===v):items);});`),
  "/filter-broken": doc(`<main><h1>Shop</h1>${filterSelect}<ul></ul></main>`, `${catalog}
document.querySelector("select").addEventListener("change",()=>{});`),
  // Narrows the list, but to the wrong items.
  "/filter-wrong": doc(`<main><h1>Shop</h1>${filterSelect}<ul></ul></main>`, `${catalog}
document.querySelector("select").addEventListener("change",e=>{const v=e.target.value;render(v?items.filter(i=>i.c!==v).slice(0,2):items);});`),
  // Different structure: div cards, pressed-state filter buttons and sort buttons.
  "/semantic": doc(`<main><h1>Plants</h1><div role="group" aria-label="Filter plants"><button aria-pressed="true">All</button><button aria-pressed="false">Indoor</button><button aria-pressed="false">Outdoor</button></div>
<div><button>Name A–Z</button><button>Name Z–A</button></div><div></div></main>`, `const plants=[{n:"Fern",t:"Indoor"},{n:"Agave",t:"Outdoor"},{n:"Pothos",t:"Indoor"},{n:"Lavender",t:"Outdoor"},{n:"Monstera",t:"Indoor"}];
let view=[...plants],kind="All";const grid=document.querySelectorAll("main > div")[2];
function draw(){grid.replaceChildren(...view.filter(p=>kind==="All"||p.t===kind).map(p=>{const d=document.createElement("div");d.innerHTML="<h3>"+p.n+"</h3><span>"+p.t+"</span>";return d;}));}
for(const b of document.querySelectorAll("[aria-pressed]"))b.onclick=()=>{kind=b.textContent;for(const o of document.querySelectorAll("[aria-pressed]"))o.setAttribute("aria-pressed",String(o===b));draw();};
const [az,za]=document.querySelectorAll("main > div:nth-of-type(2) button");az.onclick=()=>{view.sort((a,b)=>a.n.localeCompare(b.n));draw();};za.onclick=()=>{view.sort((a,b)=>b.n.localeCompare(a.n));draw();};draw();`),
  "/cart": cartPage("80.00"), "/cart-wrong-total": cartPage("40.00"),
  "/form": formPage(false), "/form-broken": formPage(true),
  "/steps": stepsPage("ok"), "/steps-next-broken": stepsPage("next"), "/steps-back-broken": stepsPage("back"),
  "/compare": doc(`<main><h1>Laptops</h1><ul><li><h3>Aero 13</h3><p>$999</p><label><input type="checkbox"> Compare</label></li><li><h3>Book 15</h3><p>$1,299</p><label><input type="checkbox"> Compare</label></li><li><h3>Zen 14</h3><p>$899</p><label><input type="checkbox"> Compare</label></li></ul>
<section aria-label="Comparison" hidden><h2>Comparison</h2><div></div></section></main>`, `const view=document.querySelector("section"),cols=view.querySelector("div");
for(const box of document.querySelectorAll("input[type=checkbox]"))box.onchange=()=>{const names=[...document.querySelectorAll("li")].filter(li=>li.querySelector("input").checked).map(li=>li.querySelector("h3").textContent);cols.textContent=names.join(" vs ");view.hidden=!names.length;};`),
  "/calc": calcPage("p*q"), "/calc-wrong": calcPage("p+q"), "/calc-static": calcPage("none"),
};
function cartPage(subtotal: string) {
  return doc(`<header><button>Cart (0)</button></header><main><h1>Linen Shirt</h1><p>$40.00</p><label>Quantity <input type="number" value="2" min="1"></label><button>Add to cart</button></main>
<aside aria-label="Shopping cart" hidden><h2>Your cart</h2><ul></ul><p></p><button>Close cart</button></aside>`, `let count=0;const trigger=document.querySelector("header button"),panel=document.querySelector("aside"),lines=panel.querySelector("ul"),sub=panel.querySelector("p");
function draw(){trigger.textContent="Cart ("+count+")";if(!count){lines.replaceChildren();sub.textContent="Your cart is empty.";return;}
lines.innerHTML="<li><strong>Linen Shirt</strong> Quantity: "+count+" <button>Remove Linen Shirt</button></li>";sub.textContent="Subtotal: $${subtotal}";lines.querySelector("button").onclick=()=>{count=0;draw();};}
document.querySelector("main button").onclick=()=>{count+=Number(document.querySelector("main input").value);draw();panel.hidden=false;};
trigger.onclick=()=>{panel.hidden=!panel.hidden;};panel.querySelector("button:last-of-type").onclick=()=>{panel.hidden=true;};draw();`);
}
function formPage(acceptsEmpty: boolean) {
  return doc(`<main><h1>Contact</h1><form novalidate><label>Name <input name="name" aria-required="true"></label><label>Email <input type="email" name="email" required></label><label>Message <textarea name="message" required></textarea></label><button type="submit">Send</button><p role="status"></p></form></main>`,
    `const f=document.querySelector("form"),st=f.querySelector("[role=status]");f.addEventListener("submit",e=>{e.preventDefault();
const ok=${acceptsEmpty ? "true" : '[...f.querySelectorAll("input,textarea")].every(x=>x.value.trim())&&f.email.value.includes("@")'};
st.textContent=ok?"Thanks - this is a demo only; nothing was sent.":"Please fill in all required fields.";});`);
}
function stepsPage(mode: "ok" | "next" | "back") {
  return doc(`<main><h1>Book a session</h1><p>Step 1 of 2</p><div><h2>Your details</h2><label>Full name <input id="full-name" required></label></div>
<div hidden><h2>Contact</h2><label>Email <input id="contact-email" type="email"></label></div><button hidden>Back</button><button>Next</button></main>`,
    `let step=1;const [s1,s2]=document.querySelectorAll("main > div"),[back,next]=document.querySelectorAll("main > button"),ind=document.querySelector("main p"),nameInput=document.getElementById("full-name");
function show(){s1.hidden=step!==1;s2.hidden=step!==2;back.hidden=step===1;ind.textContent="Step "+step+" of 2";}
next.onclick=()=>{${mode === "next" ? "" : "if(step===1&&!nameInput.value)return;step=2;show();"}};
back.onclick=()=>{step=1;${mode === "back" ? 'nameInput.value="";' : ""}show();};`);
}
function calcPage(rule: "p*q" | "p+q" | "none") {
  return doc(`<main><h1>Order estimate</h1><label>Price <input type="number" value="10" min="0"></label><label>Quantity <input type="number" value="3" min="1"></label><p>Total: <output>30.00</output></p></main>`,
    rule === "none" ? "" : `const [p,q]=document.querySelectorAll("input"),t=document.querySelector("output");function u(){t.textContent=(${rule === "p*q" ? "Number(p.value)*Number(q.value)" : "Number(p.value)+Number(q.value)"}).toFixed(2);}p.oninput=u;q.oninput=u;u();`);
}

let server: Server, base = "", browser: Browser;
const timings: Record<string, number> = {};
beforeAll(async () => {
  server = createServer((request, response) => {
    const body = fixtures[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body ?? "missing");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  console.info("[phase5] probe wall-clock ms", JSON.stringify(timings));
});
async function open(path: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base + path, { waitUntil: "load" });
  return page;
}
/** Runs a probe on a fresh page; records wall-clock time per fixture. */
async function run<T>(path: string, probe: (page: Page) => Promise<T>): Promise<T> {
  const page = await open(path), started = performance.now();
  try { return await probe(page); } finally { timings[path] = Math.round(performance.now() - started); await page.close(); }
}
const context = (page: Page, route = "/"): BrowserQAPageContext => ({ page, context: page.context(), route, viewport: BROWSER_QA_VIEWPORTS[0]!, events: { pageErrors: [], consoleErrors: [], failedRequests: [] } as never });
/** The existing capability probe, scoped to one capability exactly as the route contract runs it. */
const requirementsCheck = (capability: "cart" | "form") => {
  const check = functionalBrowserChecks(functionalRequirements(capability === "cart" ? "An online store with add to cart" : "A site with a contact form"), ["/"])[1]!;
  return { execute: (scoped: BrowserQAPageContext, selected: ReadonlySet<string>, force: boolean) =>
    (check.execute as (context: BrowserQAPageContext, selected: ReadonlySet<string>, force: boolean) => Promise<BrowserQACheckResult>)(scoped, selected, force) };
};

describe("Phase 5 behavior probes on offline fixtures (real Chromium, no network, no AI)", { timeout: 30_000 }, () => {
  it("1. correct sorting passes with the observed key order recorded", async () => {
    const checked = await run("/sort", page => probeSorting(page));
    expect(checked).toMatch(/Sorting verified: "Price: Low to High" reordered 5 items by price/);
  });
  it("2. a sort control that does not reorder items fails with expected versus observed order", async () => {
    const error = await run("/sort-broken", page => probeSorting(page).catch((cause: unknown) => cause));
    expect(error).toBeInstanceOf(FunctionalValidationError);
    expect((error as Error).message).toMatch(/does not order items by price ascending\. Observed: "Tall Vase \(40\)", "Bowl \(25\)".*expected: "Mug \(12\)", "Bowl \(25\)"/);
  });
  it("3. filtering narrows to matching items and clearing restores the full set", async () => {
    expect(await run("/filter", page => probeFiltering(page))).toMatch(/Filtering verified: "Vases" narrowed 5→2 items/);
  });
  it("4. a filter control that changes nothing, or shows non-matching items, fails", async () => {
    const unchanged = await run("/filter-broken", page => probeFiltering(page).catch((cause: unknown) => cause));
    expect(unchanged).toBeInstanceOf(FunctionalValidationError); expect((unchanged as Error).message).toMatch(/Filter controls do not change the visible items/);
    const wrong = await run("/filter-wrong", page => probeFiltering(page).catch((cause: unknown) => cause));
    expect(wrong).toBeInstanceOf(FunctionalValidationError); expect((wrong as Error).message).toMatch(/Filter "Vases" shows items that do not match it/);
  });
  it("5. a correct cart updates count, subtotal (stated price × quantity) and removal", async () => {
    const result = await run("/cart", page => requirementsCheck("cart").execute(context(page, "/cart"), new Set(["cart"]), true));
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("cart count 0→2"); expect(result.message).toContain("cart subtotal 80 = 40 × 2"); expect(result.message).toContain("removing the item emptied the cart");
  });
  it("6. an incorrect cart total fails because the expected calculation is known from the page", async () => {
    const error = await run("/cart-wrong-total", page => requirementsCheck("cart").execute(context(page, "/cart"), new Set(["cart"]), true).catch((cause: unknown) => cause));
    expect(error).toBeInstanceOf(FunctionalValidationError);
    expect((error as Error).message).toMatch(/Cart shows "Subtotal: \$40\.00" but the stated unit price 40 × quantity 2 = 80/);
  });
  it("7. required-field validation: an empty submission must be rejected; accepting it fails", async () => {
    const ok = await run("/form", page => requirementsCheck("form").execute(context(page), new Set(["form"]), true));
    expect(ok.message).toMatch(/empty submission with 3 required field\(s\) rejected/);
    const broken = await run("/form-broken", page => requirementsCheck("form").execute(context(page), new Set(["form"]), true).catch((cause: unknown) => cause));
    expect(broken).toBeInstanceOf(FunctionalValidationError); expect((broken as Error).message).toMatch(/accepts a submission with 3 empty required field/);
  });
  it("8. multi-step: working Next/Back passes; a dead Next or a Back that loses entered values fails", async () => {
    expect(await run("/steps", page => probeMultiStep(page))).toMatch(/Next advanced from step 1 to 2, Back returned with 1 entered value\(s\) preserved/);
    const next = await run("/steps-next-broken", page => probeMultiStep(page).catch((cause: unknown) => cause));
    expect(next).toBeInstanceOf(FunctionalValidationError); expect((next as Error).message).toMatch(/Next does not advance/);
    const back = await run("/steps-back-broken", page => probeMultiStep(page).catch((cause: unknown) => cause));
    expect(back).toBeInstanceOf(FunctionalValidationError); expect((back as Error).message).toMatch(/Back loses values entered on the previous step: "full-name"/);
  });
  it("9. selection/comparison shows exactly the selected items and drops a deselected one", async () => {
    expect(await run("/compare", page => probeComparison(page))).toMatch(/selecting "Aero 13", "Book 15" showed them.*deselecting removed "Aero 13"/);
  });
  it("10. controls and items are found semantically in a different DOM structure (div cards, pressed buttons)", async () => {
    expect(await run("/semantic", page => probeFiltering(page))).toMatch(/"Indoor" narrowed 5→3 items/);
    expect(await run("/semantic", page => probeSorting(page))).toMatch(/"Name A–Z" reordered 5 items by name/);
    expect(fixtures["/semantic"]).not.toMatch(/data-test|data-qa|class=/);
  });
  it("11. calculations: no invented expected value without a stated formula; a stated formula is enforced", async () => {
    const formula = extractCalculationFormula("Add an order calculator. Total = price × quantity.")!;
    expect(formula).toMatchObject({ result: "total", variables: ["price", "quantity"] });
    const limited = await run("/calc-wrong", page => probeCalculation(page).catch((cause: unknown) => cause));
    expect(limited).toBeInstanceOf(FunctionalCoverageLimit); expect((limited as Error).message).toMatch(/correctness was not asserted because no explicit formula/);
    expect(await run("/calc", page => probeCalculation(page, page, formula))).toMatch(/verified against the stated formula: price=15, quantity=3 → 45\.00/);
    const wrong = await run("/calc-wrong", page => probeCalculation(page, page, formula).catch((cause: unknown) => cause));
    expect(wrong).toBeInstanceOf(FunctionalValidationError); expect((wrong as Error).message).toMatch(/"total" shows 18\.00 for price=15, quantity=3; the stated rule .* gives 45/);
    const dead = await run("/calc-static", page => probeCalculation(page, page, formula).catch((cause: unknown) => cause));
    expect(dead).toBeInstanceOf(FunctionalValidationError); expect((dead as Error).message).toMatch(/does not update any visible result/);
  });
  it("12. unsupported or uninterpretable requests are limited coverage, never a pass or a failure", async () => {
    const error = await run("/sort-ambiguous", page => probeSorting(page).catch((cause: unknown) => cause));
    expect(error).toBeInstanceOf(FunctionalCoverageLimit);
    const contract: ResolvedFunctionalContract = { version: 1, pages: [], actualRoutes: ["/sort-ambiguous"], requirements: [{ id: "functional:sort:any", capability: "sort", target: { kind: "ANY_PAGE" },
      expectedBehavior: "", mandatory: true, validation: "BROWSER_BEHAVIOR", routes: ["/sort-ambiguous"] }] };
    const result = await run("/sort-ambiguous", page => runRouteRequirements(context(page, "/sort-ambiguous"), contract, () => probeSorting(page)));
    expect(result).toMatchObject({ status: "PASS", functionalProbes: [{ requirementId: "functional:sort:any", result: "LIMITED" }] });
    const plan = { mode: "TARGETED", profile: "FUNCTIONAL", targets: [], checkGroups: ["INTERACTION"], interactionViewports: ["DESKTOP"], screenshotTargets: [], fullPageScreenshots: false, reasons: [],
      requirements: [{ id: "functional:sort:any", capability: "sort", routes: ["/sort-ambiguous"], policy: "REQUIRED", reason: "SOURCE_RECOGNIZED" }] } satisfies BrowserQAPlan;
    const verification = evaluateQAVerification(plan, report([result]));
    expect(verification).toMatchObject({ outcome: "VERIFIED", limitedCoverage: true, requirements: [{ status: "UNVERIFIED", detail: expect.stringMatching(/^LIMITED_COVERAGE: No sort control states/) as unknown }] });
  });
});

// ---------------------------------------------------------------------------
// Request understanding, prompt neutrality and source recognition
// ---------------------------------------------------------------------------

describe("Phase 5 request and source evidence (deterministic)", () => {
  const request = "Build a ceramics shop with sorting by price, filters by availability, a shipping cost calculator, a 3-step checkout form and let shoppers select products to compare.";
  it("recognizes reusable behavior families from explicit wording only", () => {
    expect(functionalRequirements(request).capabilities).toEqual(expect.arrayContaining(["sort", "filter", "calculator", "multi-step", "comparison"]));
    expect(functionalRequirements("Some sort of calm portfolio with a comparison table of plans and a category filter").capabilities).toEqual(["category-filter"]);
    expect(sortIntent("Price: High to Low")).toEqual({ key: "price", direction: "desc" }); expect(sortIntent("Featured")).toBeUndefined();
  });
  it("adds no prompt text or tokens: generation and planning guidance are unchanged", () => {
    const withFamilies = functionalRequirements(`${request} Include a contact form.`), legacyOnly = functionalRequirements("Build a ceramics shop. Include a contact form.");
    expect(functionalGenerationContract(withFamilies)).toBe(functionalGenerationContract(legacyOnly));
    expect(functionalRouteGuidance(withFamilies)).toBe(functionalRouteGuidance(legacyOnly));
    expect(functionalGenerationContract(functionalRequirements(request))).toBe("");
  });
  it("parses only explicit formulas and evaluates them exactly", () => {
    const formula = extractCalculationFormula("The monthly payment equals loan amount times rate divided by 12.")!;
    expect(formula.variables).toEqual(["loan amount", "rate"]);
    expect(evaluateCalculationFormula(formula, { "loan amount": 1200, rate: 0.05 })).toBeCloseTo(5);
    expect(extractCalculationFormula("Show a nice estimate for the project")).toBeUndefined();
    expect(extractCalculationFormula("Add a mortgage calculator")).toBeUndefined();
  });
  it("source recognition needs a control and its logic; text alone is never evidence", () => {
    const route = (body: string) => functionalSourceManifest({ files: [{ path: "src/App.tsx", content: `import { useState } from "react";
const items=[{name:"A",price:2},{name:"B",price:1}];
export function App(){const [order,setOrder]=useState("a");${body}}` }] }).routes[0]!.capabilityAssessments;
    expect(route('const shown=[...items].sort((a,b)=>order==="a"?a.price-b.price:b.price-a.price);return <main><select aria-label="Sort" value={order} onChange={e=>setOrder(e.target.value)}><option value="a">Price: Low to High</option><option value="d">Price: High to Low</option></select><ul>{shown.map(i=><li key={i.name}>{i.name}</li>)}</ul></main>;').sort.state).toBe("RECOGNIZED");
    expect(route('return <main><select aria-label="Sort" value={order} onChange={e=>setOrder(e.target.value)}><option value="a">Price: Low to High</option></select><ul>{items.map(i=><li key={i.name}>{i.name}</li>)}</ul></main>;').sort.state).toBe("UNCERTAIN");
    expect(route('return <main><p>Sort by price coming soon</p></main>;').sort.state).toBe("PROVEN_MISSING");
    expect(route('const [s,setS]=useState(1);return <main><button onClick={()=>setS(2)}>Next</button><button onClick={()=>setS(1)}>Back</button></main>;')["multi-step"].state).toBe("RECOGNIZED");
  });
});

// ---------------------------------------------------------------------------
// Adaptive QA integration, repair allowance, persistence and billing
// ---------------------------------------------------------------------------

const routes = ["/", "/shop", "/about"];
const site = (shop: string, about = "We are a small studio.") => `import { useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
const products = [{ name: "Vase", price: 40 }, { name: "Bowl", price: 25 }];
function Header(){return <header><a href="/">Home</a><a href="/shop">Shop</a><a href="/about">About</a></header>}
function Home(){return <main><h1>Studio</h1><p>Handmade ceramics.</p></main>}
function Shop(){${shop}}
function About(){return <main><h1>About</h1><p>${about}</p></main>}
export function App(){return <BrowserRouter><Header/><Routes><Route path="/" element={<Home/>}/><Route path="/shop" element={<Shop/>}/><Route path="/about" element={<About/>}/></Routes></BrowserRouter>}`;
const plainShop = 'return <main><h1>Shop</h1><ul>{products.map(p => <li key={p.name}>{p.name} ${"$"}{p.price}</li>)}</ul></main>';
const sortedShop = 'const [order,setOrder]=useState("a");const shown=[...products].sort((a,b)=>order==="a"?a.price-b.price:b.price-a.price);return <main><h1>Shop</h1><select aria-label="Sort products" value={order} onChange={e=>setOrder(e.target.value)}><option value="a">Price: Low to High</option><option value="d">Price: High to Low</option></select><ul>{shown.map(p => <li key={p.name}>{p.name} ${"$"}{p.price}</li>)}</ul></main>';
const files = (content: string) => new Map([["src/App.tsx", content]]);

describe("Phase 5 adaptive QA integration (offline)", () => {
  it("13. a functional edit adding sorting tests only the affected route, as a required, source-recognized behavior", () => {
    const before = files(site(plainShop)), after = files(site(sortedShop));
    const requirements = requestedEditRequirements("Add sorting by price to the shop page", after);
    expect(requirements).toEqual([{ id: "edit.sort", capability: "sort", routes: ["/shop"], policy: "REQUIRED", reason: "SOURCE_RECOGNIZED" }]);
    const plan = selectEditQAPlan({ impact: analyzeEditImpact(before, after, ["src/App.tsx"], routes), requirements, routes });
    expect(plan.targets.map(target => `${target.viewport.id} ${target.route}`).sort()).toEqual(["DESKTOP /shop", "MOBILE /shop"]);
    expect(plan.screenshotTargets).toEqual([]);
  });
  it("14. a simple text edit keeps Phase 2's minimal browser cost and plans no behavior probes", () => {
    const before = files(site(plainShop)), after = files(site(plainShop, "We are an independent studio."));
    const requirements = requestedEditRequirements('Change the about text to "We are an independent studio."', after);
    const plan = selectEditQAPlan({ impact: analyzeEditImpact(before, after, ["src/App.tsx"], routes), requirements, routes });
    expect(requirements).toEqual([]);
    expect(plan).toMatchObject({ profile: "TEXT", checkGroups: ["CORE"], screenshotTargets: [] });
    expect(plan.targets.length).toBeLessThanOrEqual(1);
  });
});

function report(checks: readonly BrowserQACheckResult[]): BrowserQAReport {
  return createBrowserQAReport({ runId: "offline", browser: { name: "chromium" }, routes: ["/"], viewports: [], checks: [...checks], startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), durationMs: 1 });
}
const sortProbe = (result: "PASS" | "FAIL") => createBrowserQACheckResult({ checkId: "functional.requirements", category: "INTERACTION", status: result, severity: "ERROR", route: "/shop",
  ...(result === "FAIL" ? { failureKind: "FUNCTIONAL_FAILURE" as const } : {}),
  message: result === "PASS" ? "Sorting verified" : 'edit.sort on /shop: Sort "Price: High to Low" does not order items by price descending. Observed: "Bowl (25)", "Vase (40)"; expected: "Vase (40)", "Bowl (25)"',
  functionalProbes: [{ requirementId: "edit.sort", capability: "sort", expectedRoute: "/shop", actualRoute: "/shop", result }] });

async function editHarness(after: string, qa: (product: ReturnType<typeof createLocalSitesProduct>) => void) {
  const root = await mkdtemp(join(tmpdir(), "phase5-edit-"));
  const execution = new MockExecutionProvider();
  const execute = execution.executeCommand.bind(execution);
  vi.spyOn(execution, "executeCommand").mockImplementation(async (id, command) => {
    if (command.args?.[0] === "ci") { const now = new Date(); return { exitCode: 0, stdout: "offline install", stderr: "", timedOut: false, durationMs: 0, startedAt: now, finishedAt: now }; }
    const result = await execute(id, command);
    if (result.exitCode === 0) await execution.writeFile(id, "dist/index.html", '<div id="root"></div>');
    return result;
  });
  const original = site(plainShop);
  const mock = new MockAgentProvider({ customResponse: request => ({ id: "offline-edit", model: request.model,
    message: { role: "assistant", content: JSON.stringify({ patches: [{ path: "src/App.tsx", mode: "unique", find: original, replace: after }] }) },
    toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 }, latencyMs: 0, finishReason: "stop" }) });
  const calls = { count: 0 };
  const provider = { id: "offline-phase5-edit", getCapabilities: () => mock.getCapabilities(), createResponse: (...args: Parameters<typeof mock.createResponse>) => { calls.count++; return mock.createResponse(...args); } };
  const registry = new AgentProviderRegistry(); registry.register(provider);
  const finalize = vi.fn(async (job: SiteJob) => ({ ...job, billingStatus: "CHARGED" as const, creditsCharged: 1 }));
  const preflight = vi.fn(async () => ({ ownerId: "offline", modelRate: { model: "mock-sites-v1", platform: "mock-agent", type: "ai_chat", creditsPer500Tokens: 1 } }));
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), execution: execution as never,
    agentRegistry: registry, orchestrationAgent: provider, billing: { preflight, finalizeSuccessfulJob: finalize } as unknown as SiteCreditBillingService });
  qa(product);
  const siteId = "phase5-edit-project" as SiteId, ownerId = "offline" as UserId, versionId = "initial-version" as VersionId;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<div id="root"></div>'));
  const environment = await execution.createEnvironment({});
  for (const [path, content] of Object.entries({ "src/App.tsx": original, "src/main.tsx": "// managed entry", "index.html": '<div id="root"></div>', "package.json": JSON.stringify({ scripts: { build: "vite build" } }) }))
    await execution.writeFile(environment.id, path, content);
  const sourceRef = "sites/phase5-edit-project/current/source.json";
  await new SiteSourceSnapshotService(product.artifacts).capture(execution as never, environment.id, sourceRef, { technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1 });
  await execution.destroyEnvironment(environment.id);
  const now = new Date();
  await product.projects.save({ id: siteId, ownerId, name: "Existing", slug: "existing", status: "ACTIVE", latestVersionId: versionId, createdAt: now, updatedAt: now });
  await product.versions.save({ id: versionId, siteId, versionNumber: 1, sourceArtifactRef: sourceRef, buildStatus: "SUCCEEDED", createdAt: now });
  const run = (instruction: string) => product.pipeline.edit({ userId: ownerId, siteId, instruction, agentProvider: provider.id, browserQAEnabled: true });
  const cleanup = async () => { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); };
  return { product, run, finalize, siteId, versionId, calls, cleanup };
}

describe("Phase 5 edit pipeline outcomes (offline, mocked model and browser)", () => {
  it("a verified sorting edit records what was checked, saves once and charges once", async () => {
    const h = await editHarness(site(sortedShop), product => { vi.spyOn(product.browserQA, "run").mockResolvedValue(report([sortProbe("PASS")])); });
    try {
      const result = await h.run("Add sorting by price to the shop page");
      expect(result.qaVerification).toMatchObject({ outcome: "VERIFIED", coverage: "REQUIREMENTS", requirements: [{ id: "edit.sort", status: "VERIFIED" }] });
      expect(h.finalize).toHaveBeenCalledOnce(); expect(h.calls.count).toBe(1);
    } finally { await h.cleanup(); }
  });
  it("15/16. a sorting failure spends no extra model calls, is never saved and never charged", async () => {
    const counts: number[] = [];
    for (const [instruction, after, failure] of [
      ["Add sorting by price to the shop page", sortedShop, sortProbe("FAIL")],
      // Existing Phase 2 capability, same pipeline: the allowance must be identical.
      ["Add a product search to the shop page", 'const [q,setQ]=useState("");return <main><h1>Shop</h1><input type="search" aria-label="Search products" value={q} onChange={e=>setQ(e.target.value)}/><ul>{products.filter(p=>p.name.toLowerCase().includes(q)).map(p=><li key={p.name}>{p.name}</li>)}</ul></main>',
        createBrowserQACheckResult({ ...sortProbe("FAIL"), message: "edit.search on /shop: Search does not update visible results", functionalProbes: [{ requirementId: "edit.search", capability: "search", expectedRoute: "/shop", actualRoute: "/shop", result: "FAIL" }] })],
    ] as const) {
      const h = await editHarness(site(after), product => { vi.spyOn(product.browserQA, "run").mockResolvedValue(report([failure])); });
      try {
        await expect(h.run(instruction)).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { failureStage: "BROWSER_QA", qaOutcome: "FAILED" } });
        expect(h.finalize).not.toHaveBeenCalled();
        expect((await h.product.projects.getById(h.siteId))!.latestVersionId).toBe(h.versionId);
        const job = (await h.product.jobs.listBySite(h.siteId)).items[0]!;
        expect([job.billingStatus, job.creditsCharged]).toEqual(["NOT_CHARGED", 0]);
        counts.push(h.calls.count);
      } finally { await h.cleanup(); }
    }
    expect(counts[0]).toBe(counts[1]);
  });
  it("17. a browser infrastructure error during behavior verification stays INCONCLUSIVE and uncharged", async () => {
    const h = await editHarness(site(sortedShop), product => {
      vi.spyOn(product.browserQA, "run").mockImplementation(input => new BrowserQARunner({ launchBrowser: async () => { throw new Error("browserType.launch: Executable doesn't exist"); } }).run(input));
    });
    try {
      await expect(h.run("Add sorting by price to the shop page")).rejects.toMatchObject({ code: "BROWSER_QA_INCONCLUSIVE", metadata: { qaOutcome: "INCONCLUSIVE" } });
      expect(h.finalize).not.toHaveBeenCalled();
      expect((await h.product.projects.getById(h.siteId))!.latestVersionId).toBe(h.versionId);
    } finally { await h.cleanup(); }
  });
});
