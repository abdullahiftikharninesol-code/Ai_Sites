import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { functionalRequirements, assertFunctionalBackendSupport, functionalGenerationContract } from "../src/sites/generation/functional-capabilities.js";
import { functionalPageSurface, meaningfulPageContent, probeTabs } from "../src/browser-qa/functional-surfaces.js";
import { probeCategoryFiltering, probeMobileNavigation } from "../src/browser-qa/functional-route-probes.js";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { BROWSER_QA_VIEWPORTS, createBrowserQACheckResult } from "../src/browser-qa/browser-qa-domain.js";
import { probeDialogBehavior } from "../src/browser-qa/dialog-behavior.js";

let browser: Browser;
const servers: Server[] = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
});
async function pageFor(html: string, width = 1440): Promise<Page> {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  servers.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto("http://127.0.0.1:" + address.port); return page;
}

describe("Prompt requirements without prefix truncation or Markdown-negation mistakes", () => {
  it.each([0, 1000])("extracts the same unique route-owned checklist after %i filler paragraphs", size => {
    const text = "Use restrained typography and generous whitespace.\n".repeat(size) +
      "## Website Pages\n### Home\nExpandable FAQ answers.\n### Services\nWorking tabs.\n### Our Work\nCategory filters and project modal.\n### Contact\nValidated contact form.\n## Shared\nMobile menu.\n- Do not include newsletter.\n- No shopping cart.\n";
    const requirements = functionalRequirements(text);
    expect(requirements.capabilities).toEqual(["category-filter", "mobile-nav", "tabs", "accordion", "dialog", "form"]);
    expect(requirements.requirements?.find(item => item.capability === "form")?.target.pageName).toBe("Contact");
    expect(new Set(requirements.requirements?.map(item => item.id)).size).toBe(requirements.requirements?.length);
    expect(functionalGenerationContract(requirements)).toContain("SiteLink");
    expect(functionalGenerationContract(requirements)).not.toContain("useCart()");
  });
  it("rejects explicit contradictory functionality before a provider call", () => {
    expect(() => assertFunctionalBackendSupport(functionalRequirements("Add a shopping cart. Do not include a shopping cart."))).toThrow(/Conflicting/);
  });
  it("does not infer interactions from ordinary design language", () => {
    expect(functionalRequirements("Use large font sizes and a quiet editorial layout.").capabilities).toEqual([]);
  });
  it("distinguishes feature protection and forbidden fake behavior from feature exclusion", () => {
    for (const text of ["Add a shopping cart. Do not remove the shopping cart.", "Add a contact form. No alert-only handlers for a contact form."]) {
      const requirements = functionalRequirements(text);
      expect(requirements.conflictingCapabilities).toBeUndefined();
      expect(() => assertFunctionalBackendSupport(requirements)).not.toThrow();
    }
  });
});

