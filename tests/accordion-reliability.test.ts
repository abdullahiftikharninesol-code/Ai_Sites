import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { functionalBrowserChecks } from "../src/browser-qa/functional-capability-checks.js";
import { functionalRequirements } from "../src/sites/generation/functional-capabilities.js";
import { withFunctionalContract, functionalBehaviors, type ResolvedFunctionalContract } from "../src/sites/generation/functional-route-contract.js";
import { functionalSourceManifest, resolveFunctionalSourceContract } from "../src/sites/generation/functional-source-contract.js";
import { assembleSiteSpec, DeterministicDesignPlanner, DeterministicRequirementsPlanner } from "../src/planning/planning.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import type { FunctionalCapability } from "../src/sites/generation/functional-capabilities.js";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { browserQARuntimeChecks } from "../src/browser-qa/browser-qa-runtime-checks.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
const prompt = "### Home\nBuild a frontend-only homepage with a working FAQ accordion.";
async function spec(text = prompt) {
  const requirements = await new DeterministicRequirementsPlanner().plan(text), design = await new DeterministicDesignPlanner().plan(requirements);
  return withFunctionalContract(assembleSiteSpec("Accordion fixture", text, requirements, design), functionalRequirements(text));
}
const bundle = (source: string) => ({ files: [{ path: "src/App.tsx", content: source }] });
describe("Evidence-based static completion", () => {
  it.each([
    ["RECOGNIZED", 'export function App(){return <main><details><summary>Question</summary><p>A meaningful answer.</p></details></main>}'],
    ["RECOGNIZED", 'import {Accordion as Questions} from "./sites-ui/functional";export function App(){return <main><Questions items={[]}/></main>}'],
    ["UNCERTAIN", 'import {useState} from "react";export function App(){const[open,setOpen]=useState(false);return <main><button aria-expanded={open} onClick={()=>setOpen(!open)}>Question?</button>{open&&<p>A meaningful answer.</p>}</main>}'],
    ["UNCERTAIN", 'import Questions from "./third-party";export function App(){return <main><Questions/></main>}'],
    ["UNCERTAIN", 'export function App(){return renderQuestions()}'],
    ["PROVEN_MISSING", 'export function App(){/* Accordion */return <main><h1>Accordion</h1><p>Only introductory copy.</p></main>}'],
    ["PROVEN_MISSING", 'import {Accordion} from "./sites-ui/functional";export function App(){return <main><p>Nothing interactive here.</p></main>}'],
    ["PROVEN_MISSING", 'function Unused(){return <details><summary>Question</summary><p>Answer</p></details>}export function App(){return <main><p>No controls.</p></main>}'],
  ] as const)("classifies %s using rendered syntax, not comments/names", async (state, source) => {
    const value = bundle(source), manifest = functionalSourceManifest(value);
    expect(manifest.routes[0]?.capabilityAssessments.accordion.state).toBe(state);
    const requirements = await spec();
    if (state === "PROVEN_MISSING") expect(() => resolveFunctionalSourceContract(requirements, value)).toThrow(/Required accordion has no implemented control/);
    else expect(resolveFunctionalSourceContract(requirements, value).requirements[0]?.sourceAssessment?.state).toBe(state);
  });
  it.each([0, 60, 120])("does not reject a custom implementation based on prompt length (%s paragraphs)", async paragraphs => {
    const text = "Use balanced typography, generous spacing and a polished palette. ".repeat(paragraphs) + "\n" + prompt;
    const source = bundle('export function App(){const[open,setOpen]=useState(false);return <main><button aria-expanded={open} onClick={()=>setOpen(!open)}>Question?</button>{open&&<p>A meaningful answer.</p>}</main>}');
    expect(resolveFunctionalSourceContract(await spec(text), source).requirements[0]?.sourceAssessment?.state).toBe("UNCERTAIN");
  });
});

