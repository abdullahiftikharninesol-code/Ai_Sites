import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { functionalFixtures, ecommercePrompt, corporatePrompt, portfolioPrompt, reportedAlertSearch } from "./fixtures/functional-generation-sites.js";
import { analyzeRequestProfile } from "../src/sites/generation/request-profile.js";
import { functionalGenerationContract, assertFunctionalBackendSupport, validateFunctionalBackendBundle } from "../src/sites/generation/functional-capabilities.js";
import { recoverFunctionalPlaceholders } from "../src/sites/generation/functional-recovery.js";
import { FUNCTIONAL_RUNTIME_PATH, functionalCartStorageKey } from "../src/sites/generation/functional-runtime.js";
import { validateReferenceInteractions } from "../src/cli/runtime/reference-interaction-validator.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import type { BuildRepairPatchBundle, SiteCoderFileBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { LocalCliAgentRuntime } from "../src/cli/runtime/local-cli-agent-runtime.js";
import type { SiteTemplate } from "../src/templates/domain/site-template.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { UserId, SiteId } from "../src/shared/types.js";
import { CatalogTemplateDesignReferenceResolver, templateDesignPrompt } from "../src/templates/application/template-design-context.js";
import { loadTemplateManifest } from "../src/templates/publishing/template-manifest.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { LocalFailedCandidateEvidence, FAILED_CANDIDATE_LIMITS } from "../src/sites/generation/failed-candidate-evidence.js";
import { estimateTokensConservative } from "../src/agents/budget/token-estimator.js";
import { DeterministicRequirementsPlanner } from "../src/planning/planning.js";

