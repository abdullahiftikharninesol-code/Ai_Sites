import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { applyUsableGenerationReportPolicy, usableGenerationChecks } from "../src/browser-qa/usable-generation-checks.js";
import { createBrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import { DeterministicRequirementsPlanner, DeterministicDesignPlanner, assembleSiteSpec } from "../src/planning/planning.js";
import { functionalRequirements } from "../src/sites/generation/functional-capabilities.js";
import { withFunctionalContract } from "../src/sites/generation/functional-route-contract.js";
import { applyFunctionalSourceContract, resolveFunctionalSourceContract, resolveUsableGenerationSourceContract } from "../src/sites/generation/functional-source-contract.js";
import { generationInteractionAdvisories, USABLE_GENERATION_GUIDANCE } from "../src/sites/generation/generation-acceptance-policy.js";
import { createAssetManifest } from "../src/sites/assets/asset-domain.js";
import { ArtifactMediaStore, PLACEHOLDER_PNG } from "../src/sites/assets/media-store.js";
import { validateReferenceInteractions } from "../src/cli/runtime/reference-interaction-validator.js";
import type { UserId } from "../src/shared/types.js";

const prompt = 'Build a premium responsive agency website.\n## Website Pages\n### Home\nWorking FAQ accordion and search.\n### Services\nWorking service tabs.\n### Contact\nValidated contact form.\n## Shared\nMobile navigation menu.';
const home = '<><header><a href="/">Home</a></header><main><h2>North &amp; Loom</h2><p>Thoughtful products and practical service for our customers.</p><button type="button">View offers</button></main></>';
const bundle = (jsx = home) => ({ files: [{ path: "src/App.tsx", content: `export function App(){return (${jsx});}` }] });
const parent = resolve('.sites-runtime/usable-generation-tests'), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { if (!root.startsWith(parent + sep)) throw new Error('Unsafe cleanup'); await rm(root,{recursive:true,force:true}); } });
async function spec() { const requirements = await new DeterministicRequirementsPlanner().plan(prompt); const design = await new DeterministicDesignPlanner().plan(requirements);return withFunctionalContract(assembleSiteSpec('Policy fixture',prompt,requirements,design),functionalRequirements(prompt)); }

describe('Usable generation acceptance without complete prompt coverage',()=>{
  it('keeps strict source validation available and records all missing requested surfaces without rewriting the candidate',async()=>{
    const original=bundle(),before=JSON.stringify(original),site=await spec();
    expect(()=>resolveFunctionalSourceContract(site,original)).toThrow(/no implemented generated route/);
    const contract=resolveUsableGenerationSourceContract(site,original);
    expect(contract.acceptancePolicy).toBe('USABLE_WEBSITE');expect(contract.actualRoutes).toEqual(['/']);
    expect(contract.advisories?.some(item=>item.message.includes('Contact'))).toBe(true);
    expect(contract.advisories?.some(item=>item.message.includes('accordion'))).toBe(true);
    expect(applyFunctionalSourceContract(site,contract).requirements.pages.map(page=>page.path)).toEqual(['/']);
    expect(JSON.stringify(original)).toBe(before);
    expect(generationInteractionAdvisories(original)[0]?.check).toBe('interaction.controls');
    expect(()=>validateReferenceInteractions(original)).toThrow(/without an action/);
  });
  it.each(['functional.requirements','functional.navigation','functional.controls','interaction-smoke','interaction.mobile-nav','form-smoke','responsive-overflow','accessibility-smoke','runtime.console-error'])('retains %s failure evidence as advisory',checkId=>{
    const report=createBrowserQAReport({runId:'offline',browser:{name:'chromium'},routes:['/'],viewports:[],checks:[{checkId,category:'INTERACTION',status:'FAIL',severity:'ERROR',failureKind:'CHECK_TIMEOUT',message:'Original private finding'}],startedAt:new Date(0).toISOString(),completedAt:new Date(1).toISOString(),durationMs:1});
    expect(report.status).toBe('FAIL');const accepted=applyUsableGenerationReportPolicy(report);
    expect(accepted.status).toBe('PASS_WITH_WARNINGS');expect(accepted.checks[0]).toMatchObject({status:'FAIL',severity:'WARNING',failureKind:'CHECK_TIMEOUT',message:'Original private finding'});
    expect(report.checks[0]?.severity).toBe('ERROR');
  });
  it.each(['generation.meaningful-content','generation.primary-navigation','runtime.page-error','network.failed-request','qa.run-budget','qa.infrastructure'])('never downgrades the blocking %s gate',checkId=>{
    const report=createBrowserQAReport({runId:'offline',browser:{name:'chromium'},routes:['/'],viewports:[],checks:[{checkId,category:'RUNTIME',status:'FAIL',severity:'ERROR',message:'Blocking finding'}],startedAt:new Date(0).toISOString(),completedAt:new Date(1).toISOString(),durationMs:1});
    expect(applyUsableGenerationReportPolicy(report).status).toBe('FAIL');
  });
  it('keeps unsafe links blocking and does not gate on requirement-specific browser probes',()=>{
    const report=createBrowserQAReport({runId:'offline',browser:{name:'chromium'},routes:['/'],viewports:[],checks:[{checkId:'internal-links',category:'ROUTING',status:'FAIL',severity:'ERROR',message:'Unsafe link',evidence:[{type:'element',locatorDescription:'a[href]',accessibleName:'unsafe scheme: javascript:evil()'}]}],startedAt:new Date(0).toISOString(),completedAt:new Date(1).toISOString(),durationMs:1});
    expect(applyUsableGenerationReportPolicy(report).status).toBe('FAIL');
    const checks=usableGenerationChecks();expect(checks.some(check=>check.definition.checkId==='functional.requirements')).toBe(false);
    expect(checks.find(check=>check.definition.checkId==='network.failed-request')?.afterInteractions).toBe(true);
    expect(checks.find(check=>check.definition.checkId==='functional.controls')?.definition.timeoutMs).toBe(8000);
  });
  it.each([true,false])('distinguishes a noncritical alert from an unexpected popup/download, alertOnly=%s',alertOnly=>{
    const evidence=alertOnly?[{type:'console' as const,level:'alert',message:'Local alert'}]:[{type:'network' as const,url:'about:blank',failureText:'Unexpected popup blocked'}];
    const report=createBrowserQAReport({runId:'offline',browser:{name:'chromium'},routes:['/'],viewports:[],checks:[{checkId:'browser-safety-events',category:'INTERACTION',status:'FAIL',severity:'ERROR',message:'Safety event',evidence}],startedAt:new Date(0).toISOString(),completedAt:new Date(1).toISOString(),durationMs:1});
    expect(applyUsableGenerationReportPolicy(report).status).toBe(alertOnly?'PASS_WITH_WARNINGS':'FAIL');
  });
});