type Kind = "native" | "native-open" | "custom" | "nested" | "flat" | "no-aria" | "controlled" | "initial-open" | "missing" | "decorative" | "never-close" | "always-visible" | "unrelated-update" | "menu-only" | "broken-controls" | "hidden" | "one-broken";
async function fixture(kind: Kind): Promise<string> {
  let rows: string;
  if (kind === "native" || kind === "native-open") rows = `<details ${kind === "native-open" ? "open" : ""}><summary>How does a project begin?</summary><p>We start with discovery and agree on an achievable delivery plan.</p></details>`;
  else if (["missing", "menu-only"].includes(kind)) rows = "<p>General information with no FAQ controls.</p>";
  else rows = [0, 1, 2].map(index => {
    const open = kind === "initial-open";
    const handler = kind === "decorative" ? "this.setAttribute('aria-expanded',String(this.getAttribute('aria-expanded')!=='true'))"
      : kind === "unrelated-update" ? "this.setAttribute('aria-expanded',String(this.getAttribute('aria-expanded')!=='true'));document.getElementById('outside').textContent='An unrelated notification changed'"
      : `toggle(this,${index},${JSON.stringify(kind === "one-broken" && index === 1 ? "decorative" : kind)})`;
    const button = `<button type="button" ${kind === "no-aria" ? "" : `aria-expanded="${open}"`} ${["controlled", "broken-controls"].includes(kind) ? `aria-controls="${kind === "broken-controls" ? "wrong" : "answer-" + index}"` : ""} onclick="${handler.replaceAll('"', '&quot;')}">How does project ${index + 1} begin?</button>`;
    const answer = `<div id="answer-${index}" ${open || kind === "always-visible" ? "" : "hidden"}><p>We begin with discovery, validate the approach and agree on a practical delivery plan.</p></div>`;
    return kind === "flat" ? button + answer : `<div ${kind === "hidden" ? "hidden" : ""}>${kind === "nested" || kind === "no-aria" ? `<h3><span>${button}</span></h3>` : button}${answer}</div>`;
  }).join("");
  const html = `<!doctype html><html><body><header><button aria-expanded="false" aria-controls="menu" onclick="this.setAttribute('aria-expanded',String(document.getElementById('menu').hidden));document.getElementById('menu').hidden=!document.getElementById('menu').hidden">Menu</button><nav id="menu" hidden><a href="/">Home</a></nav></header><main><h1>Studio</h1><section><h2>Frequently asked questions</h2>${rows}</section><p id="outside" role="status"></p><p id="wrong">An unrelated always-visible paragraph.</p></main><script>const states=[${kind === "initial-open"},${kind === "initial-open"},${kind === "initial-open"}];function toggle(button,index,kind){states[index]=!states[index];if(button.hasAttribute('aria-expanded'))button.setAttribute('aria-expanded',String(states[index]));if(kind!=='decorative'&&kind!=='always-visible')document.getElementById('answer-'+index).hidden=kind==='never-close'?false:!states[index];}</script></body></html>`;
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); }); servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port"); return `http://127.0.0.1:${address.port}`;
}
describe("Production accordion behavior at desktop/tablet/mobile", () => {
  it.each(["native", "native-open", "custom", "nested", "flat", "no-aria", "controlled", "initial-open"] as const)("accepts meaningful expand/collapse for %s", async kind => {
    const report = await run(kind);
    if (report.status !== "PASS") console.info("[accordion-fixture]", JSON.stringify({ kind, failures: report.checks.filter(check => check.status === "FAIL") }));
    expect(report.status).toBe("PASS");
    expect(report.checks.filter(check => check.checkId === "functional.requirements").map(check => check.status)).toEqual(["PASS", "PASS", "PASS"]);
  }, 60_000);
  it.each(["missing", "decorative", "never-close", "always-visible", "unrelated-update", "menu-only", "broken-controls", "hidden", "one-broken"] as const)("rejects %s without accepting cosmetic/unrelated changes", async kind => {
    const report = await run(kind); expect(report.status).toBe("FAIL");
    expect(report.checks.filter(check => check.checkId === "functional.requirements").map(check => check.status)).toEqual(["FAIL", "FAIL", "FAIL"]);
  }, 60_000);
});
async function run(kind: Kind) {
  const contract: ResolvedFunctionalContract = { version: 1, pages: [], actualRoutes: ["/"], requirements: [{ id: "functional:accordion:home", capability: "accordion", target: { kind: "PAGE", pageName: "Home", pageId: "home" }, routes: ["/"], expectedBehavior: functionalBehaviors.accordion, mandatory: true, validation: "BROWSER_BEHAVIOR", sourceAssessment: { state: "UNCERTAIN", reason: "DYNAMIC_OR_CUSTOM_IMPLEMENTATION" } }] };
  const checks = functionalBrowserChecks({ version: 1, capabilities: ["accordion"], backendRequired: false, unsupportedTransactions: false }, ["/"], false, contract);
  return new BrowserQARunner().run({ runId: `accordion-${kind}`, target: { baseUrl: await fixture(kind) }, routes: ["/"], checks: [checks[1]!], policy: { captureScreenshots: false } });
}

