import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import type { UserId } from "../src/shared/types.js";
import { complexFixtures, complexFixture } from "./fixtures/complex-generation-sites.js";
import { orbitQaFixtures } from "./fixtures/orbit-qa-failures.js";
import { createHash } from "node:crypto";
import { functionalRequirements } from "../src/sites/generation/functional-capabilities.js";
import { requestedPages } from "../src/sites/generation/requested-pages.js";

const parent = resolve(".sites-runtime/complex-release-tests"), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { if (!root.startsWith(parent + sep)) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); } });
async function harness(fixture = complexFixture("portfolio"), repair?: unknown) {
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const calls: AgentRequest[] = [];
  const provider = new MockAgentProvider({ customResponse: request => {
    calls.push(request); const repairing = request.responseContract?.type === "JSON_SCHEMA" && request.responseContract.name === "BuildRepairPatchBundle";
    return { id: "offline-complex", model: request.model, message: { role: "assistant", content: JSON.stringify(repairing ? repair ?? { patches: [] } : fixture.bundle) }, toolCalls: [], usage: { inputTokens: 100, outputTokens: 100 }, latencyMs: 0, finishReason: "stop" };
  } });
  Object.defineProperty(provider, "id", { value: "offline-complex" }); const registry = new AgentProviderRegistry(); registry.register(provider);
  const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn(async (job: unknown) => job) };
  const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics"));
  const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry, orchestrationAgent: provider, billing: billing as unknown as SiteCreditBillingService, failedCandidateEvidence: diagnostics });
  let buildMs = 0, qaMs = 0, portsClosed = false; const stages: string[] = [], previewUrls = new Set<string>();
  const execute = product.execution.executeCommand.bind(product.execution);
  vi.spyOn(product.execution, "executeCommand").mockImplementation(async (id, command) => { const result = await execute(id, command); if (command.args?.includes("build")) buildMs += result.durationMs; return result; });
  const runQA = product.browserQA.run.bind(product.browserQA);
  vi.spyOn(product.browserQA, "run").mockImplementation(async request => { previewUrls.add(request.target.baseUrl); const report = await runQA(request); qaMs += report.durationMs;
    if(fixture.id.startsWith('orbit-')){await mkdir(resolve('.sites-runtime/orbit-qa-proof'),{recursive:true});await writeFile(join(resolve('.sites-runtime/orbit-qa-proof'),fixture.id+'-latest-qa.json'),JSON.stringify(report,null,2));}
    for (const check of report.checks.filter(check => check.status === "FAIL")) stages.push(check.failureKind ?? check.checkId); return report; });
  const request = { userId: "offline-complex-owner" as UserId, outerRequestId: "11111111-2222-4333-8444-555555555555", prompt: fixture.prompt, planningMode: "deterministic" as const, agentProvider: provider.id, browserQAEnabled: true, retainPreview: false };
  async function verifyCleanup() {
    expect(product.browserQA.activeBrowserCount).toBe(0); expect(product.execution.destroyedEnvironmentIds.length).toBeGreaterThan(0);
    for (const url of previewUrls) expect(await new Promise<boolean>(done => { const target = new URL(url); const socket = createConnection({ host: target.hostname, port: Number(target.port) }); socket.setTimeout(800); socket.once("connect", () => { socket.destroy(); done(false); }); socket.once("error", () => done(true)); socket.once("timeout", () => { socket.destroy(); done(false); }); })).toBe(true);
    portsClosed = true;
  }
  async function metrics(outcome: string) { if (process.env.SITES_COMPLEX_METRICS_FILE) await appendFile(process.env.SITES_COMPLEX_METRICS_FILE, JSON.stringify({ fixture: fixture.id, outcome, buildMs, qaMs, failureCategories: stages, mockRequests: calls.length, browserCleanup: product.browserQA.activeBrowserCount === 0, portsClosed, environmentsDestroyed: product.execution.destroyedEnvironmentIds.length }) + "\n"); }
  return { product, diagnostics, calls, billing, request, verifyCleanup, metrics };
}

