import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { DeterministicRequirementsPlanner } from "../src/planning/planning.js";
import { LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import type { UserId } from "../src/shared/types.js";
import type { BuildRepairEvidence } from "../src/cli/runtime/build-repair-patch-resolver.js";
import type { SiteCoderFileBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { compilerFind, compilerReplacement, vertexBundle, vertexPages, vertexPrompt } from "./fixtures/build-repair-sites.js";

const parent = resolve(".sites-runtime/build-repair-offline-tests"), roots: string[] = [];
const fixtureProviderId = "offline-build-repair-fixture";
const digest: unknown = expect.stringMatching(/^[a-f0-9]{64}$/);
const compilerDiagnostic: unknown = expect.stringContaining("TS2322");
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep)) throw new Error("Unsafe test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function harness(candidate = vertexBundle, repair: (request: AgentRequest) => unknown = () => ({ patches: [{ path: "src/App.tsx", find: compilerFind, replace: compilerReplacement }] })) {
  vi.stubEnv("npm_config_offline", "true");
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const requests: AgentRequest[] = [];
  const provider = new MockAgentProvider({ customResponse: request => {
    requests.push(request);
    const isRepair = request.responseContract?.type === "JSON_SCHEMA" && request.responseContract.name === "BuildRepairPatchBundle";
    return { id: "offline-vertex", model: request.model, message: { role: "assistant", content: JSON.stringify(isRepair ? repair(request) : candidate) },
      toolCalls: [], usage: { inputTokens: 100, outputTokens: 120 }, latencyMs: 0, finishReason: "stop" };
  } });
  // Exercise the normal authorization/finalization path using injected test
  // doubles. The reserved mock-agent identifier intentionally bypasses billing.
  Object.defineProperty(provider, "id", { value: fixtureProviderId });
  const registry = new AgentProviderRegistry(); registry.register(provider);
  const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn(async (job: SiteJob): Promise<SiteJob> => {
    const charged: SiteJob = { ...job, billingStatus: "CHARGED", creditsCharged: 1 };
    // The real billing service persists accounting itself. Mirror that ownership
    // in the in-memory double; no shared quota or credit formula is involved.
    await product.jobs.save(charged);
    return charged;
  }) };
  const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics"));
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry,
    orchestrationAgent: provider, billing: billing as unknown as SiteCreditBillingService, failedCandidateEvidence: diagnostics });
  // Supply the test's explicit five-page deterministic plan. The production
  // planning/classification rules, agents, inference limits and QA are unchanged.
  const requirements = await new DeterministicRequirementsPlanner().plan(vertexPrompt);
  vi.spyOn(DeterministicRequirementsPlanner.prototype, "plan").mockResolvedValue({ ...requirements, pages: vertexPages });
  return { product, provider, requests, billing, diagnostics, root };
}
const request = { userId: "offline-vertex-owner" as UserId, prompt: vertexPrompt, planningMode: "deterministic" as const,
  agentProvider: fixtureProviderId, browserQAEnabled: true, retainPreview: true };