async function harness(jsx=home,source?:string) {
  await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'case-'));roots.push(root);
  const requests:AgentRequest[]=[];const candidate=source?{files:[{path:'src/App.tsx',content:source}]}:bundle(jsx);
  const provider=new MockAgentProvider({customResponse:request=>{requests.push(request);const repair=request.responseContract?.type==='JSON_SCHEMA'&&request.responseContract.name==='BuildRepairPatchBundle';return{id:'offline-policy',model:request.model,message:{role:'assistant',content:JSON.stringify(repair?{patches:[]}:candidate)},toolCalls:[],usage:{inputTokens:10,outputTokens:20},latencyMs:0,finishReason:'stop'};}});
  Object.defineProperty(provider,'id',{value:'offline-usable-policy'});const registry=new AgentProviderRegistry();registry.register(provider);
  const billing={preflight:vi.fn(async()=>({})),finalizeSuccessfulJob:vi.fn(async(job:unknown)=>job)};
  const diagnostics=new LocalFailedCandidateEvidence(join(root,'diagnostics'));
  const product=createLocalSitesProduct({executionRoot:join(root,'execution'),artifactRoot:join(root,'artifacts'),agentRegistry:registry,orchestrationAgent:provider,billing:billing as unknown as SiteCreditBillingService,failedCandidateEvidence:diagnostics});
  const request={userId:'offline-policy-owner' as UserId,prompt,planningMode:'deterministic' as const,agentProvider:provider.id,browserQAEnabled:false,retainPreview:false};
  return{product,billing,requests,candidate,request};
}

