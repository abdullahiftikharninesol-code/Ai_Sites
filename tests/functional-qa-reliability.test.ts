import { createServer, type Server } from "node:http";
import { CRC32C, type Storage } from "@google-cloud/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserQARunner, type BrowserQACheckExecutor } from "../src/browser-qa/browser-qa-runner.js";
import { BROWSER_QA_VIEWPORTS, createBrowserQACheckResult } from "../src/browser-qa/browser-qa-domain.js";
import { functionalBrowserChecks } from "../src/browser-qa/functional-capability-checks.js";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import { recoverFunctionalSemantics } from "../src/sites/generation/functional-semantics.js";
import { analyzeRequestProfile } from "../src/sites/generation/request-profile.js";
import { GoogleCloudTemplateArtifactStorage } from "../src/templates/publishing/google-cloud-template-artifact-storage.js";
import { buildCapabilityAwareGenerationContext } from "../src/cli/runtime/capability-aware-generation-context.js";
import { SITE_V1_TECHNICAL_PROFILE } from "../src/cli/runtime/site-technical-profile.js";

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(done => {server.closeAllConnections();server.close(()=>done());}))); });
async function fixture(script = "", brokenClose = false) {
  const html = `<!doctype html><html><body><button aria-label="Open cart, 0 items" id="cart" onclick="openCart()">Bag 0</button>
  <button aria-label="Open navigation" aria-expanded="false" aria-controls="navigation" onclick="this.setAttribute('aria-expanded',String(navigation.hidden));navigation.hidden=!navigation.hidden">Menu</button><nav id="navigation" hidden><a href="/">Home</a></nav>
  <main><h1>Field Jacket</h1><div class="filters" role="group" aria-label="Categories"><button aria-pressed="true" onclick="filter('All')">All</button><button aria-pressed="false" onclick="filter('Women')">Women</button><button aria-pressed="false" onclick="filter('Men')">Men</button></div>
  <input aria-label="Search products" oninput="renderProducts()" id="search"><div id="products"></div>
  <div><button aria-pressed="true" onclick="chooseSize(this)">S</button><button aria-pressed="false" onclick="chooseSize(this)">M</button></div>
  <div><button aria-label="Decrease quantity" id="decrease" disabled onclick="change(-1)">−</button><span id="quantity">1</span><button aria-label="Increase quantity" onclick="change(1)">+</button></div><button onclick="count+=q;cart.innerText='Bag '+count;cart.setAttribute('aria-label','Open cart, '+count+' items');openCart()">Add to bag</button>
  <form onsubmit="event.preventDefault();feedback.innerText='Demo signup only; no subscription was sent'"><input type="email" required aria-label="Newsletter email"><button type="submit">Subscribe</button><p role="status" id="feedback"></p></form>
  <div class="gallery-main"><img data-sites-gallery-active src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E" alt="View 1"></div><button aria-label="View image 1" aria-pressed="true" onclick="gallery.alt='View 1'">Image 1</button><button aria-label="View image 2" onclick="gallery.alt='View 2'">Image 2</button></main>
  <script>let count=0,q=1,category='All';const cart=document.getElementById('cart'),navigation=document.getElementById('navigation'),search=document.getElementById('search'),quantity=document.getElementById('quantity'),feedback=document.getElementById('feedback'),gallery=document.querySelector('[data-sites-gallery-active]');
  function renderProducts(){document.getElementById('products').innerHTML=[['Field Jacket','Men'],['Linen Shirt','Women']].filter(p=>(category==='All'||p[1]===category)&&p[0].toLowerCase().includes(search.value.toLowerCase())).map(p=>'<article>'+p[0]+'</article>').join('')}
  function filter(c){category=c;document.querySelectorAll('.filters button').forEach(b=>b.setAttribute('aria-pressed',String(b.innerText===c)));renderProducts()}
  function chooseSize(b){b.parentElement.querySelectorAll('button').forEach(e=>e.setAttribute('aria-pressed',String(e===b)))}
  function change(n){q=Math.max(1,q+n);quantity.innerText=String(q);document.getElementById('decrease').disabled=q<=1}
  function openCart(){if(document.getElementById('drawer'))return;const d=document.createElement('div');d.id='drawer';d.setAttribute('role','dialog');d.setAttribute('aria-label','Shopping bag');d.style='position:fixed;inset:0;background:white;z-index:50';d.innerHTML='<button aria-label="Close cart" onclick="${brokenClose ? 'void 0' : "this.parentElement.remove()"}">Close</button><h2>Field Jacket</h2><div><button aria-label="Decrease quantity">−</button> '+count+' <button aria-label="Increase quantity">+</button></div>';document.body.append(d)}
  renderProducts();${script}</script></body></html>`;
  const server=createServer((_request,response)=>{response.writeHead(200,{"content-type":"text/html"});response.end(html);});servers.push(server);
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();if(!address||typeof address==="string")throw new Error("No local fixture port");
  return `http://127.0.0.1:${address.port}`;
}
const capabilities = ["cart","size","quantity","category-filter","search","mobile-nav","newsletter"] as const;
const checks = () => functionalBrowserChecks({version:1,capabilities,backendRequired:false,unsupportedTransactions:false},["/","/product"]);

