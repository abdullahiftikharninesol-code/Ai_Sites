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
const repairAccordion = { patches: [{ path: "src/App.tsx", find: "setSelected(index);setVisible(index)", replace: "setSelected(value=>value===index?-1:index);setVisible(value=>value===index?-1:index)" }] };
async function expectUncommitted(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
  const projects = await h.product.projects.listByOwner(request.userId);
  expect(projects.items).toHaveLength(1); expect(projects.items[0]!.latestVersionId).toBeUndefined();
  expect((await h.product.versions.listBySite(projects.items[0]!.id)).items).toHaveLength(0);
}

describe("One shared generation repair allowance with real build and complete Browser QA", () => {
  it("rejects contradictory functionality before creating a project or calling any provider", async () => {
    const h = await harness(routeAwareFixture(), () => ({ patches: [] }));
    await expect(h.product.pipeline.generate({ ...request, prompt: "Add a shopping cart. Do not include a shopping cart." })).rejects.toMatchObject({ code: "UNSUPPORTED_SITE_REQUIREMENT" });
    expect(h.requests).toHaveLength(0); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    expect((await h.product.projects.listByOwner(request.userId)).items).toHaveLength(0);
  });
  it("builds and verifies the live no-main/custom-panel/div-menu pattern with a long prompt", async () => {
    const base = routeAwareFixture("/work", "custom-accordion");
    const candidate = { ...base, files: base.files.map(file => file.path !== "src/App.tsx" ? file : { ...file, content: file.content
      .replace("MobileNav, Tabs,", "SiteLink, Tabs,")
      .replace('<MobileNav items={pages}/>', '<CustomMenu/>')
      .replace('<main>{path', '<div className="page-content">{path').replace('</main><StudioFooter', '</div><StudioFooter')
      .replace(/function ServiceTabs\(\)\{[^\n]+/, 'function ServiceTabs(){const [index,setIndex]=useState(0);return <section><div role="tablist">{["Strategy","Design"].map((label,i)=><button key={label} role="tab" aria-selected={index===i} onClick={()=>setIndex(i)}>{label}</button>)}</div><div>{index?<p>Accessible digital design and interactive prototypes.</p>:<p>Research, discovery and a measurable delivery plan.</p>}</div></section>}')
      + '\nfunction CustomMenu(){const [open,setOpen]=useState(false);return <><button aria-label="Open navigation" aria-expanded={open} onClick={()=>setOpen(!open)}>Menu</button>{open&&<div>{pages.map(item=><SiteLink key={item.href} href={item.href} onClick={()=>setOpen(false)}>{item.label}</SiteLink>)}</div>}</>}\n' }) };
    const h = await harness(candidate, () => { throw new Error("Working controls must not spend repair budget"); });
    const result = await h.product.pipeline.generate({ ...request, prompt: "Use refined spacing and consistent editorial typography. ".repeat(100) + "\n" + request.prompt });
    expect(h.requests).toHaveLength(1); expect(result.build.success).toBe(true);
    expect(h.requests[0]!.messages.map(message => message.content).join("\n")).toContain("PageContent({children,className?})");
    expect(result.browserQA?.status).toBe("PASS"); expect(result.browserQA?.checks.filter(check => check.status === "FAIL")).toEqual([]);
    expect(new Set(result.browserQA?.checks.map(check => check.viewport?.id))).toEqual(new Set(["DESKTOP", "TABLET", "MOBILE"]));
    expect(new Set(result.browserQA?.routes)).toEqual(new Set(["/", "/services", "/work", "/about", "/contact"]));
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
    const saved = JSON.parse(Buffer.from((await h.product.artifacts.get(result.sourceArtifactRef))!).toString()) as { files: Record<string, string> };
    expect(saved.files["src/App.tsx"]).toBe(candidate.files.find(file => file.path === "src/App.tsx")!.content);
  }, 240_000);
  it("repairs proven accordion behavior and revalidates all routes without an extra role or third request", async () => {
    const h = await harness(routeAwareFixture("/work", "never-close-accordion"), repairRequest => {
      const context = repairRequest.messages[0]!.content;
      expect(context).toContain("functional.requirements"); expect(context).toContain("accordion");
      expect(context).toContain("src/App.tsx:"); expect(context).toContain("Functional capability contract");
      return repairAccordion;
    });
    const result = await h.product.pipeline.generate(request);
    expect(h.requests).toHaveLength(2); expect(result.inference).toMatchObject({ logicalRequests: 2, physicalRequests: 2, retries: 0 });
    expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(1); expect(result.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(0);
    expect(result.build.success).toBe(true); expect(result.browserQA?.status).toBe("PASS");
    expect(result.browserQA?.checks.filter(check => check.status === "FAIL")).toEqual([]);
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect((await h.product.versions.listBySite(result.siteId)).items).toHaveLength(1);
  }, 240_000);
  it("does not create another repair slot when compiler repair was already spent", async () => {
    const source = routeAwareFixture("/work", "never-close-accordion");
    const candidate = { ...source, files: source.files.map(file => ({ ...file, content: file.path === "src/App.tsx" ? file.content.replace(compilerReplacement, compilerFind) : file.content })) };
    const h = await harness(candidate, () => ({ patches: [{ path: "src/App.tsx", find: compilerFind, replace: compilerReplacement }] }));
    await expect(h.product.pipeline.generate(request)).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { failureStage: "BROWSER_QA" } });
    expect(h.requests).toHaveLength(2); await expectUncommitted(h);
  }, 240_000);
  it("rejects an unsuccessful functional repair without a third call or successful billing", async () => {
    const h = await harness(routeAwareFixture("/work", "never-close-accordion"), () => ({ patches: [] }));
    await expect(h.product.pipeline.generate(request)).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { failureStage: "BROWSER_QA" } });
    expect(h.requests).toHaveLength(2); await expectUncommitted(h);
    expect(h.events.some(event => event.failureStage === "BROWSER_QA")).toBe(true);
    expect(h.events.some(event => event.failureStage === "STATIC_VALIDATION")).toBe(false);
    const files = await readdir(h.diagnostics.root); expect(files).toHaveLength(2);
    const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(join(h.diagnostics.root, file), "utf8")) as {
      jobId: SiteJob["id"]; generationAttempt: number; buildRepair?: { kind: string; attempt: number };
    }));
    const evidence = reports.find(report => report.generationAttempt === 2)!;
    expect(evidence.buildRepair).toMatchObject({ kind: "functional", attempt: 1 });
    expect(await h.product.jobs.getById(evidence.jobId)).toMatchObject({ status: "FAILED", billingStatus: "NOT_CHARGED", creditsCharged: 0, physicalRequests: 2 });
  }, 240_000);
  it("repairs a proven missing page-local form before build within the same allowance", async () => {
    const base = routeAwareFixture();
    const candidate = { ...base, files: base.files.map(file => ({ ...file, content: file.path === "src/App.tsx" ? file.content.replace('<DemoForm label="Studio enquiry"/>', "") : file.content })) };
    const h = await harness(candidate, request => {
      expect(request.messages[0]!.content).toContain("Required form has no implemented control");
      return { patches: [{ path: "src/App.tsx", find: '<p>Try our local enquiry demonstration.</p>', replace: '<p>Try our local enquiry demonstration.</p><DemoForm label="Studio enquiry"/>' }] };
    });
    const result = await h.product.pipeline.generate(request);
    expect(h.requests).toHaveLength(2); expect(result.build.success).toBe(true); expect(result.browserQA?.status).toBe("PASS");
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
  }, 240_000);
});
