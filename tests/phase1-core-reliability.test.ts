import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBuildLog, summarizeInstallFailure } from "../src/cli/runtime/build-log-normalizer.js";
import { createBuildRepairSourceSnapshot } from "../src/cli/runtime/build-repair-source.js";
import { compilerSourceDiagnostics } from "../src/cli/runtime/build-repair-source-safety.js";
import { parseEditRequirements } from "../src/cli/runtime/edit-requirements.js";
import { canonicalWebUrl, validateEditScopeCompletion, validateProtectedEditValues } from "../src/cli/runtime/edit-scope.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import { TemplateInstantiationService } from "../src/templates/application/template-instantiation-service.js";
import { loadTemplateManifest } from "../src/templates/publishing/template-manifest.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import type { SiteJob } from "../src/sites/domain/entities.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Reduced reproduction of the Studio Solace failure: a <p> closed by a fragment
// `</>` on a long generated line. tsc reports only TS1003 at the `>` of `</>`.
const solaceLine = 'function BagPage({ cart }: { cart: Cart }) { const subtotal = cart.items.reduce((s, i) => s + i.price * i.quantity, 0); return <Generic title="Your bag">' +
  '{cart.items.length ? <><ul>{cart.items.map(i => <li key={i.id}>{i.name}</li>)}</ul><p>Subtotal ${subtotal}</p><button className="button" onClick={() => cart.clear()}>Review demonstration checkout</button></>' +
  ' : <p>Your bag is empty. <SiteLink href="/shop-all">Browse the collection.</SiteLink></>}</Generic> }';
const solaceSource = [...Array.from({ length: 69 }, (_, i) => `const filler${i} = ${i};`), solaceLine, "export default BagPage;"].join("\n");
const pColumn = solaceLine.indexOf("<p>Your bag") + 1;
const fragmentColumn = solaceLine.indexOf("</>}</Generic>") + 1;

describe("Fix 1: build repair keeps the primary compiler diagnostic and JSX tag context", () => {
  it("reproduces the Studio Solace TS1003 symptom offline", () => {
    const parsed = ts.createSourceFile("src/App.tsx", solaceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
    expect(parsed.parseDiagnostics.map(diagnostic => diagnostic.code)).toEqual([1003]);
    const position = parsed.getLineAndCharacterOfPosition(parsed.parseDiagnostics[0]!.start!);
    expect([position.line + 1, position.character + 1]).toEqual([70, fragmentColumn + 2]);
  });

  it("preserves the first located diagnostic when cascades exceed the log budget", () => {
    const primary = `src/App.tsx(70,${fragmentColumn + 2}): error TS1003: Identifier expected.`;
    const cascade = Array.from({ length: 160 }, (_, i) => `src/pages/Page${i}.tsx(${i + 1},5): error TS2304: Cannot find name 'Generic${i}'.`);
    const log = ["> tsc --noEmit && vite build", primary, ...cascade, "npm ERR! code 1"].join("\n");
    expect(log.indexOf(primary)).toBeLessThan(log.length - 4_000);
    const normalized = normalizeBuildLog(log, "");
    expect(normalized).toContain(primary);
    expect(normalized).toContain("Generic159");
    expect(Buffer.byteLength(normalized)).toBeLessThanOrEqual(4_100);
    expect(normalized.split("\n").every(line => !line || cascade.includes(line) || line === primary || line.startsWith("["))).toBe(true);
  });

  it("names the unclosed <p> and the mismatched </> with exact line/column in a bounded context", () => {
    const snapshot = createBuildRepairSourceSnapshot([{ path: "src/App.tsx", content: solaceSource }], `src/App.tsx(70,${fragmentColumn + 2}): error TS1003: Identifier expected.`);
    expect(snapshot.compilerDiagnostics).toContain(`src/App.tsx:70:${fragmentColumn + 2} TS1003: Identifier expected.`);
    expect(snapshot.compilerDiagnostics).toContain(`JSX <p> opened at src/App.tsx:70:${pColumn} is closed by </> at src/App.tsx:70:${fragmentColumn}`);
    expect(snapshot.compilerDiagnostics).toContain("Your bag is empty.");
    expect(Buffer.byteLength(snapshot.compilerDiagnostics!)).toBeLessThanOrEqual(1_500);
    expect(snapshot.context).toContain(solaceLine);
  });

  it("supplies an opening tag that is far from the reported line as a verbatim excerpt", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `const filler${i} = "${"x".repeat(60)}";`);
    lines[9] = "export function Page() { return <section>";
    lines[10] = "  <p>Opening paragraph";
    for (let i = 11; i < 30; i++) lines[i] = `  <span>line ${i}</span>`;
    lines[30] = "  </>";
    lines[31] = "</section>; }";
    const content = lines.join("\n");
    const snapshot = createBuildRepairSourceSnapshot([{ path: "src/App.tsx", content }], "src/App.tsx(31,5): error TS1003: Identifier expected.", 3_000);
    expect(snapshot.compilerDiagnostics).toContain("JSX <p> opened at src/App.tsx:11:3 is closed by </> at src/App.tsx:31:3");
    expect(snapshot.context).toContain("  <p>Opening paragraph");
    expect(snapshot.context).not.toContain(lines[100]);
  });

  it("adds no parser evidence for valid source or when no diagnostics are supplied", () => {
    expect(compilerSourceDiagnostics([{ path: "src/App.tsx", content: "export const App = () => <main><p>ok</p></main>;" }])).toBe("");
    expect(createBuildRepairSourceSnapshot([{ path: "src/App.tsx", content: solaceSource }], "").compilerDiagnostics).toBeUndefined();
  });
});

