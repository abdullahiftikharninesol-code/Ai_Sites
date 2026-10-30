import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import { createBuildRepairSourceSnapshot } from "../src/cli/runtime/build-repair-source.js";
import { requestedPages } from "../src/sites/generation/requested-pages.js";
import { functionalRequirements } from "../src/sites/generation/functional-capabilities.js";
import { functionalSourceManifest } from "../src/sites/generation/functional-source-contract.js";
import { probeDialogBehavior } from "../src/browser-qa/dialog-behavior.js";
import { functionalBrowserChecks } from "../src/browser-qa/functional-capability-checks.js";

let browser: Browser;
const servers: Server[] = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); await Promise.all(servers.map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
async function fixture(html: string, width = 1440) {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  servers.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const page = await browser.newPage({ viewport: { width, height: 1000 } }); await page.goto(`http://127.0.0.1:${address.port}`); return page;
}

describe("Private rejected-repair evidence", () => {
  it("retains verified identities while redacting secrets and bounding proposal text", async () => {
    const parent = resolve(".sites-runtime/complex-private-evidence-tests"); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "case-"));
    if (!root.startsWith(parent + sep)) throw new Error("Unsafe cleanup");
    vi.stubEnv("COMPLEX_DIAGNOSTIC_SECRET", "private-fixture-value-do-not-retain");
    try {
      const snapshot = createBuildRepairSourceSnapshot([{ path: "src/App.tsx", content: 'export const title = "private-fixture-value-do-not-retain";' }], "src/App.tsx:1");
      const file = await new LocalFailedCandidateEvidence(root).preserve({ execution: { listFiles: async () => [], readFile: async () => "" }, environmentId: "offline", jobId: "private-repair", siteId: "offline",
        validationFailure: { failureStage: "PATCH_APPLICATION", code: "VALIDATION_FAILED", check: "missing-anchor", message: "Rejected source anchor", buildPassed: false },
        buildRepair: { attempt: 1, kind: "build", sourceRevision: snapshot.revision, contextDigest: snapshot.contextDigest, initialDiagnostics: "Build error", billingState: "NOT_FINALIZED", result: "MISSING_FIND_TEXT", patches: [], requestSnapshot: snapshot,
          proposal: { patches: [{ path: "src/App.tsx", find: 'title = "private-fixture-value-do-not-retain"', replace: "x".repeat(32001) }] } } });
      expect(file).toBeDefined(); const text = await readFile(file!, "utf8");
      expect(text).not.toContain("private-fixture-value-do-not-retain"); expect(text).not.toContain("x".repeat(32001));
      const saved = JSON.parse(text) as { buildRepair: { requestSnapshot: { revision: string }; proposal: { patches: { findDigest: string; replace?: string }[] } } };
      expect(saved.buildRepair.requestSnapshot.revision).toBe(snapshot.revision);
      expect(saved.buildRepair.proposal.patches[0]?.findDigest).toMatch(/^[a-f0-9]{64}$/); expect(saved.buildRepair.proposal.patches[0]?.replace).toBeUndefined();
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});

describe("Numbered page declarations and actual manual routing", () => {
  it.each(["—", "–", ":", "-"])("owns requirements under Page N %s Name without inventing incidental pages", separator => {
    const prompt = `Build a software agency.\n## Page 1 ${separator} Home\nCompany overview.\n## Page 2 ${separator} Solutions (/studio/solutions)\nWorking service tabs.\n## Page 3 ${separator} Case Studies (/studio/cases)\nCategory filters and a project detail modal.\n## Page 4 ${separator} Contact\nInquiry form and FAQ accordion.\n## Functional Requirements\nMobile menu, service tabs and project detail modal. Include team profiles and AI agents in the copy.`;
    expect(requestedPages(prompt).map(page => page.path)).toEqual(["/", "/studio/solutions", "/studio/cases", "/contact"]);
    const requirements = functionalRequirements(prompt).requirements!;
    expect(requirements.find(item => item.capability === "tabs")?.target.pageName).toBe("Solutions");
    expect(requirements.find(item => item.capability === "dialog")?.target.pageName).toBe("Case Studies");
    expect(requirements.filter(item => item.capability === "accordion").map(item => item.target.pageName)).toEqual(["Contact"]);
  });
  it("recognizes the exact normalized-path and sequential assignment pattern from the failed candidate", () => {
    const content = `function Home(){return <section><h1>Home</h1><p>Studio overview.</p></section>}
function Solutions(){return <section><h1>Solutions</h1><p>Service details.</p></section>}
function Contact(){return <section><h1>Contact</h1><p>Inquiry details.</p></section>}
export function App(){const path=window.location.pathname.replace(/\\/$/,'')||'/';let page=<Home/>;if(path==='/studio/solutions')page=<Solutions/>;if(path==='/contact')page=<Contact/>;return <main>{page}</main>}`;
    const manifest = functionalSourceManifest({ files: [{ path: "src/App.tsx", content }] });
    expect(manifest.routes.map(route => route.path).sort()).toEqual(["/", "/contact", "/studio/solutions"]);
    expect(manifest.routes.find(route => route.path === "/studio/solutions")?.labels).toContain("Solutions");
  });
  it("keeps expandable questions on both explicitly requested pages", () => {
    const prompt = '## Page 1 — Home\nFAQ section with three expandable questions.\n## Page 2 — Contact\nFour expandable questions with useful answers.\n## Functional Requirements\nFAQ accordions on Home and Contact.';
    expect(functionalRequirements(prompt).requirements?.filter(item => item.capability === "accordion").map(item => item.target.pageName)).toEqual(["Home", "Contact"]);
  });
  it("keeps nested FAQ and team sections inside their explicitly declared page", () => {
    const prompt = '## Page 1 — Home\n### FAQ\nWorking FAQ accordion.\n### Team\nFour profiles.\n## Page 2 — Contact\nInquiry form.';
    expect(requestedPages(prompt).map(page => page.name)).toEqual(["Home", "Contact"]);
    expect(functionalRequirements(prompt).requirements?.find(item => item.capability === "accordion")?.target.pageName).toBe("Home");
  });
});

describe("Content-card dialog triggers from the real failure pattern", () => {
  it.each([1440, 768, 390])("opens a project card's native dialog at width %i without requiring View/Details copy", async width => {
    const page = await fixture(`<main><h1>Selected work</h1><button class="project-card" onclick="document.querySelector('dialog').showModal()"><h3>Coastal research</h3><p>A searchable evidence platform for distributed teams.</p><strong>Research time reduced by 40%.</strong></button><dialog><h2>Coastal research</h2><p>A complete engagement story with delivery details and measurable outcomes.</p><button aria-label="Close project details" onclick="document.querySelector('dialog').close()">×</button><button onclick="document.querySelector('dialog').close()">Close details</button></dialog></main>`, width);
    try { await probeDialogBehavior(page, page.locator("main")); expect(await page.getByRole("dialog").count()).toBe(0); } finally { await page.close(); }
  });
  it.each(["native-open", "aria", "role-button", "anchor"])("supports %s dialog patterns with content-card identity", async kind => {
    const opening = kind === "anchor" ? '<a href="#" aria-haspopup="dialog" onclick="event.preventDefault();showDetails()">Inspect</a>' : kind === "role-button" ? '<div role="button" tabindex="0" onclick="showDetails()"><h3>Coastal research</h3><p>Useful local engagement details.</p></div>' : '<button onclick="showDetails()"><h3>Coastal research</h3><p>Useful local engagement details.</p></button>';
    const panel = kind === "native-open" ? '<dialog open><h2>Engagement details</h2><p>Useful research, delivery and outcomes.</p><button onclick="document.getElementById(\'slot\').replaceChildren()">Close</button></dialog>' : '<section role="dialog" aria-modal="true" aria-label="Engagement details"><h2>Engagement details</h2><p>Useful research, delivery and outcomes.</p><button onclick="document.getElementById(\'slot\').replaceChildren()">Close</button></section>';
    const page = await fixture(`<main><h1>Work</h1>${opening}<div id="slot"></div></main><script>function showDetails(){document.getElementById('slot').innerHTML=${JSON.stringify(panel)}}</script>`);
    try { await probeDialogBehavior(page, page.locator("main")); expect(await page.getByRole("dialog").count()).toBe(0); } finally { await page.close(); }
  });
  it.each(["missing", "decorative", "empty", "broken-close"])("rejects %s dialogs rather than fabricating completeness", async kind => {
    const button = kind === "missing" ? "" : `<button onclick="${kind === "decorative" ? "document.getElementById('result').textContent='Selected'" : "document.querySelector('dialog').showModal()"}"><h3>Coastal research</h3><p>Useful local engagement details.</p></button>`;
    const page = await fixture(`<main><h1>Work</h1>${button}<p id="result"></p><dialog>${kind === "empty" ? "" : "<h2>Engagement details</h2><p>Useful local delivery outcomes.</p>"}<button onclick="${kind === "broken-close" ? "" : "document.querySelector('dialog').close()"}">Close details</button></dialog></main>`);
    try { await expect(probeDialogBehavior(page, page.locator("main"))).rejects.toThrow(); } finally { await page.close(); }
  });
});

describe("Pointer readiness after earlier controls", () => {
  it.each([false, true])("settles a finite transform transition while preserving obstruction rejection: covered=%s", async covered => {
    const page = await fixture(`<style>button{transition:transform .6s}#cover{position:fixed;inset:0;z-index:100;background:#fff9;pointer-events:none}body:has(textarea:not(:placeholder-shown)) #cover{pointer-events:auto}</style><main><h1>Contact</h1><form onsubmit="event.preventDefault();document.getElementById('feedback').textContent='Local demo only: nothing was sent'"><label>Email<input required type="email"></label><label>Message<textarea required placeholder="Describe your project" oninput="document.querySelector('button').style.transform='translateY(-5px)'"></textarea></label><button type="submit">Send inquiry</button><p id="feedback" role="status"></p></form></main>${covered ? '<div id="cover">Blocking overlay</div>' : ''}`, 390);
    try {
      const check = functionalBrowserChecks(functionalRequirements("Contact form"), ["/"])[1]!;
      const result = check.execute({ page, context: page.context(), route: "/", viewport: { id: "MOBILE", width: 390, height: 1000 },
        events: { pageErrors: [], consoleErrors: [], consoleWarnings: [], failedRequests: [], badResponses: [], blockedRequests: [], dialogs: [], popups: [], downloads: [] } });
      if (covered) { await expect(result).rejects.toThrow(/intercepts pointer events|Timeout/); expect(await page.getByRole("status").innerText()).toBe(""); }
      else expect((await result).status).toBe("PASS");
    } finally { await page.close(); }
  });
  it("submits a long mobile form beneath a sticky header after earlier pointer activity", async () => {
    const page = await fixture(`<style>*{box-sizing:border-box}body{margin:0;line-height:1.6}header{position:sticky;top:0;height:76px;z-index:10;background:white}main{padding:0 14px}.spacer{height:820px}form{display:grid;gap:20px}.row{display:grid;grid-template-columns:1fr;gap:18px}label{display:grid;gap:7px;font-weight:700;font-size:.9rem}input,select,textarea{font:inherit;padding:13px;border:1px solid;width:100%}button{display:inline-flex;border:0;padding:13px 20px;transition:transform .25s}button:hover{transform:translateY(-2px)}</style><header>Studio navigation</header><main><div class="spacer">Contact information</div><form onsubmit="event.preventDefault();document.getElementById('feedback').textContent='Local demo only: nothing was sent'"><div class="row"><label>Name<input required name="name"></label><label>Email<input required name="email" type="email"></label></div><div class="row"><label>Company<input required name="company"></label><label>Service<select required><option value="">Choose</option><option value="research">Research</option></select></label></div><label>Budget<select required><option value="">Choose</option><option value="small">Small</option></select></label><label>Message<textarea required name="message" rows="5" placeholder="Tell us more"></textarea></label><button type="submit">Send inquiry</button><p id="feedback" role="status"></p></form><div style="height:1000px">More information</div></main>`, 390);
    try {
      await page.evaluate(() => {
        const root = document.createElement("div"); root.id = "root";
        root.append(...document.body.childNodes); document.body.append(root);
        root.style.overflowX = "clip"; document.body.style.overflowX = "clip";
      });
      await page.setViewportSize({ width: 390, height: 844 }); await page.mouse.move(195, 649);
      const result = await functionalBrowserChecks(functionalRequirements("Contact form"), ["/"])[1]!.execute({ page, context: page.context(), route: "/", viewport: { id: "MOBILE", width: 390, height: 844 },
        events: { pageErrors: [], consoleErrors: [], consoleWarnings: [], failedRequests: [], badResponses: [], blockedRequests: [], dialogs: [], popups: [], downloads: [] } });
      expect(result.status).toBe("PASS");
    } finally { await page.close(); }
  });
  it("submits a valid demo form when the pointer starts on a moving hover boundary", async () => {
    const page = await fixture(`<style>button{position:fixed;top:400px;left:20px;height:44px;width:150px;transition:transform .25s}button:hover{transform:translateY(-2px)}</style><main><h1>Contact</h1><form onsubmit="event.preventDefault();document.getElementById('feedback').textContent='Local demo only: nothing was sent'"><label>Name<input required name="name"></label><label>Email<input required name="email" type="email"></label><label>Message<textarea required name="message"></textarea></label><button type="submit">Send inquiry</button><p id="feedback" role="status"></p></form></main>`, 390);
    try {
      await page.mouse.move(40, 443);
      const check = functionalBrowserChecks(functionalRequirements("Contact form"), ["/"])[1]!;
      const result = await check.execute({ page, context: page.context(), route: "/", viewport: { id: "MOBILE", width: 390, height: 1000 },
        events: { pageErrors: [], consoleErrors: [], consoleWarnings: [], failedRequests: [], badResponses: [], blockedRequests: [], dialogs: [], popups: [], downloads: [] } });
      expect(result.status).toBe("PASS");
    } finally { await page.close(); }
  });
});