async function markupReport(markup: string, capability: FunctionalCapability, formSmoke = false) {
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.method ?? ""); response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><html><body><main><h1>Native controls</h1>${markup}</main></body></html>`); }); servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const checks = functionalBrowserChecks({ version: 1, capabilities: [capability], backendRequired: false, unsupportedTransactions: false }, ["/"]);
  const report = await new BrowserQARunner().run({ runId: "native-variants", target: { baseUrl: `http://127.0.0.1:${address.port}` }, checks: [checks[1]!, ...browserQACoreCheckExecutors.filter(check => check.definition.checkId === "runtime.page-error"), ...(formSmoke ? [...browserQAResponsiveAndInteractionChecks.filter(check => check.definition.checkId === "form-smoke"), ...browserQARuntimeChecks.filter(check => check.definition.checkId === "accessibility-smoke")] : [])], policy: { captureScreenshots: false } });
  if (report.checks.some(check => check.checkId === "runtime.page-error" && check.status === "FAIL")) console.info("[native-fixture-errors]", JSON.stringify(report.checks.filter(check => check.checkId === "runtime.page-error")));
  expect(report.checks.filter(check => check.checkId === "runtime.page-error").every(check => check.status === "PASS")).toBe(true);
  return { report, requests };
}
describe("Valid native variations from retained live source", () => {
  it.each(["valid", "empty-select", "no-feedback", "network", "unlabelled"])("validates wrapping labels, required selects and checkbox without bypassing submission safety: %s", async kind => {
    const handler = kind === "no-feedback" ? "" : kind === "network" ? "fetch('/submit',{method:'POST'}).catch(()=>{});" : "this.querySelector('[role=status]').textContent='Demo confirmation only; nothing was sent';";
    const label = (text: string, input: string) => kind === "unlabelled" ? input : `<label>${text}${input}</label>`;
    const html = `<form onsubmit="event.preventDefault();${handler}">${label("Name", '<input name="name" required>')}${label("Email", '<input name="email" type="email" required>')}${label("Message", '<textarea name="message" required></textarea>')}${label("Service", `<select name="service" required><option value="">Choose service</option>${kind === "empty-select" ? "" : '<option value="design">Design</option>'}</select>`)}${label("Consent", '<input name="consent" type="checkbox" required>')}<button type="submit">Send demo message</button><p role="status"></p></form>`;
    const { report, requests } = await markupReport(html, "form", true);
    const functional = report.checks.filter(check => check.checkId === "functional.requirements");
    expect(functional.every(check => check.status === (["valid", "unlabelled"].includes(kind) ? "PASS" : "FAIL"))).toBe(true);
    const labels = report.checks.filter(check => check.checkId === "form-smoke");
    expect(labels.every(check => check.status === (kind === "unlabelled" ? "FAIL" : "PASS"))).toBe(true);
    expect(report.checks.filter(check => check.checkId === "accessibility-smoke").every(check => check.status === (kind === "unlabelled" ? "WARNING" : "PASS"))).toBe(true);
    expect(requests).not.toContain("POST");
    if (kind === "valid") expect(report.status).toBe("PASS");
  }, 60_000);
  it.each(["valid", "no-panel", "stuck-open", "bad-relation", "bad-link"])("verifies semantic mobile navigation with optional ID relation: %s", async kind => {
    const html = `<button aria-label="Open menu" aria-expanded="false" ${kind === "bad-relation" ? 'aria-controls="missing"' : ""} onclick="this.setAttribute('aria-expanded',String(this.getAttribute('aria-expanded')!=='true'));${kind === "no-panel" ? "" : kind === "stuck-open" ? "document.getElementById('panel').hidden=false" : "document.getElementById('panel').hidden=this.getAttribute('aria-expanded')!=='true'"}">Menu</button><nav id="panel" aria-label="Mobile navigation" hidden><a href="${kind === "bad-link" ? "#" : "/"}">Home</a></nav>`;
    const { report } = await markupReport(html, "mobile-nav");
    expect(report.status).toBe(kind === "valid" ? "PASS" : "FAIL");
  }, 60_000);
  it.each([["button", false], ["article", false], ["button", true], ["article", true]] as const)("proves filtering with stable item identity for %s cards (broken=%s)", async (tag, broken) => {
    const html = `<div role="group">${["All", "AI", "Web"].map(value => `<button aria-pressed="${value === "All"}" onclick="choose(this)">${value}</button>`).join("")}</div><div id="cards"></div><p id="selection" role="status"></p><script>const items=[['Signal Atlas','AI'],['Canvas Lab','Web'],['Flow Builder','AI']];function choose(button){button.parentElement.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));${broken ? "" : "render(button.innerText)"}}function render(category){const cards=document.getElementById('cards');cards.replaceChildren();items.filter(item=>category==='All'||item[1]===category).forEach((item,index)=>{const card=document.createElement(${JSON.stringify(tag)}),heading=document.createElement('h3'),number=document.createElement('span'),description=document.createElement('p');heading.textContent=item[0];number.textContent=String(index+1);description.textContent=item[1]+' delivery project';card.append(number,heading,description);card.onclick=()=>{document.getElementById('selection').textContent=item[0]};cards.append(card)})}render('All')</script>`;
    const { report } = await markupReport(html, "category-filter");
    if (report.status !== (broken ? "FAIL" : "PASS")) console.info("[card-fixture]", JSON.stringify(report.checks));
    expect(report.status).toBe(broken ? "FAIL" : "PASS");
  }, 60_000);
});