async function noticeFixture(markup: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body><main><h1>Offline notice fixture</h1>${markup}</main></body></html>`);
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local fixture port");
  return `http://127.0.0.1:${address.port}`;
}
const controlCheck = functionalBrowserChecks({ version: 1, capabilities: [], backendRequired: false, unsupportedTransactions: false }, ["/"])[0]!;
async function noticeReport(markup: string, viewport = BROWSER_QA_VIEWPORTS[0]!) {
  return new BrowserQARunner().run({ runId: "dismiss-regression", target: { baseUrl: await noticeFixture(markup) }, viewports: [viewport], checks: [controlCheck], policy: { captureScreenshots: false } });
}

describe("Observable visibility and meaningful dismissals", () => {
  it.each([false,true])("keeps independent resets and all twelve control positions after batching metadata, brokenLast=%s",async brokenLast=>{
    const buttons=Array.from({length:10},(_,index)=>`<button onclick="if(!window.alreadyTested){window.alreadyTested=true;${brokenLast&&index===9?'':`document.getElementById('result').textContent='Action ${index}'`}}">Action ${index}</button>`).join('');
    const report=await noticeReport('<button aria-pressed="true">Selected</button><button disabled>Disabled</button>'+buttons+'<p id="result">Initial state</p>');
    expect(controlCheck.definition.timeoutMs).toBe(8000);
    const check=report.checks.find(check=>check.checkId==='functional.controls');
    expect(check).toMatchObject({status:brokenLast?'FAIL':'PASS',severity:'ERROR'});
    if(brokenLast)expect(check?.message).toContain('Button has no observable action: Action 9');
  });
  it.each(["Build a simple landing page", "Clothing store with Add to Cart and size selection"])("supplies whole-region dismissal guidance without adding unrelated capabilities: %s", requestText => {
    const context = buildCapabilityAwareGenerationContext({ profile: SITE_V1_TECHNICAL_PROFILE, requestText });
    expect(context).toContain("Dismiss/close controls must hide or remove the associated content");
    expect(context).toContain("data-sites-dismissible");
    if (requestText.includes("simple")) expect(context).not.toContain("CartPanel");
  });
  it.each(["this.hidden=true", "this.remove()"])("observes an icon-only control disappearing: %s", async handler => {
    const report = await noticeReport(`<button aria-label="Remove marker" onclick="${handler}"><svg width="14" height="14"></svg></button>`);
    expect(report.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "PASS" });
  });
  it.each(BROWSER_QA_VIEWPORTS)("accepts dismissing the whole suggestion on $id", async viewport => {
    const report = await noticeReport('<div class="ai-note"><p>A useful suggestion</p><button aria-label="Dismiss suggestion" onclick="this.parentElement.remove()"><svg width="14" height="14"></svg></button></div>', viewport);
    expect(report.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "PASS" });
  });
  it.each(BROWSER_QA_VIEWPORTS)("rejects hiding only the dismiss icon on $id", async viewport => {
    const report = await noticeReport('<div class="ai-note"><p>A useful suggestion</p><button aria-label="Dismiss suggestion" onclick="this.hidden=true"><svg width="14" height="14"></svg></button></div>', viewport);
    const failure = report.checks.find(check => check.checkId === "functional.controls");
    expect(failure).toMatchObject({ status: "FAIL", severity: "ERROR" });
    expect(failure?.message).toContain("leaves its content visible");
  });
  it("honors aria-controls for a custom notice and rejects hidden overridden by CSS", async () => {
    const good = await noticeReport('<div id="custom"><p>Custom notification</p></div><button aria-label="Dismiss notification" aria-controls="custom" onclick="document.getElementById(\'custom\').remove();this.remove()">Dismiss</button>');
    expect(good.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "PASS" });
    const broken = await noticeReport('<style>.notice{display:flex}</style><div class="notice"><p>Still visible</p><button aria-label="Dismiss notice" onclick="this.parentElement.hidden=true;this.hidden=true"><svg width="14" height="14"></svg></button></div>');
    expect(broken.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "FAIL", severity: "ERROR" });
  });
  it.each(["void 0", "this.dataset.clicked='true'", "this.classList.add('clicked')"])("still rejects no-op/decorative-only callbacks: %s", async handler => {
    const report = await noticeReport(`<button aria-label="Perform action" onclick="${handler}"><svg width="14" height="14"></svg></button>`);
    const failure = report.checks.find(check => check.checkId === "functional.controls");
    expect(failure).toMatchObject({ status: "FAIL", severity: "ERROR" });
    expect(failure?.message).toContain("no observable action");
  });
  it("observes actual task completion and accessible checked state", async () => {
    const task = await noticeReport('<style>.task-done{text-decoration:line-through}</style><button onclick="this.querySelector(\'span\').classList.toggle(\'task-done\')"><span>Review launch brief</span></button>');
    expect(task.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "PASS" });
    const checked = await noticeReport('<button aria-checked="false" onclick="this.setAttribute(\'aria-checked\',\'true\')">Complete task</button>');
    expect(checked.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "PASS" });
  });
  it.each(["hover", "focus"])("does not count %s-only task decoration as a click action", async pseudo => {
    const report = await noticeReport(`<style>button:${pseudo} span{text-decoration:line-through}</style><button onclick="void 0"><span>Review launch brief</span></button>`);
    expect(report.checks.find(check => check.checkId === "functional.controls")).toMatchObject({ status: "FAIL", severity: "ERROR" });
  });
});

