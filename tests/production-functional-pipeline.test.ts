import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { UserId } from "../src/shared/types.js";
import type { SiteCoderFileBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { routeAwareFixture, routeAwarePrompt } from "./fixtures/route-aware-sites.js";
import { compilerFind, compilerReplacement } from "./fixtures/build-repair-sites.js";
import type { GenerationDevelopmentEvent } from "../src/sites/generation/generation-development-telemetry.js";

const parent = resolve(".sites-runtime/production-functional-tests"), roots: string[] = [];
const providerId = "offline-production-functional";
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) { if (!root.startsWith(parent + sep)) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); }
});
async function harness(candidate: SiteCoderFileBundle, repair: (request: AgentRequest) => unknown) {
  vi.stubEnv("npm_config_offline", "true");
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const requests: AgentRequest[] = [];
  const provider = new MockAgentProvider({ customResponse: request => {
    requests.push(request);
    const repairing = request.responseContract?.type === "JSON_SCHEMA" && request.responseContract.name === "BuildRepairPatchBundle";
    return { id: "offline-functional", model: request.model, message: { role: "assistant", content: JSON.stringify(repairing ? repair(request) : candidate) },
      toolCalls: [], usage: { inputTokens: 100, outputTokens: 120 }, latencyMs: 0, finishReason: "stop" };
  } });
  Object.defineProperty(provider, "id", { value: providerId }); const registry = new AgentProviderRegistry(); registry.register(provider);
  const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn(async (job: SiteJob): Promise<SiteJob> => {
    const charged: SiteJob = { ...job, billingStatus: "CHARGED", creditsCharged: 1 }; await product.jobs.save(charged); return charged;
  }) };
  const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics"));
  const events: GenerationDevelopmentEvent[] = [];
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry,
    orchestrationAgent: provider, billing: billing as unknown as SiteCreditBillingService, failedCandidateEvidence: diagnostics,
    developmentTelemetry: { record: event => { events.push(event); } } });
  return { product, requests, billing, diagnostics, events };
}
const request = { userId: "offline-functional-owner" as UserId, prompt: routeAwarePrompt, planningMode: "deterministic" as const,
  agentProvider: providerId, browserQAEnabled: false, retainPreview: false };
async function expectUncommitted(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
  const projects = await h.product.projects.listByOwner(request.userId);
  expect(projects.items).toHaveLength(1); expect(projects.items[0]!.latestVersionId).toBeUndefined();
  expect((await h.product.versions.listBySite(projects.items[0]!.id)).items).toHaveLength(0);
}