describe("Real scratch pipeline, compiler repair and unchanged QA gates", () => {
  it("repairs an actual TS2322 failure after deterministic autofixes, builds and passes all five routes at all three viewports", async () => {
    const candidate = { ...vertexBundle, files: vertexBundle.files.map(file => file.path === "src/App.tsx"
      ? { ...file, content: file.content.replace('"./StudioFooter"', '"./StudioFooter.js"').replaceAll("\n", "\r\n") } : file) };
    const h = await harness(candidate, repairRequest => {
      const context = repairRequest.messages[0]!.content;
      expect(context).toContain("TS2322"); expect(context).toContain("Type 'string' is not assignable to type 'number'");
      expect(context).toContain('import { StudioFooter } from "./StudioFooter";');
      expect(context).not.toContain('"./StudioFooter.js"');
      expect(context).toMatch(/Source revision: [a-f0-9]{64}/);
      expect(context).toContain("unique, contiguous verbatim anchor");
      return { patches: [{ path: ".\\src\\App.tsx", find: 'import "./vertex.css";\n' + compilerFind,
        replace: 'import "./vertex.css";\n' + compilerReplacement }] };
    });
    const result = await h.product.pipeline.generate(request);
    try {
      expect(h.requests).toHaveLength(2);
      expect(result.inference).toMatchObject({ logicalRequests: 2, physicalRequests: 2, retries: 0 });
      expect(result.inference?.stages.GENERATE_SITE.logicalRequests).toBe(1);
      expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(1);
      expect(result.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(0);
      expect(result.build.success).toBe(true); expect(result.completion?.accepted).toBe(true);
      await writeFile(join(parent, "vertex-qa-report.json"), JSON.stringify({ kind: "OFFLINE_MOCK_PROVIDER_REAL_BUILD_QA", createdAt: new Date().toISOString(),
        build: result.build, completion: result.completion, inference: result.inference, report: result.browserQA }, null, 2));
      console.info("[offline-vertex-qa]", JSON.stringify({ status: result.browserQA?.status, routes: result.browserQA?.routes,
        findings: result.browserQA?.checks.filter(check => check.status === "FAIL").map(check => ({ check: check.checkId, severity: check.severity, route: check.route, viewport: check.viewport?.id, message: check.message })) }));
      expect(result.browserQA?.status).toBe("PASS");
      expect(result.browserQA?.checks.filter(check => check.status === "FAIL" && check.severity === "ERROR")).toEqual([]);
      expect(new Set(result.browserQA?.checks.map(check => check.route))).toEqual(new Set(vertexPages.map(page => page.path)));
      expect(new Set(result.browserQA?.checks.map(check => check.viewport?.id))).toEqual(new Set(["DESKTOP", "TABLET", "MOBILE"]));
      expect(result.browserQA?.checks.filter(check => check.checkId === "runtime.page-error" && check.status === "FAIL")).toEqual([]);
      const source = JSON.parse(Buffer.from((await h.product.artifacts.get(result.sourceArtifactRef))!).toString()) as { files: Record<string, string> };
      expect(source.files["src/App.tsx"]).toContain(compilerReplacement);
      expect(source.files["src/StudioFooter.tsx"]).toBe(vertexBundle.files.find(file => file.path === "src/StudioFooter.tsx")!.content);
      expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
      expect((await h.product.versions.listBySite(result.siteId)).items).toHaveLength(1);
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
      expect(await h.product.jobs.getById(result.jobId)).toMatchObject({ billingStatus: "CHARGED", creditsCharged: 1 });
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(result.preview.url!, { waitUntil: "networkidle" });
          expect(await page.getByRole("heading", { name: "Vertex AI Studio", exact: true }).isVisible()).toBe(true);
          await page.getByRole("button", { name: "Menu", exact: true }).click();
          await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Services", exact: true }).click();
          await page.getByRole("tab", { name: "Design", exact: true }).click();
          expect(await page.getByRole("tabpanel").filter({ visible: true }).innerText()).toContain("Accessible digital design");
          await page.goto(new URL("/our-work", result.preview.url).toString());
          await page.getByLabel("Project category", { exact: true }).selectOption("Design");
          expect(await page.locator("[data-project]").count()).toBe(1);
          await page.getByRole("button", { name: "View Canvas Lab", exact: true }).click();
          expect(await page.getByRole("dialog", { name: "View Canvas Lab" }).isVisible()).toBe(true);
          await page.getByRole("button", { name: "Close dialog", exact: true }).click();
          await page.goto(new URL("/contact", result.preview.url).toString());
          const form = page.getByRole("form", { name: "Studio enquiry" });
          await form.getByRole("button", { name: "Send demo message" }).click();
          expect(await form.getByRole("status").count()).toBe(0);
          await form.getByLabel("Name", { exact: true }).fill("Offline visitor");
          await form.getByLabel("Email", { exact: true }).fill("visitor@example.test");
          await form.getByLabel("Message", { exact: true }).fill("Test enquiry with no remote submission.");
          await form.getByRole("button", { name: "Send demo message" }).click();
          expect(await form.getByRole("status").innerText()).toContain("Nothing was sent");
          await page.goto(result.preview.url!); await page.getByText("How does a project begin?", { exact: true }).click();
          expect(await page.getByText("We begin with a discovery workshop and a shared delivery plan.", { exact: true }).isVisible()).toBe(true);
          await page.reload(); expect(await page.getByRole("heading", { name: "Vertex AI Studio", exact: true }).isVisible()).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    } finally { await h.product.execution.destroyEnvironment(result.preview.environmentId); }
  }, 240_000);

  it.each(["missing", "malformed", "unfixed"])("keeps the single repair budget, no successful billing and no current source after %s repair", async kind => {
    const h = await harness(vertexBundle, () => kind === "malformed" ? { patches: [{ path: "src/App.tsx", find: null, replace: "x" }] }
      : { patches: kind === "unfixed" ? [] : [{ path: "src/App.tsx", find: "const inventedByModel = 4;", replace: compilerReplacement }] });
    await expect(h.product.pipeline.generate({ ...request, retainPreview: false })).rejects.toMatchObject({
      code: kind === "malformed" ? "STRUCTURED_RESPONSE_SCHEMA_INVALID" : kind === "unfixed" ? "REPAIR_LIMIT_REACHED" : "VALIDATION_FAILED",
    });
    expect(h.requests).toHaveLength(2); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    const projects = await h.product.projects.listByOwner(request.userId);
    expect(projects.items).toHaveLength(1);
    expect(projects.items[0]).toMatchObject({ status: "DRAFT" });
    expect(projects.items[0]!.latestVersionId).toBeUndefined();
    const names = await readdir(h.diagnostics.root); expect(names).toHaveLength(1);
    const e = JSON.parse(await readFile(join(h.diagnostics.root, names[0]!), "utf8")) as {
      jobId: string; buildRepair: BuildRepairEvidence; validation: { failureStage: string; check: string }; source: { files: Record<string, string> };
    };
    expect(e.buildRepair).toMatchObject({ attempt: 1, kind: "build", sourceRevision: digest,
      contextDigest: digest, billingState: "NOT_FINALIZED", initialDiagnostics: compilerDiagnostic });
    expect(e.source.files["src/App.tsx"]).toContain(compilerFind);
    if (kind === "missing") {
      expect(e.validation.failureStage).toBe("PATCH_APPLICATION");
      expect(e.buildRepair.patches[0]).toMatchObject({ path: "src/App.tsx", matchCount: 0, resolution: "MISSING_FIND_TEXT", findDigest: digest });
    }
    if (kind === "malformed") expect(e.validation).toMatchObject({ failureStage: "PATCH_APPLICATION", check: "build-repair.response" });
    const job = await h.product.jobs.getById(e.jobId as SiteJob["id"]);
    expect(job).toMatchObject({ status: "FAILED", billingStatus: "NOT_CHARGED", creditsCharged: 0, logicalCalls: 2, physicalRequests: 2, websiteGenerated: false });
    expect((await h.product.versions.listBySite(job!.siteId)).items).toHaveLength(0);
  }, 150_000);

  it("replays the retained original candidate's repair trigger without inventing the missing live patch", async () => {
    const file = resolve(".sites-runtime/playground/diagnostics/failed-candidates/candidate-a1576abc8a89adee615f7c73946d4c30.json");
    const raw = await readFile(file, "utf8").catch(() => undefined);
    // Expiring private development evidence is not a committed test dependency.
    if (!raw) return;
    const e = JSON.parse(raw) as { jobId: string; source: { files: Record<string, string>; omittedFiles: number; redactedFiles: number } };
    expect(e.jobId).toBe("2b1ab8d1-3e0f-4cca-832c-3f3e5381beb2");
    expect(e.source.omittedFiles + e.source.redactedFiles).toBe(0);
    const candidate: SiteCoderFileBundle = { siteName: "Vertex AI Studio", files: Object.entries(e.source.files).map(([path, content]) => ({ path, content })) };
    const h = await harness(candidate, () => ({ patches: [{ path: "src/App.tsx", find: "/* synthetic absent anchor; original repair response unavailable */", replace: "" }] }));
    await expect(h.product.pipeline.generate({ ...request, retainPreview: false })).rejects.toMatchObject({ metadata: { failureStage: "PATCH_APPLICATION" } });
    expect(h.requests).toHaveLength(2);
    const repairContext = h.requests[1]!.messages[0]!.content;
    expect(repairContext).toContain("src/App.tsx:44 has a button without an action");
    expect(repairContext).toContain("src/App.tsx:56 has a button without an action");
    expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    const names = await readdir(h.diagnostics.root);
    const retained = JSON.parse(await readFile(join(h.diagnostics.root, names[0]!), "utf8")) as { buildRepair: BuildRepairEvidence };
    expect(retained.buildRepair.kind).toBe("interaction");
    expect(retained.buildRepair.initialDiagnostics).not.toContain("TS2322");
  }, 120_000);
});