describe("Real-browser cart-overlay and semantic-control regressions",()=>{
  it.each(BROWSER_QA_VIEWPORTS)("accepts button filters, text search, size buttons and auto-open cart on $id",async viewport=>{
    const report=await new BrowserQARunner().run({runId:"custom-controls",target:{baseUrl:await fixture()},routes:["/","/product"],viewports:[viewport],checks:[...checks(),...browserQACoreCheckExecutors.filter(check=>check.definition.checkId==="runtime.page-error")],policy:{captureScreenshots:false}});
    expect(report.checks.filter(check=>check.status==="FAIL")).toEqual([]);
    expect(report.status).toBe("PASS");
  },30_000);
  it("does not accept a broken Close control by hiding the overlay or force-clicking through it",async()=>{
    const report=await new BrowserQARunner().run({runId:"broken-close",target:{baseUrl:await fixture("",true)},viewports:[BROWSER_QA_VIEWPORTS[0]!],checks:[checks()[0]!],policy:{captureScreenshots:false}});
    const failure=report.checks.find(check=>check.checkId==="functional.controls");
    expect(failure).toMatchObject({status:"FAIL",severity:"ERROR"});expect(failure?.message).toContain("Close control does not close");
  });
  it.each(["filter","gallery"])("still rejects a %s control that only changes decorative state",async kind=>{
    const script=kind==="filter"?"filter=c=>{document.querySelectorAll('.filters button').forEach(b=>b.setAttribute('aria-pressed',String(b.innerText===c)))}":"document.querySelector('[aria-label=\"View image 2\"]').onclick=()=>{}";
    const requirements={version:1 as const,capabilities:[kind==="filter"?"category-filter" as const:"gallery" as const],backendRequired:false,unsupportedTransactions:false};
    const report=await new BrowserQARunner().run({runId:"decorative",target:{baseUrl:await fixture(script)},routes:[kind==="filter"?"/":"/product"],viewports:[BROWSER_QA_VIEWPORTS[0]!],checks:[functionalBrowserChecks(requirements,["/","/product"])[1]!],policy:{captureScreenshots:false}});
    expect(report.checks.find(check=>check.checkId==="functional.requirements")).toMatchObject({status:"FAIL",severity:"ERROR"});
  });
  it("isolates failed probes and preserves errors emitted by their actions",async()=>{
    const make=(id:string,execute:BrowserQACheckExecutor["execute"],timeoutMs=1000):BrowserQACheckExecutor=>({definition:{checkId:id,version:1,category:"INTERACTION",scope:"INTERACTION",defaultSeverity:"ERROR",timeoutMs},execute});
    const first=make("late-error",async context=>{await context.page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='contamination';document.body.append(overlay);setTimeout(()=>{throw new Error('interaction error retained')},0)});await context.page.waitForTimeout(40);throw new Error("Intentional failed probe");});
    const next=make("clean-state",async context=>{expect(await context.page.locator('#contamination').count()).toBe(0);return createBrowserQACheckResult({checkId:"clean-state",category:"INTERACTION",severity:"ERROR",status:"PASS",message:"Independent clean page"});});
    const report=await new BrowserQARunner().run({runId:"isolated-probes",target:{baseUrl:await fixture()},viewports:[BROWSER_QA_VIEWPORTS[0]!],checks:[first,next,...browserQACoreCheckExecutors.filter(check=>check.definition.checkId==="runtime.page-error")],policy:{captureScreenshots:false}});
    expect(report.checks.find(check=>check.checkId==="clean-state")?.status).toBe("PASS");
    expect(report.checks.find(check=>check.checkId==="runtime.page-error")?.status).toBe("FAIL");
  });
  it("does not attempt a desktop-hidden mobile toggle before a visible expandable control",async()=>{
    const script="const hidden=document.createElement('button');hidden.style.display='none';hidden.setAttribute('aria-expanded','false');hidden.setAttribute('aria-controls','navigation');document.body.prepend(hidden)";
    const report=await new BrowserQARunner().run({runId:"hidden-toggle",target:{baseUrl:await fixture(script)},viewports:[BROWSER_QA_VIEWPORTS[0]!],checks:browserQAResponsiveAndInteractionChecks.filter(check=>check.definition.checkId==="interaction-smoke"),policy:{captureScreenshots:false}});
    expect(report.checks.find(check=>check.checkId==="interaction-smoke")?.status).toBe("PASS");
  });
});