describe("One shared generation repair allowance with real build and complete Browser QA", () => {
  it.each(["Add a shopping cart. Do not include a shopping cart.", "Build a live payment processing system."])("rejects contradictory or unsupported functionality before creating a project or calling any provider: %s", async prompt => {
    const h = await harness(routeAwareFixture(), () => ({ patches: [] }));
    await expect(h.product.pipeline.generate({ ...request, prompt })).rejects.toMatchObject({ code: "UNSUPPORTED_SITE_REQUIREMENT" });
    expect(h.requests).toHaveLength(0); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    expect((await h.product.projects.listByOwner(request.userId)).items).toHaveLength(0);
  });
  it("builds and verifies the live no-main/custom-panel/div-menu pattern with a long prompt", async () => {
    const base = routeAwareFixture("/work", "custom-accordion");
    const candidate = { ...base, files: base.files.map(file => file.path !== "src/App.tsx" ? file : { ...file, content: file.content
      .replace("MobileNav, Tabs,", "SiteLink, Tabs,")
      .replace('<MobileNav items={pages}/>', '<CustomMenu/>')
      .replace('function App(){const path', 'function App(){const[dark,setDark]=useState(false);const path')
      .replace('<header>', '<header><button className="theme-toggle" aria-pressed={dark} onClick={()=>setDark(!dark)}>{dark?"Light mode":"Dark mode"}</button>')
      .replace('<main>{path', '<div className="page-content">{path').replace('</main><StudioFooter', '</div><StudioFooter')
      .replace(/function ServiceTabs\(\)\{[^\n]+/, 'function ServiceTabs(){const [index,setIndex]=useState(0);return <section><div role="tablist">{["Strategy","Design"].map((label,i)=><button key={label} role="tab" aria-selected={index===i} onClick={()=>setIndex(i)}>{label}</button>)}</div><div>{index?<p>Accessible digital design and interactive prototypes.</p>:<p>Research, discovery and a measurable delivery plan.</p>}</div></section>}')
      + '\nfunction CustomMenu(){const [open,setOpen]=useState(false);return <><button aria-label="Open navigation" aria-expanded={open} onClick={()=>setOpen(!open)}>Menu</button>{open&&<div>{pages.map(item=><SiteLink key={item.href} href={item.href} onClick={()=>setOpen(false)}>{item.label}</SiteLink>)}</div>}</>}\n' }) };
    const h = await harness(candidate, () => { throw new Error("Working controls must not spend repair budget"); });
    const result = await h.product.pipeline.generate({ ...request, prompt: "Use refined spacing and consistent editorial typography. ".repeat(100) + "\n" + request.prompt });
    expect(h.requests).toHaveLength(1); expect(result.build.success).toBe(true);
    expect(h.requests[0]!.messages.map(message => message.content).join("\n")).toContain("PageContent({children,className?})");
    expect(h.requests[0]!.messages.map(message => message.content).join("\n")).toContain("Sites already supplies a theme switch");
    expect(result.browserQA?.status).not.toBe("FAIL"); expect(result.browserQA?.checks.filter(check => check.status === "FAIL" && check.severity === "ERROR")).toEqual([]);
    expect(new Set(result.browserQA?.checks.map(check => check.viewport?.id))).toEqual(new Set(["DESKTOP", "TABLET", "MOBILE"]));
    expect(new Set(result.browserQA?.routes)).toEqual(new Set(["/", "/services", "/work", "/about", "/contact"]));
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
    const saved = JSON.parse(Buffer.from((await h.product.artifacts.get(result.sourceArtifactRef))!).toString()) as { files: Record<string, string> };
    expect(saved.files["src/App.tsx"]).toBe(candidate.files.find(file => file.path === "src/App.tsx")!.content);
  }, 240_000);
  it("accepts incomplete accordion behavior without repair or blocking persistence",async()=>{
    const h=await harness(routeAwareFixture("/work","never-close-accordion"),()=>{throw new Error("Minor features must not spend repair budget")});const result=await h.product.pipeline.generate(request);
    expect(h.requests).toHaveLength(1);expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);expect(result.build.success).toBe(true);expect(result.browserQA?.status).not.toBe("FAIL");
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();expect((await h.product.versions.listBySite(result.siteId)).items).toHaveLength(1);
  },240000);
  it("does not create another repair slot when compiler repair was already spent", async () => {
    const source = routeAwareFixture("/work", "never-close-accordion");
    const candidate = { ...source, files: source.files.map(file => ({ ...file, content: file.path === "src/App.tsx" ? file.content.replace(compilerReplacement, compilerFind) : file.content })) };
    const h = await harness(candidate, () => ({ patches: [{ path: "src/App.tsx", find: compilerFind, replace: compilerReplacement }] }));
    const result=await h.product.pipeline.generate(request);
    expect(result.build.success).toBe(true);expect(result.browserQA?.status).not.toBe("FAIL");
    expect(h.requests).toHaveLength(2);expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
  }, 240_000);
  it("retains an actual browser crash without repair, current-source commit or successful billing",async()=>{
    const base=routeAwareFixture();const candidate={...base,files:base.files.map(file=>file.path==='src/App.tsx'?{...file,content:file.content.replace('function App(){','function App(){throw new Error("Actual application crash");')}:file)};
    const h=await harness(candidate,()=>{throw new Error("Browser crashes must not trigger provider retries")});
    await expect(h.product.pipeline.generate(request)).rejects.toMatchObject({code:"VALIDATION_FAILED",metadata:{failureStage:"BROWSER_QA"}});expect(h.requests).toHaveLength(1);await expectUncommitted(h);
    const files=await readdir(h.diagnostics.root);expect(files).toHaveLength(1);const evidence=JSON.parse(await readFile(join(h.diagnostics.root,files[0]!),"utf8")) as {jobId:SiteJob["id"]};
    expect(await h.product.jobs.getById(evidence.jobId)).toMatchObject({status:"FAILED",billingStatus:"NOT_CHARGED",creditsCharged:0,physicalRequests:1});
  },240000);
  it("records a missing page-local form without invoking repair",async()=>{
    const base=routeAwareFixture();const candidate={...base,files:base.files.map(file=>({...file,content:file.path==='src/App.tsx'?file.content.replace('<DemoForm label="Studio enquiry"/>',''):file.content}))};
    const h=await harness(candidate,()=>{throw new Error("Missing features must not invoke repair")});const result=await h.product.pipeline.generate(request);
    expect(h.requests).toHaveLength(1);expect(result.build.success).toBe(true);expect(result.browserQA?.status).not.toBe("FAIL");expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect(result.browserQA?.checks.some(check=>check.checkId==='generation.requirement-advisories'&&check.status==='WARNING')).toBe(true);
  },240000);
  it("does not spend model repair on a real pointer obstruction and retains classified failure evidence", async () => {
    // Isolate the actual fixed overlapping-control pattern; five unrelated
    // routes are already covered by the other real build/QA fixtures.
    const candidate = { files: [{ path: "src/App.tsx", content: 'import{useState}from"react";export function App(){const[dark,setDark]=useState(false);return <><main><h1>Pointer fixture</h1><p>Real content with a noncritical overlapping control.</p></main><button style={{position:"fixed",bottom:10,right:10,zIndex:101,width:50,height:50}} onClick={()=>setDark(!dark)}>{dark?"Light mode":"Dark mode"}</button><button aria-label="Cover toggle" style={{position:"fixed",bottom:10,right:10,zIndex:102,width:50,height:50}} onClick={()=>setDark(!dark)}><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg></button></>}' }] };
    const h = await harness(candidate, () => { throw new Error("Actionability failure must never request model repair"); });
    const result=await h.product.pipeline.generate(request);expect(h.requests).toHaveLength(1);expect(result.browserQA?.status).toBe("PASS_WITH_WARNINGS");expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect(result.browserQA?.checks.some(check=>check.failureKind==='ACTIONABILITY_TIMEOUT'&&check.severity==='WARNING')).toBe(true);
  }, 240_000);
});