const parent = resolve(".sites-runtime/functional-tests"), roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep)) throw new Error("Unsafe functional test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function temp() { await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "case-")); roots.push(root); return root; }
const single = (content: string): SiteCoderFileBundle => ({ files: [{ path:"src/App.tsx",content }] });

describe("Deterministic functional requirement contract", () => {
  it("extracts only explicit interactions without changing planner routing", () => {
    const plain=analyzeRequestProfile("Build a quiet editorial landing page");
    expect(plain.functional.capabilities).toEqual([]); expect(plain.needsAgentPlanning).toBe(false);
    expect(functionalGenerationContract(plain.functional)).toBe("");
    const ecommerce=analyzeRequestProfile(ecommercePrompt);
    expect(ecommerce.functional.capabilities).toEqual(["cart","quantity","size","gallery","category-filter","product-navigation","search","newsletter"]);
    expect(ecommerce.needsAgentPlanning).toBe(false);
    expect(analyzeRequestProfile("No newsletter. Without search. Build tabs and accordion.").functional.capabilities).toEqual(["tabs","accordion"]);
    expect(analyzeRequestProfile("Create an authenticated admin dashboard").needsAgentPlanning).toBe(true);
    expect(analyzeRequestProfile("Build without search. Use generous font sizes.").functional.capabilities).toEqual([]);
    expect(functionalCartStorageKey("project-a")).toBe(functionalCartStorageKey("project-a"));
    expect(functionalCartStorageKey("project-a")).not.toBe(functionalCartStorageKey("project-b"));
  });
  it("gives compact usable APIs, never a universal feature list or raw managed source", () => {
    const contract=functionalGenerationContract(analyzeRequestProfile("Add to Cart with quantity controls and product sizes").functional);
    expect(contract).toContain("cart.add"); expect(contract).toContain("./sites-ui/functional");
    expect(contract).not.toContain("DemoDialog"); expect(contract).not.toContain("function useCart");
    expect(estimateTokensConservative(contract)).toBeLessThan(700);
  });
  it("does not downgrade required real backend work into fabricated success", () => {
    for (const request of ["Process payments for my store", "Send real emails from a contact form", "Real account creation"]) {
      const requirements=analyzeRequestProfile(request).functional;
      expect(() => assertFunctionalBackendSupport(requirements)).toThrow(/no configured implementation/);
    }
    expect(() => assertFunctionalBackendSupport(analyzeRequestProfile(corporatePrompt).functional)).not.toThrow();
    const realForm=analyzeRequestProfile("Build a real backend contact form").functional;
    expect(() => validateFunctionalBackendBundle(single('import { DemoForm as Contact } from "./sites-ui/functional";export const App=()=> <Contact/>'),realForm)).toThrow(/demo-only form/);
    expect(() => validateFunctionalBackendBundle(single('import { ContactSection } from "./sites-ui/sections/ContactSection";export const App=()=> <ContactSection/>'),realForm)).toThrow(/demo-only form/);
    expect(() => validateFunctionalBackendBundle(single('const App=()=> <form onSubmit={submitToConfiguredRuntime}/>'),realForm)).not.toThrow();
  });
  it("keeps explicit mock contact forms local while preserving normal runtime forms", async () => {
    const planner=new DeterministicRequirementsPlanner();
    expect((await planner.plan(corporatePrompt)).runtime).toBeUndefined();
    expect((await planner.plan("Build a corporate contact form")).runtime?.collections.map(collection=>collection.name)).toContain("contact_submissions");
    expect((await planner.plan(ecommercePrompt)).pages.map(page=>page.path)).toContain("/product");
  });
});

describe("Reported failure, conservative recovery and strict interaction validation", () => {
  it("reproduces the exact Search alert on line 34, without falsely repairing an unknown action", () => {
    const candidate=single(reportedAlertSearch);
    expect(() => validateReferenceInteractions(candidate)).toThrow(/src\/App.tsx:34 has an alert-only or empty button action/);
    expect(recoverFunctionalPlaceholders(candidate).bundle).toBe(candidate);
  });
  it.each([
    '<button onClick={() => alert("Added")}>Add to Cart</button>', '<button onClick={() => {}}>Cart</button>',
    '<a href="#cart">Cart</a>', '<a href="#search">Search</a>', '<button>Search</button>',
    '<button onClick={null}>Search</button>', '<button onClick={() => {return;}}>Search</button>',
  ])("rejects an unprovable placeholder rather than guessing: %s", content => {
    const candidate=single(content); expect(recoverFunctionalPlaceholders(candidate).fixes).toEqual([]);
    expect(() => validateReferenceInteractions(candidate)).toThrow();
  });
  it("repairs only a known controller and real panel, and is idempotent", () => {
    const recovered=recoverFunctionalPlaceholders(functionalFixtures.ecommerce);
    expect(recovered.fixes).toEqual(["VERIFIED_CART_TRIGGER_WIRING"]);
    expect(() => validateReferenceInteractions(recovered.bundle)).not.toThrow();
    expect(recoverFunctionalPlaceholders(recovered.bundle).fixes).toEqual([]);
    const ambiguous=single(functionalFixtures.ecommerce.files[0]!.content.replace('<CartPanel/>',''));
    expect(recoverFunctionalPlaceholders(ambiguous).fixes).toEqual([]);
    expect(() => validateReferenceInteractions(ambiguous)).toThrow();
    const shadowed=single(functionalFixtures.ecommerce.files[0]!.content.replace('function App()','function App({useCart})'));
    expect(recoverFunctionalPlaceholders(shadowed).fixes).toEqual([]);
    const mutated=single(functionalFixtures.ecommerce.files[0]!.content.replace('const cart=useCart();','const cart=useCart(); cart.openCart=()=>{};'));
    expect(recoverFunctionalPlaceholders(mutated).fixes).toEqual([]);
  });
  it("does not reject real stateful React handlers or a logging call alongside an update", () => {
    expect(() => validateReferenceInteractions(single('const [n,setN]=useState(0); export const App=()=> <button onClick={()=>{console.log("clicked");setN(n+1)}}>{n}</button>'))).not.toThrow();
  });
});

async function harness(candidate: SiteCoderFileBundle, reference: boolean, repairResponse?: (request: AgentRequest) => BuildRepairPatchBundle) {
  vi.stubEnv("npm_config_offline","true");
  const root=await temp(), requests: AgentRequest[]=[];
  const provider=new MockAgentProvider({customResponse: request => {
    requests.push(request);
    const repair=request.responseContract?.type==="JSON_SCHEMA" && request.responseContract.name==="BuildRepairPatchBundle";
    return {id:"functional-fixture",model:request.model,message:{role:"assistant",content:JSON.stringify(repair?(repairResponse?.(request)??{patches:[]}):candidate)},
      toolCalls:[],usage:{inputTokens:100,outputTokens:120},latencyMs:0,finishReason:"stop"};
  }});
  Object.defineProperty(provider,"id",{value:"offline-functional-fixture"});
  const registry=new AgentProviderRegistry(); registry.register(provider);
  const billing={preflight:vi.fn(async()=>({})),finalizeSuccessfulJob:vi.fn(async(job:SiteJob)=>job)};
  const diagnostics=new LocalFailedCandidateEvidence(join(root,"diagnostics"));
  let resolver: CatalogTemplateDesignReferenceResolver|undefined;
  if(reference){
    const directory=resolve("templates/ecommerce-store"),manifest=await loadTemplateManifest(directory);
    const archive=await packageTemplateSource(await validateTemplateSource(directory));
    const record:SiteTemplate={...manifest,id:"functional-ref",categoryId:"commerce",status:"active",sourceObject:"offline-reference.zip",sourceSha256:archive.sha256,previews:{},createdAt:new Date(0),updatedAt:new Date(0)};
    resolver=new CatalogTemplateDesignReferenceResolver({findTemplateVersion:async()=>record},{readObject:async()=>archive.bytes});
  }
  const api=createLocalSitesProduct({executionRoot:join(root,"execution"),artifactRoot:join(root,"artifacts"),agentRegistry:registry,orchestrationAgent:provider,
    ...(resolver?{templateDesignReferences:resolver}:{}),billing:billing as unknown as SiteCreditBillingService,failedCandidateEvidence:diagnostics});
  return {root,provider,requests,billing,diagnostics,api,resolver};
}

// Same nine inert control definitions observed in the retained live candidate;
// no private prompt/source or dependency on expiring development diagnostics.
const supportControls = [
  ["Read our story", "North & Loom creates considered clothing using natural fabrics."],
  ["Size guide", "Demo garment chest measurements: S 92 cm, M 100 cm, L 108 cm."],
  ["Explore collection", "The linen collection pairs breathable shirts with everyday knitwear."],
  ["Checkout", "Demo only: checkout is unavailable; no payment is processed."],
  ["Contact", "This frontend demo has no configured contact service; nothing is sent."],
  ["Shipping & returns", "Demo policy: allow 3–5 business days for delivery and 30 days for returns."],
  ["Size guide", "Demo fit guidance: compare the garment measurements with a shirt you own."],
  ["Instagram", "No Instagram profile is configured for this demo."],
  ["Pinterest", "No Pinterest profile is configured for this demo."],
] as const;
const inertSupport = `function SupportControls(){return <section>${supportControls.map(([label])=>`<button type="button">${label}</button>`).join("\n")}</section>}`;
const workingSupport = `function SupportControls(){const [message,setMessage]=useState("");return <section>${supportControls.map(([label,message])=>`<button type="button" onClick={()=>setMessage(${JSON.stringify(message)})}>${label}</button>`).join("\n")}<p role="status" aria-label="Support feedback">{message}</p></section>}`;
function withInertSupport(): SiteCoderFileBundle {
  const base=recoverFunctionalPlaceholders(functionalFixtures.ecommerce).bundle;
  return {...base,files:base.files.map(file=>file.path!=="src/App.tsx"?file:
    {...file,content:file.content.replace('<footer>','<SupportControls/><footer>')+"\n"+inertSupport})};
}

describe("Live inert-control regression uses the existing shared repair allowance", () => {
  it.each([true,false])("repairs all nine controls before materialization and passes three-viewport QA (reference=%s)", async reference => {
    const candidate=withInertSupport();
    expect(()=>validateReferenceInteractions(candidate)).toThrow(/and 4 more/);
    const h=await harness(candidate,reference,()=>({patches:[{path:"src/App.tsx",find:inertSupport,replace:workingSupport}]}));
    const result=await h.api.pipeline.generate({userId:"offline-functional-owner" as UserId,prompt:ecommercePrompt,planningMode:"deterministic",
      agentProvider:h.provider.id,browserQAEnabled:true,retainPreview:true,...(reference?{templateReference:{templateKey:"ecommerce-store",version:1}}:{})});
    try {
      expect(h.provider.callCount).toBe(2); expect(result.inference?.physicalRequests).toBe(2);
      expect(result.inference?.stages.GENERATE_SITE.logicalRequests).toBe(1);
      expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(1);
      expect(result.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(0);
      const repair=h.requests[1]!;
      expect(repair.responseContract).toMatchObject({name:"BuildRepairPatchBundle"});
      expect(repair.messages[0]?.content).toContain("Functional capability contract v1");
      expect(repair.messages[0]?.content).toContain("CartPanel");
      // Public error is shortened after five; all nine findings and source reach repair.
      expect(repair.messages[0]?.content.match(/has a button without an action/g)?.length).toBe(14);
      expect(repair.messages[0]?.content).toContain("Pinterest");
      expect(result.build.success).toBe(true); expect(result.browserQA?.status).toBe("PASS");
      expect(result.browserQA?.checks.filter(check=>check.status==="FAIL")).toEqual([]);
      expect(new Set(result.browserQA?.checks.map(check=>check.viewport?.id))).toEqual(new Set(["DESKTOP","TABLET","MOBILE"]));
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
      const project=await h.api.projects.getById(result.siteId); expect(project?.latestVersionId).toBe(result.versionId);
      const source=JSON.parse(Buffer.from((await h.api.artifacts.get(result.sourceArtifactRef))!).toString()) as {files:Record<string,string>};
      expect(source.files["src/App.tsx"]).toContain(workingSupport);
      const browser=await chromium.launch({headless:true});
      try {
        const page=await browser.newPage(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
        await page.goto(result.preview.url!,{waitUntil:"networkidle"});
        for(const [label,message] of supportControls){
          const controls=page.getByRole("button",{name:label,exact:true});
          await controls.nth(label==="Size guide"&&message.includes("fit guidance")?1:0).click();
          expect(await page.getByRole("status",{name:"Support feedback"}).innerText()).toBe(message);
        }
        await page.reload({waitUntil:"networkidle"});
        await page.getByRole("button",{name:"Checkout",exact:true}).click();
        expect(await page.getByRole("status",{name:"Support feedback"}).innerText()).toContain("no payment is processed");
        expect(errors).toEqual([]);
      } finally {await browser.close();}
    } finally {await h.api.execution.destroyEnvironment(result.preview.environmentId);}
  },180_000);

  it.each(["unresolved","partial","alert","build-failure","no-effect","managed-file","disabled"])("rejects invalid repair without a third call, successful persistence or charge: %s", async kind => {
    if(kind==="disabled"){
      // eslint-disable-next-line @typescript-eslint/unbound-method -- preserve the runtime receiver below.
      const run=LocalCliAgentRuntime.prototype.run;
      vi.spyOn(LocalCliAgentRuntime.prototype,"run").mockImplementation(function(this:LocalCliAgentRuntime,environment,task,...rest){
        return run.call(this,environment,{...task,limits:{...task.limits,maxBuildRepairs:0}},...rest);
      });
    }
    const candidate=withInertSupport();
    const replacement=kind==="partial"?inertSupport.replace('<button type="button">Read our story</button>','<a href="/product">Read our story</a>')
      :kind==="alert"?inertSupport.replaceAll('<button type="button">','<button type="button" onClick={()=>alert("Done")}>')
      :kind==="no-effect"?inertSupport.replaceAll('<button type="button">','<button type="button" onClick={()=>{const value=1;void value;}}>')
      :workingSupport+(kind==="build-failure"?'\nconst invalidType: number = "not a number";':"");
    const h=await harness(candidate,true,()=>({patches:kind==="unresolved"?[]:kind==="managed-file"?[{path:"package.json",find:"x",replace:"y"}]:[{path:"src/App.tsx",find:inertSupport,replace:replacement}]}));
    const qa=vi.spyOn(h.api.browserQA,"run"),siteId=("inert-repair-"+kind) as SiteId;
    await expect(h.api.pipeline.generate({userId:"offline-functional-owner" as UserId,prompt:ecommercePrompt,planningMode:"deterministic",
      agentProvider:h.provider.id,browserQAEnabled:true,templateReference:{templateKey:"ecommerce-store",version:1},referenceGenerationSiteId:siteId})).rejects.toMatchObject({
        code:kind==="build-failure"?"REPAIR_LIMIT_REACHED":kind==="no-effect"?"VALIDATION_FAILED":kind==="managed-file"?"STRUCTURED_RESPONSE_SCHEMA_INVALID":"GENERATION_INCOMPLETE"});
    expect(h.provider.callCount).toBe(kind==="disabled"?1:2);
    if(kind!=="no-effect") expect(qa).not.toHaveBeenCalled();
    expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    expect((await h.api.projects.listByOwner("offline-functional-owner")).items).toHaveLength(0);
    expect((await h.api.versions.listBySite(siteId)).items).toHaveLength(0);
    if(kind==="unresolved"||kind==="partial"||kind==="alert"||kind==="disabled"){
      const names=await readdir(h.diagnostics.root);expect(names).toHaveLength(1);
      const evidence=JSON.parse(await readFile(join(h.diagnostics.root,names[0]!),"utf8")) as {validation:{check:string};source:{files:Record<string,string>}};
      expect(evidence.validation.check).toBe("interaction.controls");
      // Build Repair diagnostics intentionally retain the immutable source
      // snapshot supplied to repair, not the rejected partial/model mutation.
      expect(evidence.source.files["src/App.tsx"]).toContain(inertSupport);
    }
  },180_000);
});

describe("Real offline source → recovery → static validation → build → three-viewport QA", () => {
  it("materializes explicitly requested gallery placeholders with distinct active views, without another model call",async()=>{
    const gallery='<div className="gallery"><div>{[0,1,2].map(n=><button key={n} className={view===n?"selected":""} onClick={()=>setView(n)}><img src={placeholderImage} alt={"View "+(n+1)}/></button>)}</div><div className="large-image"><img src={placeholderImage} alt="Product"/></div></div>';
    const candidate={...functionalFixtures.ecommerce,files:functionalFixtures.ecommerce.files.map(file=>file.path!=="src/App.tsx"?file:{...file,content:file.content
      .replace('const cart=useCart();','const [view,setView]=useState(0);const placeholderImage="/front.svg";const cart=useCart();')
      .replace('<ProductGallery images={[{src:"/front.svg",alt:"Linen shirt front"},{src:"/back.svg",alt:"Linen shirt back"}]}/>',gallery)})};
    const h=await harness(candidate,true);
    const result=await h.api.pipeline.generate({userId:"offline-functional-owner" as UserId,prompt:ecommercePrompt+" Use product gallery placeholders.",planningMode:"deterministic",agentProvider:h.provider.id,browserQAEnabled:true,retainPreview:true,templateReference:{templateKey:"ecommerce-store",version:1}});
    try{
      expect(result.build.success).toBe(true);expect(result.browserQA?.checks.filter(check=>check.status==="FAIL")).toEqual([]);expect(h.provider.callCount).toBe(1);
      const browser=await chromium.launch({headless:true});
      try{const page=await browser.newPage();await page.goto(new URL('/product',result.preview.url).toString(),{waitUntil:"networkidle"});
        const active=page.locator('[data-sites-gallery-active]');const before=await active.getAttribute('src');
        await page.getByRole('button',{name:'View image 2',exact:true}).click();
        expect(await active.getAttribute('src')).not.toBe(before);expect(await active.getAttribute('alt')).toBe('Product view 2 placeholder');
      }finally{await browser.close();}
    }finally{await h.api.execution.destroyEnvironment(result.preview.environmentId);}
  },180_000);
  it.each(["missing-state","fake-newsletter","no-effect-handler","runtime-handler-error"])("rejects observable adversarial behavior without successful persistence or billing: %s", async kind => {
    const original=functionalFixtures.ecommerce;
    const fake='function FakeNewsletter(){const [done,setDone]=useState(false);return <form onSubmit={e=>{e.preventDefault();setDone(true)}}><label>Email<input name="email" aria-label="Email" type="email" required/></label><button type="submit">Subscribe</button>{done&&<p role="status">Subscribed to the real mailing list!</p>}</form>}';
    const candidate={...original,files:original.files.map(file=>file.path!=="src/App.tsx"?file:{...file,content:kind==="missing-state"
      ?file.content.replace('onClick={()=>{}}','onClick={()=>missingCartState()}')
      :kind==="fake-newsletter"?file.content.replace('export function App()',fake+'\nexport function App()').replace('<NewsletterSignup/>','<FakeNewsletter/>')
      :file.content.replace('onClick={()=>{}}',kind==="runtime-handler-error"?'onClick={()=>{throw new Error("broken control")}}':'onClick={()=>{const unused=42;void unused;}}')})};
    const h=await harness(candidate,true),siteId=("adversarial-"+kind) as SiteId;
    await expect(h.api.pipeline.generate({userId:"offline-functional-owner" as UserId,prompt:ecommercePrompt,planningMode:"deterministic",agentProvider:h.provider.id,browserQAEnabled:true,
      templateReference:{templateKey:"ecommerce-store",version:1},referenceGenerationSiteId:siteId})).rejects.toMatchObject({code:kind==="missing-state"?"REPAIR_LIMIT_REACHED":"VALIDATION_FAILED"});
    expect(h.provider.callCount).toBe(kind==="runtime-handler-error"?1:2); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    expect((await h.api.projects.listByOwner("offline-functional-owner")).items).toHaveLength(0); expect((await h.api.versions.listBySite(siteId)).items).toHaveLength(0);
    const names=await readdir(h.diagnostics.root); expect(names).toHaveLength(["fake-newsletter","no-effect-handler"].includes(kind)?2:1);
    const retained=await readFile(join(h.diagnostics.root,names[0]!),"utf8");
    expect(retained).toContain(kind==="missing-state"?"TS2304":kind==="fake-newsletter"?"honest mock confirmation":"no observable action");
    if(kind==="runtime-handler-error") {
      const evidence=JSON.parse(retained) as {qa:{checks:{checkId:string;status:string}[]}};
      expect(evidence.qa.checks).toContainEqual(expect.objectContaining({checkId:"runtime.page-error",status:"FAIL"}));
    }
  },300_000);
  it.each([
    {kind:"ecommerce" as const,reference:true,prompt:ecommercePrompt},
    {kind:"ecommerce" as const,reference:false,prompt:ecommercePrompt},
    {kind:"corporate" as const,reference:false,prompt:corporatePrompt},
    {kind:"portfolio" as const,reference:false,prompt:portfolioPrompt},
  ])("verifies $kind (reference=$reference), current source, one coder call and one billing outcome", async fixture => {
    const h=await harness(functionalFixtures[fixture.kind],fixture.reference);
    const result=await h.api.pipeline.generate({userId:"offline-functional-owner" as UserId,prompt:fixture.prompt,planningMode:"deterministic",agentProvider:h.provider.id,browserQAEnabled:true,retainPreview:true,
      ...(fixture.reference?{templateReference:{templateKey:"ecommerce-store",version:1}}:{})});
    try {
      expect(result.build.success).toBe(true); expect(result.browserQA?.status).toBe("PASS");
      expect(result.browserQA?.checks.filter(check=>check.status==="FAIL"||check.status==="WARNING")).toEqual([]);
      expect(result.browserQA?.checks.filter(check=>check.checkId==="runtime.page-error").map(check=>check.status)).toEqual(Array<string>(result.siteSpec.requirements.pages.length*3).fill("PASS"));
      expect(h.provider.callCount).toBe(1); expect(result.inference?.physicalRequests).toBe(1);
      expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0); expect(result.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(0);
      expect(h.requests[0]?.messages[0]?.content).toContain("Functional capability contract v1");
      if(fixture.reference){
        const reference=await h.resolver!.resolve({templateKey:"ecommerce-store",version:1});
        expect(h.requests[0]?.messages[0]?.content).toContain(templateDesignPrompt(reference.design));
      }
      const project=await h.api.projects.getById(result.siteId); expect(project?.latestVersionId).toBe(result.versionId);
      const source=JSON.parse(Buffer.from((await h.api.artifacts.get(result.sourceArtifactRef))!).toString()) as {files:Record<string,string>};
      expect(source.files[FUNCTIONAL_RUNTIME_PATH]).toContain("useSyncExternalStore");
      expect(source.files["src/App.tsx"]).not.toContain("Atelier Row");
      await expect(readdir(h.diagnostics.root)).rejects.toMatchObject({code:"ENOENT"});
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
      const browser=await chromium.launch({headless:true});
      try {
        const page=await browser.newPage(); const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
        const previewUrl=result.preview.url; if(!previewUrl) throw new Error("Missing local preview");
        await page.goto(previewUrl,{waitUntil:"networkidle"});
        if(fixture.kind==="ecommerce"){
          expect(source.files["src/App.tsx"]).toContain("cart.openCart()");
          await page.getByRole("combobox",{name:"Category",exact:true}).selectOption("Shirts");
          expect(await page.locator("[data-product-id]").count()).toBe(1); expect(await page.locator("[data-product-id]").innerText()).toContain("Linen Shirt");
          await page.getByRole("link",{name:"View Linen Shirt",exact:true}).click(); expect(new URL(page.url()).pathname).toBe("/product");
          await page.getByLabel("Size",{exact:true}).selectOption("L"); await page.getByLabel("Quantity",{exact:true}).fill("2");
          await page.getByRole("button",{name:"Increase quantity"}).click(); expect(await page.getByLabel("Quantity",{exact:true}).inputValue()).toBe("3");
          await page.getByRole("button",{name:"Decrease quantity"}).click(); expect(await page.getByLabel("Quantity",{exact:true}).inputValue()).toBe("2");
          await page.getByRole("button",{name:"View image 2"}).click(); expect(await page.locator("[data-sites-gallery-active]").getAttribute("src")).toBe("/back.svg");
          await page.getByRole("button",{name:"Add to Cart",exact:true}).click(); expect(await page.getByRole("button",{name:"Cart (2)",exact:true}).count()).toBe(1);
          await page.getByRole("button",{name:"Cart (2)",exact:true}).click();
          const cart=page.getByRole("complementary",{name:"Shopping cart"}); expect(await cart.isVisible()).toBe(true);
          expect(await cart.innerText()).toContain("Linen Shirt"); expect(await cart.innerText()).toContain("Size L · Quantity 2");
          await page.reload({waitUntil:"networkidle"}); expect(await page.getByRole("button",{name:"Cart (2)",exact:true}).count()).toBe(1);
          await page.getByLabel("Newsletter email").fill("qa@example.test"); await page.getByRole("button",{name:"Subscribe",exact:true}).click();
          expect(await page.getByRole("status").innerText()).toContain("not been subscribed");
        }else{
          await page.getByRole("button",{name:"Menu",exact:true}).click(); expect(await page.getByRole("navigation",{name:"Mobile navigation"}).isVisible()).toBe(true);
          await page.getByRole("button",{name:"Menu",exact:true}).click(); expect(await page.getByRole("navigation",{name:"Mobile navigation"}).isVisible()).toBe(false);
          const tabs=page.getByRole("tab"); await tabs.nth(1).click(); expect(await tabs.nth(1).getAttribute("aria-selected")).toBe("true");
          const details=page.locator("details"); await details.locator("summary").click(); expect(await details.getAttribute("open")).not.toBeNull();
          if(fixture.kind==="corporate"){
            await page.getByRole("button",{name:"Request information",exact:true}).click(); expect(await page.getByRole("status").innerText()).toContain("1");
            const form=page.getByRole("form",{name:"Contact"}); await form.getByLabel("Name",{exact:true}).fill("Offline QA");
            await form.getByLabel("Email",{exact:true}).fill("bad"); expect(await form.evaluate(element=>(element as HTMLFormElement).checkValidity())).toBe(false);
            await form.getByLabel("Email",{exact:true}).fill("qa@example.test"); await form.getByLabel("Message",{exact:true}).fill("Local demonstration");
            await form.getByRole("button",{name:"Send demo message"}).click(); expect(await form.getByRole("status").innerText()).toContain("Nothing was sent");
            await page.getByRole("button",{name:"Read company note",exact:true}).click(); expect(await page.getByRole("dialog").isVisible()).toBe(true);
            await page.getByRole("button",{name:"Close dialog"}).click(); expect(await page.getByRole("dialog").isVisible()).toBe(false);
          }
        }
        expect(errors).toEqual([]);
      } finally {await browser.close();}
    } finally {await h.api.execution.destroyEnvironment(result.preview.environmentId);}
  },180_000);

  it("retains the confirmed alert regression with source, line, capability and reference metadata, without successful billing", async () => {
    const candidate={...functionalFixtures.ecommerce,files:functionalFixtures.ecommerce.files.map(file=>file.path==="src/App.tsx"?{...file,content:file.content.replace('<CartPanel/>','<CartPanel/>'+reportedAlertSearch)}:file)};
    const h=await harness(candidate,true); const siteId="failed-functional-candidate" as SiteId;
    await expect(h.api.pipeline.generate({userId:"offline-functional-owner" as UserId,prompt:ecommercePrompt,planningMode:"deterministic",agentProvider:h.provider.id,browserQAEnabled:true,
      templateReference:{templateKey:"ecommerce-store",version:1},referenceGenerationSiteId:siteId})).rejects.toMatchObject({code:"GENERATION_INCOMPLETE",metadata:{validationCheck:"interaction.controls"}});
    expect(h.provider.callCount).toBe(2); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    expect((await h.api.projects.listByOwner("offline-functional-owner")).items).toHaveLength(0);
    expect((await h.api.versions.listBySite(siteId)).items).toHaveLength(0);
    const files=await readdir(h.diagnostics.root); expect(files).toHaveLength(1);
    const evidence=JSON.parse(await readFile(join(h.diagnostics.root,files[0]!),"utf8")) as {validation:Record<string,unknown>;functionalRequirements:{capabilities:string[]};referenceContext:Record<string,unknown>;source:{files:Record<string,string>}};
    expect(evidence.validation).toMatchObject({failureStage:"STATIC_VALIDATION",check:"interaction.controls"});
    expect(evidence.source.files["src/App.tsx"]).toContain('window.alert("Search is available in this demo store.")');
    expect(evidence.functionalRequirements.capabilities).toContain("cart"); expect(evidence.referenceContext).toMatchObject({templateKey:"ecommerce-store",templateVersion:1,referenceContextPresent:true});
    expect(FAILED_CANDIDATE_LIMITS).toMatchObject({maxFiles:5,maxBytes:2*1024*1024,maxAgeMs:24*60*60*1000});
  },60_000);
});