describe("Complex release real builds and responsive Browser QA", () => {
  it.each(orbitQaFixtures)("accepts the unchanged retained $id source without AI repair, with real build/QA and once-only mock billing",async fixture=>{
    expect(requestedPages(fixture.prompt).map(page=>page.path)).toEqual(['/','/features','/pricing','/resources','/contact']);
    expect([...functionalRequirements(fixture.prompt).capabilities].sort()).toEqual([...fixture.originalCapabilities].sort());
    expect(createHash('sha256').update(fixture.bundle.files.find(file=>file.path==='src/App.tsx')!.content).digest('hex')).toBe(fixture.originalAppDigest);
    const h=await harness(fixture);const result=await h.product.pipeline.generate(h.request);
    expect(result.build.success).toBe(true);expect(result.browserQA?.status).not.toBe('FAIL');
    expect(result.browserQA?.checks.filter(check=>check.status==='FAIL'&&check.severity==='ERROR')).toEqual([]);
    expect(result.browserQA?.checks.filter(check=>check.checkId==='functional.navigation'&&check.status==='FAIL')).toEqual([]);
    expect(result.browserQA?.checks.filter(check=>check.checkId==='runtime.page-error'&&check.status!=='PASS')).toEqual([]);
    expect(new Set(result.browserQA?.routes)).toEqual(new Set(['/','/features','/pricing','/resources','/contact']));
    expect(new Set(result.browserQA?.viewports.map(view=>view.id))).toEqual(new Set(['DESKTOP','TABLET','MOBILE']));
    expect(h.calls).toHaveLength(1);expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
    const saved=JSON.parse(Buffer.from((await h.product.artifacts.get(result.sourceArtifactRef))!).toString()) as {files:Record<string,string>};
    expect(saved.files['src/App.tsx']).toBe(fixture.bundle.files.find(file=>file.path==='src/App.tsx')!.content);
    if(fixture.id==='orbit-heading')expect(result.browserQA?.checks.some(check=>check.checkId==='accessibility-smoke'&&check.status==='WARNING'&&check.evidence?.some(e=>e.type==='element'&&e.accessibleName?.includes('primary level-one heading')))).toBe(true);
    await h.verifyCleanup();await h.metrics('PASS');
    await mkdir(resolve('.sites-runtime/orbit-qa-proof'),{recursive:true});await writeFile(join(resolve('.sites-runtime/orbit-qa-proof'),fixture.id+'.json'),JSON.stringify({kind:'EXACT_RETAINED_SOURCE_MOCK_PROVIDER_REAL_BUILD_QA',promptProvenance:fixture.promptProvenance,sourceUnchanged:true,inference:result.inference,build:result.build,qa:result.browserQA},null,2));
  },240000);
  it.each(complexFixtures)("validates $id, saves current source and bills once with no extra model role", async fixture => {
    const h = await harness(fixture); const result = await h.product.pipeline.generate(h.request);
    expect(result.build.success).toBe(true); expect(result.browserQA?.status).not.toBe("FAIL");
    expect(result.browserQA?.checks.filter(check => check.status === "FAIL" && check.severity === "ERROR")).toEqual([]);
    expect(result.browserQA?.checks.filter(check => check.checkId === "runtime.page-error" && check.status !== "PASS")).toEqual([]);
    expect(new Set(result.browserQA?.viewports.map(viewport => viewport.id))).toEqual(new Set(["DESKTOP", "TABLET", "MOBILE"]));
    expect(h.calls).toHaveLength(1); expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect((await h.product.projects.getById(result.siteId))?.latestVersionId).toBe(result.versionId);
    expect(await h.product.artifacts.get(result.sourceArtifactRef)).toBeDefined();
    await h.verifyCleanup(); await h.metrics("PASS");
  }, 180000);
  it("retains a rejected compiler repair anchor without overwriting original evidence or charging", async () => {
    const base = complexFixture("saas");
    const invalidTabs = { ...base, bundle: { files: base.bundle.files.map(file => file.path === "src/App.tsx" ? { ...file, content: file.content + '\nconst invalidRepairFixture:number="broken";void invalidRepairFixture;' } : file) } };
    const h = await harness(invalidTabs, { patches: [{ path: "src/App.tsx", find: "const anchorInventedByModel = 42;", replace: "const repaired = true;" }] });
    await expect(h.product.pipeline.generate(h.request)).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { failureStage: "PATCH_APPLICATION", reason: "MISSING_FIND_TEXT" } });
    expect(h.calls).toHaveLength(2); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    const files = await readdir(h.diagnostics.root); expect(files).toHaveLength(1);
    const reports = await Promise.all(files.map(async name => JSON.parse(await readFile(join(h.diagnostics.root, name), "utf8")) as { generationAttempt: number; outerRequestId: string; validation: { failureStage: string }; buildRepair?: { proposal?: { patches: { find?: string }[] }; requestSnapshot?: { revision: string; context?: string } } }));
    const failed = reports.find(report => report.generationAttempt === 2)!;
    expect(failed.outerRequestId).toBe(h.request.outerRequestId); expect(failed.validation.failureStage).toBe("PATCH_APPLICATION");
    expect(failed.buildRepair?.proposal?.patches[0]?.find).toBe("const anchorInventedByModel = 42;");
    expect(failed.buildRepair?.requestSnapshot?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(failed.buildRepair?.requestSnapshot?.context).toContain("function RecordDialog");
    const projects = await h.product.projects.listByOwner(h.request.userId); expect(projects.items.every(project => !project.latestVersionId)).toBe(true);
    await h.verifyCleanup(); await h.metrics("EXPECTED_PATCH_REJECTION");
  }, 180000);
});
