import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateReferenceInteractions, validateStaticFragmentNavigation, GENERATION_NAVIGATION_RULES } from "../src/cli/runtime/reference-interaction-validator.js";
import { estimateTokensConservative } from "../src/agents/budget/token-estimator.js";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { BROWSER_QA_VIEWPORTS, createBrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { LocalExecutionProvider } from "../src/execution/local/local-execution.provider.js";
import { createDevelopmentFailedCandidateEvidence, FAILED_CANDIDATE_LIMITS, LocalFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import { DevJobManager } from "../src/dev-server/dev-job-manager.js";
import { InMemoryProgressBus } from "../src/sites/application/progress.js";
import { ApplicationError } from "../src/app/errors/application-error.js";
import { createDevelopmentGenerationTelemetry, recordGenerationTelemetry, referenceContextTelemetry, type GenerationDevelopmentEvent } from "../src/sites/generation/generation-development-telemetry.js";
import { siteFailureStage } from "../src/sites/generation/site-token-usage-log.js";

const temporaryParent = resolve(".sites-runtime/reliability-tests");
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const root of roots.splice(0)) {
    if (!root.startsWith(temporaryParent + sep)) throw new Error("Unsafe test cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});
async function temporary() {
  await mkdir(temporaryParent, { recursive: true });
  const root = await mkdtemp(join(temporaryParent, "case-")); roots.push(root); return root;
}
const bundle = (content: string) => ({ files: [{ path: "src/App.tsx", content }] });
describe("Conservative generation navigation contract", () => {
  it("adds compact navigation rules without another role/request", () => {
    expect(GENERATION_NAVIGATION_RULES).toContain("NAVIGATION:"); expect(GENERATION_NAVIGATION_RULES).toContain("ACTIONS:");
    expect(GENERATION_NAVIGATION_RULES).toContain('<button onClick={openCart}>Cart</button>');
    expect(GENERATION_NAVIGATION_RULES).toContain("Size guide link needs visible sizing content");
    expect(estimateTokensConservative(GENERATION_NAVIGATION_RULES)).toBeLessThan(200);
  });
  it("rejects a provably absent fragment and a dead action link", () => {
    expect(() => validateStaticFragmentNavigation(bundle('<a href="#missing">Search</a>'))).toThrow(/missing fragment destinations/);
    expect(() => validateStaticFragmentNavigation(bundle('<a href="#size-guide">Size guide</a>'))).toThrow(/#size-guide/);
    expect(() => validateReferenceInteractions(bundle('<a href="#cart">Cart</a>'))).toThrow();
    expect(() => validateReferenceInteractions(bundle('<a href="#cart" onClick={() => {}}>Cart</a>'))).toThrow();
  });
  it.each([
    '<><a href="#section">Section</a><section id="section">Meaningful content</section></>',
    '<><a href="#section">Section</a><section id={"section"}>Meaningful content</section></>',
    '<Link to="/product">Product</Link>',
    '<a href="/product">Product</a>',
    '<><a href="/product#details">Details</a><section id="details">Details</section></>',
    '<><a href="#section">Section</a><section id={sectionId}>Dynamic content</section></>',
    '<><a href="#section">Section</a><section {...targetProps}>Dynamic content</section></>',
    '<a href="#cart" onClick={openCart}>Cart</a>',
    '<button onClick={openCart}>Cart</button>',
    '<><a href="#section">Section</a><ImportedSection /></>',
    'const Section = externalFactory(); export const App = () => <><a href="#section">Section</a><Section /></>',
    'export const App = () => <><a href="#product">Product</a>{location.hash === "#product" ? <p>Product view</p> : null}</>',
    'document.querySelector("main").id = "section"; export const App = () => <a href="#section">Section</a>',
  ])("does not reject valid or undecidable routing: %s", content => {
    expect(() => validateStaticFragmentNavigation(bundle(content))).not.toThrow();
  });
  it("resolves static targets across submitted components", () => {
    expect(() => validateStaticFragmentNavigation({ files: [
      ...bundle('<><a href="#details">Details</a><Details /></>').files,
      { path: "src/Details.tsx", content: 'export function Details(){return <section id="details">Product details</section>}' },
    ] })).not.toThrow();
  });
});

async function fixture(content: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body><div id="root">${content}</div></body></html>`);
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}
const interaction = browserQAResponsiveAndInteractionChecks.find(check => check.definition.checkId === "interaction-smoke")!;
describe("Native details uses its actual parent and keeps legitimate QA gates", () => {
  it("preserves the existing interaction timeout budget", () => { expect(interaction.definition.timeoutMs).toBe(3_000); });
  it.each(BROWSER_QA_VIEWPORTS)("opens and restores native details without timing out on $id", async viewport => {
    const report = await new BrowserQARunner().run({ runId: `native-${viewport.id}`,
      target: { baseUrl: await fixture('<details><summary>Details and fit</summary><p>Useful product details</p></details>') },
      viewports: [viewport], checks: [interaction], policy: { captureScreenshots: false } });
    expect(report.status).toBe("PASS");
    expect(report.checks.find(check => check.checkId === "interaction-smoke")).toMatchObject({ status: "PASS" });
  });
  it.each(["open", 'onclick="event.preventDefault()"'])("checks initially open and broken native controls: %s", async attributes => {
    const report = await new BrowserQARunner().run({ runId: "native-states",
      target: { baseUrl: await fixture(`<details ${attributes}><summary>Details</summary><p>Content</p></details>`) },
      viewports: [BROWSER_QA_VIEWPORTS[0]!], checks: [interaction], policy: { captureScreenshots: false } });
    const expected = attributes === "open" ? "PASS" : "FAIL";
    expect(report.status).toBe(expected);
    expect(report.checks.find(check => check.checkId === "interaction-smoke")).toMatchObject({ status: expected, severity: "ERROR" });
  });
  it("still blocks a genuinely missing fragment", async () => {
    const report = await new BrowserQARunner().run({ runId: "missing-fragment",
      target: { baseUrl: await fixture('<a href="#missing">Missing destination</a>') }, viewports: [BROWSER_QA_VIEWPORTS[0]!],
      checks: browserQACoreCheckExecutors, policy: { captureScreenshots: false } });
    expect(report.status).toBe("FAIL");
    expect(report.checks.find(check => check.checkId === "internal-links")).toMatchObject({ status: "FAIL", severity: "ERROR" });
  });
});

const failedReport = () => createBrowserQAReport({ runId: "failed-local", browser: { name: "chromium" },
  routes: ["/"], viewports: [BROWSER_QA_VIEWPORTS[0]!], startedAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), durationMs: 0,
  checks: [{ checkId: "internal-links", category: "ROUTING", status: "FAIL", severity: "ERROR", message: "Missing #cart" }],
});
const localExecution = (root: string) => new LocalExecutionProvider({ rootDirectory: join(root, "execution"), keepWorkspace: false,
  previewHost: "127.0.0.1", previewStartTimeoutMs: 20_000, commandTimeoutMs: 60_000, maxLogBytes: 128_000 });
describe("Private bounded local failed-candidate evidence", () => {
  it("retains a submitted static-failure bundle instead of the untouched scaffold, using the same filtering", async () => {
    const root = await temporary(); vi.stubEnv("EARLY_TEST_SECRET", "early-secret-value-never-retained");
    const execution = { listFiles: vi.fn(), readFile: vi.fn() };
    const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics"));
    const path = await diagnostics.preserve({ execution, environmentId: "not-materialized", siteId: "candidate", jobId: "early-failure",
      candidate: { files: [{ path: "src/App.tsx", content: 'export const App = () => <a href="#cart">Cart</a>; // early-secret-value-never-retained' },
        { path: ".env", content: "DO_NOT_RETAIN=secret-env-file" }] },
      validationFailure: { failureStage: "STATIC_VALIDATION", code: "GENERATION_INCOMPLETE", check: "navigation.fragments", message: "src/App.tsx:1 -> #cart", buildPassed: false } });
    expect(path).toEqual(expect.any(String));
    if (!path) throw new Error("Expected private diagnostic path");
    const text = await readFile(path, "utf8");
    expect(text).toContain('href=\\"#cart\\"'); expect(text).toContain("submitted-candidate"); expect(text).toContain("navigation.fragments");
    expect(text).not.toContain("early-secret-value-never-retained"); expect(text).not.toContain("secret-env-file");
    expect(execution.listFiles).not.toHaveBeenCalled(); expect(execution.readFile).not.toHaveBeenCalled();
  });
  it("exposes structured QA stage, not private diagnostic metadata, in job errors", async () => {
    const manager = new DevJobManager(new InMemoryProgressBus());
    const job = manager.start("GENERATE", () => Promise.reject(new ApplicationError("VALIDATION_FAILED", "Browser QA failed for generated site", {
      retryable: false, metadata: { failureStage: "BROWSER_QA", privateDiagnosticPath: "private-source-evidence" },
    })), "offline-owner");
    await vi.waitFor(() => expect(job.status).toBe("FAILED"));
    expect(job.error).toMatchObject({ code: "VALIDATION_FAILED", failureStage: "BROWSER_QA", retryable: false });
    expect(JSON.stringify(job)).not.toContain("private-source-evidence");
  });
  it("is wired only into development, outside publicly served artifacts", () => {
    expect(createDevelopmentFailedCandidateEvidence(".sites-runtime/playground", "production")).toBeUndefined();
    expect(createDevelopmentFailedCandidateEvidence(".sites-runtime/playground", "development")?.root).toBe(resolve(".sites-runtime/playground/diagnostics/failed-candidates"));
  });
  it("retains source/completion/QA after workspace cleanup without any project/version storage", async () => {
    const root = await temporary();
    const execution = localExecution(root);
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/App.tsx", 'export const App = () => <main>Failed candidate</main>');
    const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics/failed-candidates"));
    await diagnostics.preserve({ execution, environmentId: environment.id, siteId: "candidate-not-project", jobId: "job", report: failedReport(), completion: { attempts: 1, accepted: true, rejectedAttempts: 0 } });
    await execution.destroyEnvironment(environment.id);
    const names = await readdir(diagnostics.root);
    const text = await readFile(join(diagnostics.root, names[0]!), "utf8");
    expect(text).toContain("Failed candidate"); expect(text).toContain('"accepted":true'); expect(text).toContain("internal-links");
    expect(await readdir(root)).toEqual(expect.arrayContaining(["execution", "diagnostics"]));
    expect(text).not.toContain('"versionNumber"'); expect(text).not.toContain('"sourceArtifactRef"');
  });
  it("omits unsafe files and scrubs environment secrets, JWTs, private keys and secret assignments", async () => {
    const root = await temporary(); vi.stubEnv("TEST_SECRET", "fixture-secret-not-for-retention");
    const execution = localExecution(root);
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/App.tsx", `const test = 'fixture-secret-not-for-retention'; const jwt='eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiZml4dHVyZSJ9.c2lnbmF0dXJl'; const client_secret='private-client-value'; const pem=\`-----BEGIN PRIVATE KEY-----\nprivate-pem-value\n-----END PRIVATE KEY-----\`;`);
    await execution.writeFile(environment.id, ".env", "DO_NOT_RETAIN=private-env-value");
    await execution.writeFile(environment.id, "src/keys.ts", "const OPENAI_API_KEY='private-provider-value';");
    await execution.writeFile(environment.id, "src/credential.json", '{"private_key":"private-file-value"}');
    const diagnostics = new LocalFailedCandidateEvidence(join(root, "diagnostics"));
    await diagnostics.preserve({ execution, environmentId: environment.id, jobId: "secrets", siteId: "candidate", report: failedReport() });
    const text = await readFile(join(diagnostics.root, (await readdir(diagnostics.root))[0]!), "utf8");
    for (const secret of ["fixture-secret-not-for-retention", "eyJhbGci", "private-client-value", "private-env-value", "private-provider-value", "private-file-value", "private-pem-value"]) expect(text).not.toContain(secret);
    expect(text).toContain("REDACTED"); expect(text).toContain('"omittedFiles":3');
    await execution.destroyEnvironment(environment.id);
  });
  it("enforces count, byte and age limits without touching unrelated files", async () => {
    const root = await temporary(); const diagnostics = new LocalFailedCandidateEvidence(root);
    const execution = { listFiles: vi.fn(async () => [{ path: "src/huge.ts", type: "FILE" as const, sizeBytes: FAILED_CANDIDATE_LIMITS.maxSourceFileBytes + 1 }]), readFile: vi.fn() };
    await writeFile(join(root, "unrelated.txt"), "preserve");
    for (let i = 0; i < 7; i++) await diagnostics.preserve({ execution, environmentId: "env", jobId: String(i), siteId: "candidate", report: failedReport() });
    let names = (await readdir(root)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(FAILED_CANDIDATE_LIMITS.maxFiles); expect(execution.readFile).not.toHaveBeenCalled();
    for (const name of names) expect((await stat(join(root, name))).size).toBeLessThanOrEqual(FAILED_CANDIDATE_LIMITS.maxBytes);
    await utimes(join(root, names[0]!), new Date(0), new Date(0));
    await diagnostics.prune(); names = (await readdir(root)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(FAILED_CANDIDATE_LIMITS.maxFiles - 1); expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("preserve");
  });
});

describe("Always-available private development context telemetry", () => {
  it("keeps static failure stage consistent in the existing token usage log", () => {
    expect(siteFailureStage(new ApplicationError("GENERATION_INCOMPLETE", "Missing fragment", { metadata: { failureStage: "STATIC_VALIDATION" } }))).toBe("STATIC_VALIDATION");
  });
  it("records only whitelisted metadata and never emits raw context, source, credentials or prompt", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("TELEMETRY_TEST_SECRET", "telemetry-secret-do-not-log");
    const sink = createDevelopmentGenerationTelemetry("development")!;
    sink.record({ jobId: "job", role: "sites.site-coder", model: "fixture", ...referenceContextTelemetry({ templateKey: "ecommerce-store", version: 1 }, "PRIVATE DESIGN DATA"),
      candidateDiagnosticPath: "D:/diagnostics/telemetry-secret-do-not-log.json", prompt: "PRIVATE USER PROMPT", source: "PRIVATE SOURCE", apiKey: "PRIVATE CREDENTIAL" } as GenerationDevelopmentEvent);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("ecommerce-store"); expect(logged).toContain('referenceContextPresent');
    for (const secret of ["PRIVATE DESIGN DATA", "PRIVATE USER PROMPT", "PRIVATE SOURCE", "PRIVATE CREDENTIAL", "telemetry-secret-do-not-log"]) expect(logged).not.toContain(secret);
    const context = referenceContextTelemetry({ templateKey: "ecommerce-store", version: 1 }, "PRIVATE DESIGN DATA");
    expect(context.contextBytes).toBe(Buffer.byteLength("PRIVATE DESIGN DATA")); expect(context.contextDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(createDevelopmentGenerationTelemetry("production")).toBeUndefined();
    expect(referenceContextTelemetry()).toEqual({ referenceContextPresent: false, contextBytes: 0 });
  });
  it("cannot fail a workflow if telemetry output is unavailable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => recordGenerationTelemetry({ record() { throw new Error("private logging failure"); } }, { jobId: "job", role: "generation" })).not.toThrow();
  });
});
