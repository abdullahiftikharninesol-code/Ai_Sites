import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { UserId } from "../src/shared/types.js";
import { routeAwareFixture, routeAwarePrompt, type RouteFixtureKind } from "./fixtures/route-aware-sites.js";

const parent = resolve(".sites-runtime/route-aware-tests"), roots: string[] = [];
const providerId = "offline-route-fixture";
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep)) throw new Error("Unsafe offline cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function harness(route = "/work", kind: RouteFixtureKind = "valid") {
  vi.stubEnv("npm_config_offline", "true");
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const requests: AgentRequest[] = [];
  const provider = new MockAgentProvider({ customResponse: request => {
    requests.push(request);
    const repair = request.responseContract?.type === "JSON_SCHEMA" && request.responseContract.name === "BuildRepairPatchBundle";
    return { id: "offline-route", model: request.model, message: { role: "assistant", content: JSON.stringify(repair ? { patches: [] } : routeAwareFixture(route, kind)) },
      toolCalls: [], usage: { inputTokens: 100, outputTokens: 120 }, latencyMs: 0, finishReason: "stop" };
  } });
  Object.defineProperty(provider, "id", { value: providerId });
  const registry = new AgentProviderRegistry(); registry.register(provider);
  const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn(async (job: SiteJob): Promise<SiteJob> => {
    const charged: SiteJob = { ...job, billingStatus: "CHARGED", creditsCharged: 1 };
    await product.jobs.save(charged); return charged;
  }) };
  const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics"));
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry,
    orchestrationAgent: provider, billing: billing as unknown as SiteCreditBillingService, failedCandidateEvidence: diagnostics });
  const runQA = product.browserQA.run.bind(product.browserQA);
  vi.spyOn(product.browserQA, "run").mockImplementation(async input => {
    const report = await runQA(input);
    await writeFile(join(parent, `qa-${kind}.json`), JSON.stringify(report, null, 2));
    console.info("[offline-route-report]", JSON.stringify({ route, status: report.status, failures: report.checks.filter(check => check.status === "FAIL").map(check => ({ id: check.checkId, route: check.route, viewport: check.viewport?.id, severity: check.severity, message: check.message })) }));
    return report;
  });
  // Actual deterministic planners, production runtime/build/QA and isolated
  // in-memory repositories. No planner override or external provider exists.
  return { product, requests, billing, diagnostics };
}
// Live c2d47dc9 regression: descriptive business-contact copy must not require
// an invented #contact wrapper around the form. Exercise every existing fixture
// with this wording through the actual planners, runtime, build and Browser QA.
const request = { userId: "offline-route-owner" as UserId, prompt: routeAwarePrompt.replace("Validated contact form with honest local demo feedback.", "Validated contact form with honest local demo feedback. Include a project inquiry summary and business contact section."), planningMode: "deterministic" as const,
  agentProvider: providerId, browserQAEnabled: true, retainPreview: true };