describe("Verified React semantics without invented behavior",()=>{
  const source=`import {useState} from 'react';export function App(){const [size,setSize]=useState('M');const [open,setOpen]=useState(false);return <><button aria-label="Open navigation" onClick={()=>setOpen(!open)}>Menu</button><nav className={\`nav \${open?'nav-open':''}\`}>Home</nav><input aria-label="Search products"/>{['S','M'].map(s=><button key={s} className={size===s?'size selected':'size'} onClick={()=>setSize(s)}>{s}</button>)}</>}`;
  it("adds selected/navigation/search semantics from existing state and is idempotent",()=>{
    const result=recoverFunctionalSemantics({files:[{path:"src/App.tsx",content:source}]});const content=result.bundle.files[0]!.content;
    expect(content).toContain('aria-pressed={size===s}');expect(content).toContain('aria-expanded={open}');expect(content).toContain('aria-controls="sites-nav-');expect(content).toContain('type="search"');
    expect(recoverFunctionalSemantics(result.bundle).fixes).toEqual([]);
    expect(analyzeRequestProfile("Product-detail experience with gallery placeholders, sizes and quantity").functional.capabilities).toContain("gallery");
  });
  it("refuses shadowed state, unrelated click handlers and a constant nav class",()=>{
    for(const content of [source.replace('function App()','function App({size})'),source.replace('setSize(s)','console.log(s)')])
      expect(recoverFunctionalSemantics({files:[{path:"src/App.tsx",content}]}).bundle.files[0]!.content).not.toContain('aria-pressed=');
    const content=source.replace("`nav ${open?'nav-open':''}`","'nav nav-open'");
    expect(recoverFunctionalSemantics({files:[{path:"src/App.tsx",content}]}).bundle.files[0]!.content).not.toContain('aria-expanded=');
  });
  it("disables only a proven quantity lower-bound action, without replacing its handler",()=>{
    const content=`import {useState} from 'react';function App(){const [quantity,setQuantity]=useState(1);return <button onClick={()=>setQuantity(Math.max(1,quantity-1))}>Less</button>}`;
    const result=recoverFunctionalSemantics({files:[{path:"src/App.tsx",content}]}).bundle.files[0]!.content;
    expect(result).toContain('disabled={quantity <= 1}');expect(result).toContain('onClick={()=>setQuantity(Math.max(1,quantity-1))}');
  });
  it("moves exclusive boolean dismissal from the X button to its explicit notice, idempotently", () => {
    const content = `import {useState} from 'react';export function App(){const [showSuggestion,setShowSuggestion]=useState(true);return <main><div className="ai-note"><div><b>A suggestion</b><p>Group these tasks?</p></div><button aria-label="Dismiss suggestion" onClick={()=>setShowSuggestion(false)} hidden={!showSuggestion}><svg/></button></div></main>}`;
    const result = recoverFunctionalSemantics({ files: [{ path: "src/App.tsx", content }] });
    expect(result.fixes).toContain("VERIFIED_DISMISSIBLE_REGION");
    expect(result.bundle.files[0]!.content).toContain('{showSuggestion && (<div data-sites-dismissible className="ai-note">');
    expect(result.bundle.files[0]!.content).toContain('onClick={()=>setShowSuggestion(false)}');
    expect(result.bundle.files[0]!.content).not.toContain('hidden={!showSuggestion}');
    expect(recoverFunctionalSemantics(result.bundle).fixes).toEqual([]);
    for (const ambiguous of [
      content.replace('className="ai-note"', 'className="layout"'),
      content.replace('className="ai-note"', 'className="ai-note" {...props}'),
      content.replace('<div><b>', '<button onClick={other}>Other</button><div><b>'),
      content.replace('return <main>', 'console.log(showSuggestion);return <main>'),
      content.replace('function App()', 'function App({showSuggestion})'),
      content.replace('setShowSuggestion(false)', 'unknownAction()'),
      content.replace('useState(true)', 'useState(initialValue)'),
      content.replace('<main>', '<>').replace('</main>', '</>'),
    ]) {
      // A fragment is also a safe JSX parent, unlike ambiguous cases above.
      const recovered = recoverFunctionalSemantics({ files: [{ path: "src/App.tsx", content: ambiguous }] });
      if (ambiguous.includes('return <>')) expect(recovered.fixes).toContain("VERIFIED_DISMISSIBLE_REGION");
      else expect(recovered.fixes).not.toContain("VERIFIED_DISMISSIBLE_REGION");
    }
  });
  it("resolves component-local state even when an unrelated component has the same parameter name",()=>{
    const content=source+"\nfunction Other({size}){return <p>{size}</p>}";
    expect(recoverFunctionalSemantics({files:[{path:"src/App.tsx",content}]}).bundle.files[0]!.content).toContain('aria-pressed={size===s}');
    const typed=source.replace('function App()','function App({add}:{add:(size:string)=>void})');
    expect(recoverFunctionalSemantics({files:[{path:"src/App.tsx",content:typed}]}).bundle.files[0]!.content).toContain('aria-pressed={size===s}');
  });
  it("repairs only explicitly requested, proven repeated-image placeholder galleries",()=>{
    const content=`import {useState} from 'react';const image='/photo.svg';export function App(){const [selected,setSelected]=useState(0);return <div className="gallery"><div>{[0,1,2].map(n=><button key={n} className={selected===n?'selected':''} onClick={()=>setSelected(n)}><img src={image} alt={'View '+(n+1)}/></button>)}</div><div className="large-image"><img src={image} alt="Product"/></div></div>}`;
    const bundle={files:[{path:"src/App.tsx",content}]};
    const result=recoverFunctionalSemantics(bundle,"Product gallery placeholders");
    expect(result.fixes).toContain("VERIFIED_PLACEHOLDER_GALLERY");expect(result.bundle.files[0]!.content).toContain('data-sites-gallery-active');
    expect(result.bundle.files[0]!.content).toContain('data:image/svg+xml,');expect(result.bundle.files[0]!.content).toContain('onClick={()=>setSelected(n)}');
    expect(recoverFunctionalSemantics(result.bundle,"Product gallery placeholders").fixes).toEqual([]);
    for(const request of ["Real product gallery photos","No gallery placeholders","Working gallery","Use real photos and gallery placeholders"])
      expect(recoverFunctionalSemantics(bundle,request).fixes).not.toContain("VERIFIED_PLACEHOLDER_GALLERY");
    for(const source of [content.replace('[0,1,2].map','images.map'),content.replace('src={image} alt="Product"','src={images[selected]} alt="Product"'),content.replace('useState(0)','useState(initialIndex)')])
      expect(recoverFunctionalSemantics({files:[{path:"src/App.tsx",content:source}]},"Gallery placeholders").fixes).not.toContain("VERIFIED_PLACEHOLDER_GALLERY");
  });
});