describe("Fix 2: edit outcome is decided before Browser QA", () => {
  it.each(["review", "unchanged", "applied"] as const)("%s: Browser QA runs only for a meaningful applied edit", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "phase1-edit-qa-"));
    const execution = new MockExecutionProvider();
    const execute = execution.executeCommand.bind(execution);
    vi.spyOn(execution, "executeCommand").mockImplementation(async (id, command) => {
      if (command.args?.[0] === "ci") { const now = new Date(); return { exitCode: 0, stdout: "offline install", stderr: "", timedOut: false, durationMs: 0, startedAt: now, finishedAt: now }; }
      const result = await execute(id, command);
      if (result.exitCode === 0) await execution.writeFile(id, "dist/index.html", '<div id="root"></div>');
      return result;
    });
    const mock = new MockAgentProvider({ customResponse: request => ({ id: "offline-edit", model: request.model,
      message: { role: "assistant", content: JSON.stringify({ patches: [{ path: "src/App.tsx", mode: "unique", find: "<h1>Original</h1>",
        replace: scenario === "applied" ? "<h1>Updated</h1>" : "<h1>Original</h1>" }] }) },
      toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 }, latencyMs: 0, finishReason: "stop" }) });
    const provider = { id: "offline-edit-fixture", getCapabilities: () => mock.getCapabilities(), createResponse: mock.createResponse.bind(mock) };
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const finalize = vi.fn(async (job: SiteJob) => ({ ...job, billingStatus: "CHARGED" as const, creditsCharged: 1 }));
    const preflight = vi.fn(async () => ({ ownerId: "offline", modelRate: { model: "mock-sites-v1", platform: "mock-agent", type: "ai_chat", creditsPer500Tokens: 1 } }));
    const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), execution: execution as never,
      agentRegistry: registry, orchestrationAgent: provider, billing: { preflight, finalizeSuccessfulJob: finalize } as unknown as SiteCreditBillingService });
    const qaReport = { status: "PASS", checks: [], summary: { failed: 0 }, routes: ["/"], viewports: [] };
    const qa = vi.spyOn(product.browserQA, "run").mockResolvedValue(qaReport as never);
    const put = vi.spyOn(product.artifacts, "put");
    const siteId = "phase1-edit-project" as SiteId, ownerId = "offline" as UserId, versionId = "initial-version" as VersionId;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<div id="root"></div>'));
    try {
      const environment = await execution.createEnvironment({});
      for (const [path, content] of Object.entries({ "src/App.tsx": "export function App(){return <main><h1>Original</h1></main>}", "src/main.tsx": "// managed entry",
        "index.html": '<div id="root"></div>', "package.json": JSON.stringify({ scripts: { build: "vite build" } }) })) await execution.writeFile(environment.id, path, content);
      const sourceRef = "sites/phase1-edit-project/current/source.json";
      await new SiteSourceSnapshotService(product.artifacts).capture(execution as never, environment.id, sourceRef, { technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1 });
      await execution.destroyEnvironment(environment.id);
      const now = new Date();
      await product.projects.save({ id: siteId, ownerId, name: "Existing", slug: "existing", status: "ACTIVE", latestVersionId: versionId, createdAt: now, updatedAt: now });
      await product.versions.save({ id: versionId, siteId, versionNumber: 1, sourceArtifactRef: sourceRef, buildStatus: "SUCCEEDED", createdAt: now });
      put.mockClear();
      const promise = product.pipeline.edit({ userId: ownerId, siteId, instruction: scenario === "review" ? "Review the website and fix verified issues" : "Change the heading",
        agentProvider: provider.id, browserQAEnabled: true });
      if (scenario === "unchanged") await expect(promise).rejects.toMatchObject({ code: "EDIT_REQUIREMENT_INCOMPLETE", metadata: { reason: "UNCHANGED_EDIT_RESULT" } });
      else {
        const result = await promise;
        expect(result.editOutcome).toBe(scenario === "review" ? "NO_CHANGES_REQUIRED" : "APPLIED");
        expect(result.browserQA === undefined).toBe(scenario === "review");
      }
      expect(qa).toHaveBeenCalledTimes(scenario === "applied" ? 1 : 0);
      // No QA report artifact is written for a no-change or rejected candidate.
      expect(put.mock.calls.some(([ref]) => String(ref).includes("/qa/"))).toBe(scenario === "applied");
      expect(finalize).toHaveBeenCalledTimes(scenario === "applied" ? 1 : 0);
      const job = (await product.jobs.listBySite(siteId)).items[0]!;
      if (scenario !== "applied") { expect(job.billingStatus).toBe("NOT_CHARGED"); expect(job.creditsCharged).toBe(0); }
      expect((await product.projects.getById(siteId))!.latestVersionId === versionId).toBe(scenario !== "applied");
    } finally { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

const npmCiFailure = [
  "npm error code ERESOLVE",
  "npm error ERESOLVE could not resolve",
  "npm error While resolving: corporate-template@1.0.0",
  "npm error Found: react@19.0.0",
  "npm error Could not resolve dependency: peer react@\"^18.2.0\" from legacy-carousel@2.1.0",
  "npm error //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
  "npm error fetch https://ci-user:hunter2-not-real@registry.example.test/legacy-carousel",
  ...Array.from({ length: 300 }, (_, i) => `npm verbose stack line ${i} ${"x".repeat(40)}`),
  "npm error A complete log of this run can be found in: C:\\Users\\someone\\AppData\\Local\\npm-cache\\_logs\\debug-0.log",
].join("\n");

describe("Fix 3: template failure diagnostics are concise, relevant and redacted", () => {
  it("keeps the npm error code and cause lines, drops verbose noise and hides credentials", () => {
    const summary = summarizeInstallFailure(npmCiFailure, "");
    expect(summary.npmErrorCode).toBe("ERESOLVE");
    expect(summary.output).toContain("Could not resolve dependency: peer react@\"^18.2.0\" from legacy-carousel@2.1.0");
    expect(summary.output).not.toContain("verbose stack");
    expect(summary.output).not.toContain("complete log of this run");
    for (const secret of ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2-not-real", "ci-user:"]) expect(summary.output).not.toContain(secret);
    expect(Buffer.byteLength(summary.output)).toBeLessThanOrEqual(1_500);
    expect(summarizeInstallFailure("", "plain failure without npm error prefix").output).toBe("plain failure without npm error prefix");
  });

  it("records the npm ci cause at the BUILD stage of a real template instantiation", async () => {
    const directory = resolve("templates", "restaurant"), manifest = await loadTemplateManifest(directory);
    const archive = await packageTemplateSource(await validateTemplateSource(directory));
    const record = { ...manifest, id: `restaurant:${manifest.version}`, categoryId: manifest.categoryKey, status: "active" as const, sourceObject: "restaurant.zip",
      sourceSha256: archive.sha256, previews: {}, createdAt: new Date(0), updatedAt: new Date(0) };
    const execution = new MockExecutionProvider();
    vi.spyOn(execution, "executeCommand").mockImplementation(async (_id, command) => {
      const now = new Date();
      return command.args?.[0] === "ci" ? { exitCode: 1, stdout: "", stderr: npmCiFailure, timedOut: false, durationMs: 5, startedAt: now, finishedAt: now }
        : { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0, startedAt: now, finishedAt: now };
    });
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const browserQA = { run: vi.fn() };
    const service = new TemplateInstantiationService({ templates: { findLatestActiveTemplate: vi.fn(async () => record) } as never, source: { readObject: vi.fn(async () => archive.bytes) },
      execution: execution as never, artifacts: {} as never, projects: {} as never, versions: {} as never, browserQA: browserQA as never, cleanupSite: vi.fn(async () => undefined) });
    await expect(service.instantiate({ ownerId: "offline-owner" as UserId, templateKey: "restaurant" })).rejects.toMatchObject({
      code: "TEMPLATE_INSTANTIATION_BUILD_FAILED", metadata: { failureStage: "BUILD", command: "npm ci", exitCode: 1, npmErrorCode: "ERESOLVE" } });
    expect(browserQA.run).not.toHaveBeenCalled();
    const line = String(logger.mock.calls.find(call => call[0] === "[sites][template-instantiation]")?.[1]);
    expect(line).toContain('"stage":"BUILD"');
    expect(line).toContain("ERESOLVE");
    expect(line).toContain("legacy-carousel@2.1.0");
    for (const secret of ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2-not-real"]) expect(line).not.toContain(secret);
    expect(line.length).toBeLessThan(6_000);
  });

  it("records stage, file, rule and value category for a protection rejection without the values", () => {
    const before = new Map([["src/App.tsx", 'export const App = () => <footer><a href="tel:+12125550190">+1 212-555-0190</a><a href="mailto:hello@oldbrand.com">Email</a></footer>;']]);
    const after = new Map([["src/App.tsx", 'export const App = () => <footer><a href="tel:+12125550190">+1 212-555-0190</a><a href="mailto:invented@newbrand.com">Email</a></footer>;']]);
    const scope = parseEditRequirements("Update the footer copy.").scope ?? parseEditRequirements("Change the footer text to \"Hi\"").scope!;
    let error: unknown;
    try { validateProtectedEditValues(scope, before, after); } catch (cause) { error = cause; }
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", metadata: { path: "src/App.tsx", reason: "PROTECTED_VALUE_CHANGE_NOT_AUTHORIZED",
      protectionStage: "SOURCE_VALIDATION", protectionRule: "REPLACEMENT_NOT_SUPPLIED_BY_USER", valueCategories: ["email"], valueCount: 1 } });
    const serialized = JSON.stringify({ message: (error as Error).message, metadata: (error as { metadata: unknown }).metadata });
    expect(serialized).toContain("categories=email");
    for (const value of ["invented@newbrand.com", "hello@oldbrand.com", "555-0190"]) expect(serialized).not.toContain(value);
  });
});