describe("Production route-aware generation with offline output and real build/QA", () => {
  it("accepts a long-prompt custom React FAQ and requires behavior QA even when optional QA is disabled", async () => {
    const h = await harness("/work", "custom-accordion");
    const text = "Use generous spacing, restrained typography and consistent visual hierarchy. ".repeat(75) + "\n" + request.prompt;
    const result = await h.product.pipeline.generate({ ...request, prompt: text, browserQAEnabled: false });
    try {
      expect(result.build.success).toBe(true); expect(result.browserQA?.status).not.toBe("FAIL");
      expect(result.browserQA?.checks.filter(check => check.status === "FAIL" && check.severity === "ERROR")).toEqual([]);
      const navigation=result.browserQA!.checks.filter(check=>check.checkId==='generation.primary-navigation'&&check.route==='/');expect(navigation).toHaveLength(3);expect(navigation.every(check=>check.status==='PASS')).toBe(true);
      expect(h.requests).toHaveLength(1); expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);
      expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
      expect((await h.product.versions.listBySite(result.siteId)).items).toHaveLength(1);
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    } finally { await h.product.execution.destroyEnvironment(result.preview.environmentId); }
  }, 240_000);
  it.each(["decorative-accordion","never-close-accordion"] as const)("accepts %s as a non-gating feature without repair",async kind=>{
    const h=await harness("/work",kind);const result=await h.product.pipeline.generate({...request,browserQAEnabled:false,retainPreview:false});
    expect(result.browserQA?.status).not.toBe('FAIL');expect(h.requests).toHaveLength(1);expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
  },240000);
  it.each([["/work", "valid"], ["/portfolio", "buttons"], ["/projects", "tabs"]] as const)("accepts five pages with %s and %s filtering without homepage filtering", async (route, kind) => {
    const h = await harness(route, kind);
    const result = await h.product.pipeline.generate(request);
    try {
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.messages.map(message => message.content).join("\n")).toContain("PAGE: Our Work");
      expect(result.inference).toMatchObject({ logicalRequests: 1, physicalRequests: 1, retries: 0 });
      expect(result.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(0);
      expect(result.build.success).toBe(true); expect(result.completion?.accepted).toBe(true);
      const qa = result.browserQA!;
      await writeFile(join(parent, `qa-${kind}.json`), JSON.stringify({ kind: "OFFLINE_MOCK_REAL_BUILD_QA", build: result.build, completion: result.completion, inference: result.inference, qa }, null, 2));
      console.info("[offline-route-qa]", JSON.stringify({ route, status: qa.status, failures: qa.checks.filter(check => check.status === "FAIL") }));
      expect(qa.status).not.toBe("FAIL");
      expect(qa.checks.filter(check => check.status === "FAIL" && check.severity === "ERROR")).toEqual([]);
      expect(new Set(qa.routes)).toEqual(new Set(["/", "/services", route, "/about", "/contact"]));
      for (const viewport of ["DESKTOP", "TABLET", "MOBILE"]) {
        const checks = qa.checks.filter(check => check.viewport?.id === viewport);
        expect(checks.some(check=>check.checkId==='generation.primary-navigation'&&check.status==='PASS')).toBe(true);
      }
      expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
      expect((await h.product.versions.listBySite(result.siteId)).items).toHaveLength(1);
      const saved = JSON.parse(Buffer.from((await h.product.artifacts.get(result.sourceArtifactRef))!).toString()) as { files: Record<string, string> };
      expect(saved.files["src/App.tsx"]).toContain(`path===${JSON.stringify(route)}`);
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
      expect(await h.product.jobs.getById(result.jobId)).toMatchObject({ billingStatus: "CHARGED", creditsCharged: 1 });
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(result.preview.url!, { waitUntil: "networkidle" });
          expect(await page.getByRole("combobox").count()).toBe(0);
          await page.getByRole("button", { name: "Menu", exact: true }).click();
          await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Our Work", exact: true }).click();
          expect(new URL(page.url()).pathname).toBe(route);
          if (kind === "valid") await page.getByLabel("Project category", { exact: true }).selectOption("Design");
          else await page.getByRole(kind === "tabs" ? "tab" : "button", { name: "Design", exact: true }).click();
          expect(await page.locator("[data-project]").count()).toBe(1);
          await page.getByRole("button", { name: "View Canvas Lab", exact: true }).click();
          expect(await page.getByRole("dialog").isVisible()).toBe(true);
          await page.getByRole("button", { name: "Close dialog", exact: true }).click();
          for (const path of ["/", "/services", route, "/about", "/contact"]) {
            await page.goto(new URL(path, result.preview.url).toString()); await page.reload();
            expect(await page.locator("main h1").isVisible()).toBe(true);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    } finally { await h.product.execution.destroyEnvironment(result.preview.environmentId); }
  }, 240_000);

  it.each(["missing","decorative"] as const)("accepts %s optional filter behavior without a requirement repair call",async kind=>{
    const h=await harness("/work",kind);const result=await h.product.pipeline.generate({...request,retainPreview:false});expect(result.browserQA?.status).not.toBe('FAIL');expect(h.requests).toHaveLength(1);expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
  },180000);
  it("rejects an actually linked missing route at Browser QA without accepting source or charging",async()=>{
    const h=await harness('/work','missing-route');await expect(h.product.pipeline.generate({...request,retainPreview:false})).rejects.toMatchObject({code:'VALIDATION_FAILED',metadata:{failureStage:'BROWSER_QA'}});
    expect(h.requests).toHaveLength(1);expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();const projects=await h.product.projects.listByOwner(request.userId);expect(projects.items[0]?.latestVersionId).toBeUndefined();
    const files=await readdir(h.diagnostics.root);expect(files).toHaveLength(1);const evidence=JSON.parse(await readFile(join(h.diagnostics.root,files[0]!),"utf8")) as {jobId:SiteJob['id']};expect(await h.product.jobs.getById(evidence.jobId)).toMatchObject({status:'FAILED',billingStatus:'NOT_CHARGED',creditsCharged:0,physicalRequests:1});
  },180000);
});