describe('Real offline build/QA/persistence under usable generation policy',()=>{
  it('records an unused uploaded image as missing content without bypassing asset reference security',async()=>{
    const h=await harness(),mediaStore=new ArtifactMediaStore(h.product.artifacts);
    const asset=await mediaStore.put({intent:{intentId:'brand-logo',logicalAssetId:'brand.logo',mediaType:'IMAGE',role:'LOGO',purpose:'Brand logo',description:'Offline logo fixture',altTextIntent:'Logo',required:true,decorative:false},bytes:PLACEHOLDER_PNG,contentType:'image/png',sourceType:'USER_UPLOAD',provenance:{userUploadName:'logo.png'},altText:'Logo'});
    const assetManifest=createAssetManifest({manifestVersion:1,assets:[asset]});const result=await h.product.pipeline.generate({...h.request,assetManifest});expect(result.browserQA?.status).not.toBe('FAIL');expect(h.requests).toHaveLength(1);expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect(result.browserQA?.checks.some(check=>check.evidence?.some(item=>item.type==='element'&&item.locatorDescription==='user-assets.coverage'))).toBe(true);
    await expect(mediaStore.get({...asset,contentHash:'0'.repeat(64)})).rejects.toMatchObject({code:'ASSET_RESOLUTION_FAILED'});
  },180000);
  it('keeps a missing footer fragment and inert optional menu advisory',async()=>{
    const h=await harness('<><header><a href="/">Home</a><button aria-controls="main-nav" aria-expanded="false" onClick={()=>{}}>Menu</button><nav id="main-nav" hidden><a href="/">Home</a></nav></header><main><h2>Home</h2><p>Useful product information.</p></main><footer><nav><a href="#missing-footer-section">Optional footer information</a></nav></footer></>');
    const result=await h.product.pipeline.generate(h.request);expect(result.browserQA?.status).toBe('PASS_WITH_WARNINGS');expect(result.browserQA?.checks.filter(check=>check.checkId==='generation.primary-navigation').every(check=>check.status==='PASS')).toBe(true);expect(h.requests).toHaveLength(1);
  },180000);
  it('accepts a working custom router that static analysis cannot enumerate',async()=>{
    const h=await harness(home,'export function App(){const about=window.location.pathname.includes("about");return <><header><a href="/">Home</a><a href="/about">About</a></header><main><h2>{about?"Our company":"Home"}</h2><p>{about?"An experienced team serving our customers.":"Useful information about our products."}</p></main></>}');
    const result=await h.product.pipeline.generate(h.request);expect(result.browserQA?.status).not.toBe('FAIL');expect(result.browserQA?.checks.filter(check=>check.checkId==='generation.primary-navigation').every(check=>check.status==='PASS')).toBe(true);expect(h.requests).toHaveLength(1);expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
  },180000);
  it('accepts a usable site missing requested pages, FAQ, tabs, form and mobile menu; saves unchanged current source and bills once',async()=>{
    const h=await harness();const result=await h.product.pipeline.generate(h.request);
    expect(result.build.success).toBe(true);expect(result.browserQA?.status).toBe('PASS_WITH_WARNINGS');expect(result.browserQA?.checks.filter(check=>check.status==='FAIL'&&check.severity==='ERROR')).toEqual([]);
    expect(result.browserQA?.routes).toEqual(['/']);expect(new Set(result.browserQA?.viewports.map(view=>view.id))).toEqual(new Set(['DESKTOP','TABLET','MOBILE']));
    expect(result.browserQA?.checks.some(check=>check.checkId==='generation.requirement-advisories'&&check.status==='WARNING')).toBe(true);
    expect(h.requests).toHaveLength(1);expect(h.requests[0]?.systemInstructions).toContain(USABLE_GENERATION_GUIDANCE);expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
    const saved=JSON.parse(Buffer.from((await h.product.artifacts.get(result.sourceArtifactRef))!).toString()) as {files:Record<string,string>};expect(saved.files['src/App.tsx']).toBe(h.candidate.files[0]?.content);
    expect(result.browserQA?.checks.filter(check=>check.checkId==='runtime.page-error').every(check=>check.status==='PASS')).toBe(true);
    expect(h.product.browserQA.activeBrowserCount).toBe(0);expect(h.product.execution.destroyedEnvironmentIds.length).toBeGreaterThan(0);
  },180000);
  it.each([
    ['broken navigation','<><header><a href="/missing">Missing page</a></header><main><h2>Home</h2><p>Real content.</p></main></>','generation.primary-navigation'],
    ['missing primary fragment','<><header><a href="#missing-primary-section">Section</a></header><main><h2>Home</h2><p>Real content.</p></main></>','generation.primary-navigation'],
    ['blank page','null','generation.meaningful-content'],
    ['unsafe link','<main><h2>Home</h2><p>Real content.</p><a href="javascript:evil()">Unsafe</a></main>','internal-links'],
    ['interaction crash','<main><h2>Home</h2><p>Real content.</p><button onClick={()=>{throw new Error("Actual browser crash")}}>Crash</button></main>','runtime.page-error'],
    ['unexpected network submission','<main><h2>Home</h2><p>Real content.</p><button onClick={()=>{void fetch("https://offline-forbidden.invalid/submission")}}>Submit</button></main>','network.failed-request'],
  ])('rejects %s without charging, committing current source or spending a requirement repair call',async(_name,jsx,checkId)=>{
    const h=await harness(jsx);const blockingFindings:unknown=expect.arrayContaining([expect.objectContaining({checkId})]);await expect(h.product.pipeline.generate(h.request)).rejects.toMatchObject({code:'VALIDATION_FAILED',metadata:{failureStage:'BROWSER_QA',blockingFindings}});
    expect(h.requests).toHaveLength(1);expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();const projects=await h.product.projects.listByOwner(h.request.userId);expect(projects.items.every(project=>!project.latestVersionId)).toBe(true);
    expect(h.product.browserQA.activeBrowserCount).toBe(0);expect(h.product.execution.destroyedEnvironmentIds.length).toBeGreaterThan(0);
  },180000);
  it('keeps compiler/build failure blocking with the existing single repair allowance',async()=>{
    const h=await harness(home,'export function App(){const value:number="invalid";return <main><h1>Build fixture</h1><p>{value}</p></main>}');
    await expect(h.product.pipeline.generate(h.request)).rejects.toMatchObject({code:'REPAIR_LIMIT_REACHED'});expect(h.requests).toHaveLength(2);expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    const projects=await h.product.projects.listByOwner(h.request.userId);expect(projects.items.every(project=>!project.latestVersionId)).toBe(true);
  },180000);
});