describe("Fix 4: template protection authorizes explicit contact/URL changes only", () => {
  const footer = (phone: string, site: string, instagram: string, email = "hello@studio.test") =>
    new Map([["src/App.tsx", `export const App = () => <footer><a href="tel:${phone.replace(/[^\d+]/g, "")}">${phone}</a><a href="${site}">Website</a><a href="${instagram}">Instagram</a><a href="mailto:${email}">${email}</a></footer>;`]]);
  const before = footer("+1 212-555-0190", "https://studio.test", "https://instagram.com/oldstudio");
  const accept = (instruction: string, after: Map<string, string>) => {
    const scope = parseEditRequirements(instruction).scope!;
    expect(() => validateProtectedEditValues(scope, before, after)).not.toThrow();
    expect(() => validateEditScopeCompletion(scope, before, after)).not.toThrow();
  };
  const reject = (instruction: string, after: Map<string, string>) => {
    const scope = parseEditRequirements(instruction).scope;
    expect(() => scope ? validateProtectedEditValues(scope, before, after) : (() => { throw new Error("no scope"); })()).toThrow();
  };

  it.each([
    ["Change the phone number to +1 212-555-0199 but keep the layout.", footer("+1 212-555-0199", "https://studio.test", "https://instagram.com/oldstudio")],
    ["Update the phone number to +1 212-555-0199 without changing the design.", footer("+1 212-555-0199", "https://studio.test", "https://instagram.com/oldstudio")],
    ["Update the Instagram link to instagram.com/newstudio", footer("+1 212-555-0190", "https://studio.test", "https://www.instagram.com/newstudio/")],
    ["Replace our website URL with https://newstudio.test.", footer("+1 212-555-0190", "https://newstudio.test/", "https://instagram.com/oldstudio")],
    ["Update the contact email to hi@newstudio.test and keep everything else.", footer("+1 212-555-0190", "https://studio.test", "https://instagram.com/oldstudio", "hi@newstudio.test")],
  ])("accepts: %s", (instruction, after) => accept(instruction, after));

  it.each([
    // The user supplied a different value from the one written.
    ["Update the Instagram link to instagram.com/newstudio", footer("+1 212-555-0190", "https://studio.test", "https://instagram.com/otherstudio")],
    // Mixed instruction: only the phone is authorized; the website must not change.
    ["Change the phone number to +1 212-555-0199 but keep the layout.", footer("+1 212-555-0199", "https://evil.test", "https://instagram.com/oldstudio")],
    // Preservation is not authorization.
    ["Keep the phone number and do not change the website.", footer("+1 212-555-0199", "https://studio.test", "https://instagram.com/oldstudio")],
    // A negated request with a value is still a refusal.
    ["Don't update the Instagram link to instagram.com/newstudio", footer("+1 212-555-0190", "https://studio.test", "https://instagram.com/newstudio")],
    // An unrelated copy edit cannot launder a contact change.
    ['Change the hero heading to "Welcome"', footer("+1 212-555-0190", "https://studio.test", "https://instagram.com/oldstudio", "hi@newstudio.test")],
    // Path differences are not normalized away.
    ["Update the website link to https://studio.test/new", footer("+1 212-555-0190", "https://studio.test/other", "https://instagram.com/oldstudio")],
  ])("rejects: %s", (instruction, after) => reject(instruction, after));

  it("normalizes only non-semantic URL spelling", () => {
    expect(canonicalWebUrl("https://www.Instagram.com/NewStudio/")).toBe("instagram.com/NewStudio");
    expect(canonicalWebUrl("instagram.com/NewStudio.")).toBe("instagram.com/NewStudio");
    expect(canonicalWebUrl("https://studio.test/a?b=1")).toBe("studio.test/a?b=1");
    expect(canonicalWebUrl("https://studio.test/a")).not.toBe(canonicalWebUrl("https://studio.test/b"));
    expect(canonicalWebUrl("./App.tsx")).toBeUndefined();
    expect(canonicalWebUrl("hello@studio.test")).toBeUndefined();
  });
});