describe("Binary authenticated GCS reads avoid the leaking stream transport",()=>{
  function client(bytes:Uint8Array,valid=true){const checksum=new CRC32C();checksum.update(Buffer.from(bytes));const request=vi.fn(async()=>({data:bytes,headers:new Headers({"x-goog-hash":`crc32c=${valid?checksum.toString():"wrong"}`})}));const download=vi.fn();return {request,download,storage:{apiEndpoint:"https://storage.googleapis.com",authClient:{request},bucket:()=>({file:()=>({download})})} as unknown as Storage};}
  it("keeps binary ZIP bytes exact, ADC, encoded object identity and CRC validation without download()",async()=>{
    const bytes=new Uint8Array([80,75,0,128,255,13]);const h=client(bytes);const storage=new GoogleCloudTemplateArtifactStorage("bucket",h.storage);
    expect(await storage.readObject("folder/a b.zip")).toEqual(bytes);expect(h.download).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({url:"https://storage.googleapis.com/storage/v1/b/bucket/o/folder%2Fa%20b.zip?alt=media",responseType:"arraybuffer"}));
  });
  it("rejects corruption and preserves not-found and auth failures",async()=>{
    const h=client(new Uint8Array([1]),false),storage=new GoogleCloudTemplateArtifactStorage("bucket",h.storage);
    await expect(storage.readObject("test")).rejects.toMatchObject({code:"CONTENT_DOWNLOAD_MISMATCH"});
    h.request.mockRejectedValueOnce({response:{status:404}});expect(await storage.readObject("missing")).toBeUndefined();
    h.request.mockRejectedValueOnce({response:{status:403}});await expect(storage.readObject("forbidden")).rejects.toMatchObject({response:{status:403}});
  });
});