describe("Behavioral equivalence for the retained live markup pattern", () => {
  it.each([1440, 768, 390])("pins the Menu-to-Close toggle across React-style replacement at width %i", async width => {
    const page = await pageFor(`<html><body><div id="slot"></div><script>let menuOpen=false;function renderMenu(){document.getElementById('slot').innerHTML='<button aria-expanded="'+menuOpen+'" aria-controls="mobile-navigation" onclick="menuOpen=!menuOpen;renderMenu()">'+(menuOpen?'Close':'Menu')+'</button>'+(menuOpen?'<nav id="mobile-navigation"><a href="/services">Services</a><a href="/work">Work</a></nav>':'')}renderMenu()</script></body></html>`, width);
    try { await probeMobileNavigation(page); expect(await page.getByRole("button").innerText()).toBe("Menu"); } finally { await page.close(); }
  });
  it.each([false, true])("supports changing menu labels with initially expanded=%s and no button ID", async expanded => {
    const page = await pageFor(`<html><body><button aria-controls="mobile-navigation" aria-expanded="${expanded}" onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!open));this.textContent=open?'Menu':'Close';document.getElementById('mobile-navigation').hidden=open">${expanded ? "Close" : "Menu"}</button><nav id="mobile-navigation" ${expanded ? "" : "hidden"}><a href="/services">Services</a></nav></body></html>`);
    try { await probeMobileNavigation(page); expect(await page.locator("nav").isVisible()).toBe(false); } finally { await page.close(); }
  });
  it("pins a renamed menu toggle without aria-controls and rejects a nonclosing renamed toggle", async () => {
    const page = await pageFor(`<html><body><button aria-expanded="false" onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!open));this.textContent=open?'Menu':'Close';document.querySelector('nav').hidden=open">Menu</button><nav hidden><a href="/services">Services</a></nav></body></html>`);
    try {
      await probeMobileNavigation(page);
      await page.getByRole("button").evaluate(button => button.setAttribute("onclick", "this.setAttribute('aria-expanded','true');this.textContent='Close';document.querySelector('nav').hidden=false"));
      await expect(probeMobileNavigation(page)).rejects.toThrow(/does not close/);
    } finally { await page.close(); }
  });
  it.each([1440, 768, 390])("verifies both native modal close controls at width %i", async width => {
    const page = await pageFor(`<html><body><button onclick="document.querySelector('dialog').showModal()">Read project detail</button><dialog><h2>Project detail</h2><p>A meaningful delivery story and measurable outcome.</p><button aria-label="Close project details" onclick="document.querySelector('dialog').close()">X</button><button onclick="document.querySelector('dialog').close()">Close details</button></dialog></body></html>`, width);
    try { await probeDialogBehavior(page, page); expect(await page.getByRole("dialog").count()).toBe(0); } finally { await page.close(); }
  });
  it.each(["valid", "duplicate-labels", "prefixed-labels", "renamed-trigger", "broken-x", "broken-footer", "empty"])("verifies conditional custom dialog with two dismissal controls: %s", async kind => {
    const markup = '<section role="dialog">' + (kind === "empty" ? "" : "<h2>Project detail</h2><p>A meaningful case study and its results.</p>") +
      '<button aria-label="' + (kind === "duplicate-labels" ? "Close" : kind === "prefixed-labels" ? "Click to close project" : "Close project details") + '">X</button><button>' + (kind === "duplicate-labels" ? "Close" : kind === "prefixed-labels" ? "Please dismiss" : "Close details") + '</button></section>';
    const page = await pageFor(`<html><body><button onclick="openProject()">Read project detail</button><div id="slot"></div><script>function openProject(){${kind === "renamed-trigger" ? "document.querySelector('button').textContent='View again';" : ""}const slot=document.getElementById('slot');slot.innerHTML=${JSON.stringify(markup)};const buttons=slot.querySelectorAll('button');buttons[0].onclick=()=>{${kind === "broken-x" ? "" : "slot.replaceChildren()"}};buttons[1].onclick=()=>{${kind === "broken-footer" ? "" : "slot.replaceChildren()"}};}</script></body></html>`);
    try {
      const probe = probeDialogBehavior(page, page);
      if (["valid", "duplicate-labels", "prefixed-labels", "renamed-trigger"].includes(kind)) await probe; else await expect(probe).rejects.toThrow();
    } finally { await page.close(); }
  });
  it("blocks an uncaught exception thrown after startup by an interaction probe", async () => {
    const page = await pageFor('<html><body><h1>Studio</h1><button onclick="throw new Error(\'Broken generated control\')">Open project</button></body></html>');
    try {
      const report = await new BrowserQARunner().run({ runId: "late-runtime-error", target: { baseUrl: page.url() },
        viewports: [BROWSER_QA_VIEWPORTS[0]!], policy: { captureScreenshots: false }, checks: [
          ...browserQACoreCheckExecutors.filter(check => check.definition.checkId === "runtime.page-error"),
          { definition: { checkId: "fixture.click", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "INTERACTION", timeoutMs: 2000 },
            execute: async context => {
              await context.page.getByRole("button").click();
              await context.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
              return createBrowserQACheckResult({ checkId: "fixture.click", category: "INTERACTION", severity: "ERROR", status: "PASS", route: context.route, viewport: context.viewport, message: "Click dispatched" });
            } },
        ] });
      expect(report.status).toBe("FAIL");
      expect(report.checks.find(check => check.checkId === "runtime.page-error")).toMatchObject({ status: "FAIL", severity: "ERROR" });
    } finally { await page.close(); }
  });
  it("waits for React-style content even when CSS makes the empty body/root visible", async () => {
    const page = await pageFor('<html><head><style>body,#root{min-height:100vh}</style></head><body><div id="root"></div><script>setTimeout(()=>document.getElementById("root").innerHTML="<h1>Studio</h1><p>Meaningful content after hydration.</p>",150)</script></body></html>');
    try { await meaningfulPageContent(page, "Home"); } finally { await page.close(); }
  });
  it.each([1440, 768, 390])("accepts actual content, filters, custom tab panels and div menus at width %i", async width => {
    const page = await pageFor(`<!doctype html><html><body><div id="root"><header><a href="/">Studio</a><button aria-label="Open navigation" aria-expanded="false" onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!open));document.getElementById('mobile').hidden=open">Menu</button><div id="mobile" hidden><a href="/services">Services</a><a href="/work">Our work</a></div></header><h1>Our Work</h1><p>Meaningful portfolio and service content.</p><section><div role="tablist"><button role="tab" aria-selected="true" onclick="tab(this,0)">Strategy</button><button role="tab" aria-selected="false" onclick="tab(this,1)">Design</button></div><div id="panel"><h2>Research and discovery</h2><p>Understand the real business challenge before delivery.</p></div></section><section><div><button aria-pressed="true" onclick="filter(this,'All')">All</button><button aria-pressed="false" onclick="filter(this,'AI')">AI</button><button aria-pressed="false" onclick="filter(this,'Web')">Web</button></div><div><button><h3>Health assistant</h3><p>AI project</p></button><button><h3>Commerce workspace</h3><p>Web project</p></button></div></section></div><script>function tab(button,index){button.parentElement.querySelectorAll('button').forEach(item=>item.setAttribute('aria-selected',String(item===button)));document.getElementById('panel').innerHTML=index?'<h2>Accessible product design</h2><p>Build thoughtful digital interfaces with realistic interactive prototypes.</p>':'<h2>Research and discovery</h2><p>Understand the real business challenge before delivery.</p>'}function filter(button,value){button.parentElement.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));const cards=button.parentElement.nextElementSibling.children;cards[0].hidden=value==='Web';cards[1].hidden=value==='AI'}</script></body></html>`, width);
    try {
      await meaningfulPageContent(page, "Our Work");
      await probeCategoryFiltering(page);
      await probeTabs(page, await functionalPageSurface(page));
      await probeMobileNavigation(page);
    } finally { await page.close(); }
  });
  it.each(["missing", "decorative", "wrong-panel", "never-restore"])("rejects %s tabs", async kind => {
    const page = await pageFor(`<html><body><main><h1>Services</h1><section><div role="tablist">${kind === "missing" ? "" : `<button role="tab" aria-selected="true" onclick="choose(this,0)">Strategy</button><button role="tab" aria-selected="false" ${kind === "wrong-panel" ? 'aria-controls="invented"' : ""} onclick="choose(this,1)">Design</button>`}</div><div id="content">A meaningful strategy and discovery workshop.</div></section></main><script>function choose(button,index){button.parentElement.querySelectorAll('button').forEach(item=>item.setAttribute('aria-selected',String(item===button)));${kind === "decorative" ? "" : "document.getElementById('content').textContent=" + (kind === "never-restore" ? "'Accessible digital design with working prototypes.'" : "index?'Accessible digital design with working prototypes.':'A meaningful strategy and discovery workshop.'")}}</script></body></html>`);
    try { await expect(probeTabs(page, page.locator("main"))).rejects.toThrow(); } finally { await page.close(); }
  });
  it.each([false, true])("requires meaningful local panel changes from custom button tabs (decorative=%s)", async decorative => {
    const page = await pageFor(`<html><body><main><h1>Services</h1><section><div class="tabs"><button class="active" onclick="choose(this,0)">Strategy</button><button onclick="choose(this,1)">Design</button></div><div id="panel">Practical strategy and clear delivery planning.</div></section><p id="counter">Unrelated notifications: 0</p></main><script>let counter=0;function choose(button,index){button.parentElement.querySelectorAll('button').forEach(item=>item.className=item===button?'active':'');document.getElementById('counter').textContent='Unrelated notifications: '+(++counter);${decorative ? "" : "document.getElementById('panel').textContent=index?'Accessible digital design and interactive prototypes.':'Practical strategy and clear delivery planning.'"}}</script></body></html>`);
    try {
      const probe = probeTabs(page, page.locator("main"));
      if (decorative) await expect(probe).rejects.toThrow(/meaningful content/); else await probe;
    } finally { await page.close(); }
  });
  it.each(["decorative", "wrong-panel", "never-close"])("rejects %s mobile menus", async kind => {
    const page = await pageFor(`<html><body><button aria-label="Menu" aria-expanded="false" ${kind === "wrong-panel" ? 'aria-controls="invented"' : ""} onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(${kind === "never-close" ? "true" : "!open"}));${kind === "decorative" ? "" : "document.getElementById('links').hidden=" + (kind === "never-close" ? "false" : "open")}">Menu</button><div id="links" hidden><a href="/services">Services</a></div></body></html>`);
    try { await expect(probeMobileNavigation(page)).rejects.toThrow(); } finally { await page.close(); }
  });
  it("does not accept header/footer boilerplate or hidden text as implemented page content", async () => {
    const page = await pageFor('<html><body><div id="root"><header><a href="/services">Services content</a></header><h1>Home</h1><p hidden>A hidden answer cannot make this complete.</p><footer>Agency information</footer></div></body></html>');
    try { await expect(meaningfulPageContent(page, "Home")).rejects.toThrow(/empty content/); } finally { await page.close(); }
  });
});
