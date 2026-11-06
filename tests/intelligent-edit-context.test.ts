import { describe, expect, it, vi } from "vitest";
import { mapEditRepository, renderEditRepositoryMap } from "../src/cli/runtime/edit-repository-map.js";
import { selectAdaptiveEditContext } from "../src/cli/runtime/adaptive-edit-context.js";
import { applySiteEditPatchBundle, validateSiteEditPatchBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { assessEditOutcome } from "../src/cli/runtime/edit-outcome.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";

describe("Edit repository structure", () => {
  it("maps arbitrary module layouts, exports, imports, state and route definitions", () => {
    const map = mapEditRepository([
      { path: "src/root/Shell.tsx", content: 'import {Catalog} from "../screens/catalog"; export function Shell(){const [open,setOpen]=useState(false);return <Route path="/catalog" element={<Catalog/>}/>;}' },
      { path: "src/screens/catalog/index.tsx", content: 'export function Catalog(){return <main>Catalog</main>}' },
    ]);
    expect(map.files[0]!.imports[0]!.target).toBe("src/screens/catalog/index.tsx");
    expect(map.files[0]!.routes).toContain("/catalog");
    expect(map.files[0]!.regions.some(region => region.owner === "Shell" && region.declares.includes("setOpen"))).toBe(true);
    expect(renderEditRepositoryMap(map)).toContain("Shell");
  });

  it("reuses unchanged structural data and invalidates edited source", () => {
    const files = [{ path: "src/CacheProof.ts", content: "export const amount = 17;" }];
    mapEditRepository(files);
    expect(mapEditRepository(files).parseHits).toBe(1);
    expect(mapEditRepository([{ ...files[0]!, content: "export const amount = 18;" }]).parseMisses).toBe(1);
  });

  it("bounds the structural map without slicing actual source", () => {
    const map = mapEditRepository(Array.from({ length: 100 }, (_, i) => ({ path: `src/components/Panel${i}.tsx`, content: `export function Panel${i}(){return <p>Panel</p>}` })));
    const text = renderEditRepositoryMap(map, 1_000);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_000);
    expect(text).toContain("Map abbreviated");
  });
});

describe("Meaningful edit outcomes", () => {
  const before = new Map([["src/App.tsx", "export function App(){return <h1>Original</h1>}"], ["src/theme.css", "body {color:red}"]]);
  it("rejects an unexpected unchanged response", () => {
    expect(() => assessEditOutcome("Add comparison functionality", before, before)).toThrow(/no meaningful/);
  });
  it("recognizes an explicit review and an already-satisfied exact copy request", () => {
    expect(assessEditOutcome("Review the website and fix verified issues", before, before).outcome).toBe("NO_CHANGES_REQUIRED");
    expect(assessEditOutcome('Set the page heading to "Original"', before, before).outcome).toBe("NO_CHANGES_REQUIRED");
  });
  it("does not accept formatting and comments as the requested functionality", () => {
    const after = new Map(before); after.set("src/App.tsx", "// changed\nexport function App() { return <h1>Original</h1>; }");
    expect(() => assessEditOutcome("Add comparison", before, after)).toThrow(/no meaningful/);
  });
  it("distinguishes CSS-only partial pricing work from a valid styling edit", () => {
    const after = new Map(before); after.set("src/theme.css", "body {color:green}");
    expect(() => assessEditOutcome("Increase pricing by 15%", before, after)).toThrow(/styling changes alone/);
    expect(assessEditOutcome("Change the theme to green", before, after).outcome).toBe("APPLIED");
  });
  it("records changed calculation source without claiming semantic proof from that diff", () => {
    const a = new Map([["src/amount.ts", "export const total = price * quantity;"]]);
    const b = new Map([["src/amount.ts", "export const total = price * 1.15 * quantity;"]]);
    expect(assessEditOutcome("Increase pricing by 15%", a, b)).toEqual({ outcome: "APPLIED", changedPaths: ["src/amount.ts"] });
  });
});

describe("Offline no-op persistence and accounting", () => {
  it.each(["unchanged", "review", "applied", "missing-anchor"] as const)("handles %s without false success or duplicate billing", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "intelligent-edit-"));
    const execution = new MockExecutionProvider();
    const execute = execution.executeCommand.bind(execution);
    vi.spyOn(execution, "executeCommand").mockImplementation(async (id, command) => {
      if (command.args?.[0] === "ci") { const now = new Date(); return { exitCode: 0, stdout: "offline install", stderr: "", timedOut: false,
        durationMs: 0, startedAt: now, finishedAt: now }; }
      const result = await execute(id, command);
      if (result.exitCode === 0) await execution.writeFile(id, "dist/index.html", '<div id="root"></div>');
      return result;
    });
    const mock = new MockAgentProvider({ customResponse: request => ({ id: "offline-edit", model: request.model,
      message: { role: "assistant", content: JSON.stringify({ patches: [{ path: "src/App.tsx", mode: "unique",
        find: scenario === "missing-anchor" ? "absent source" : "<h1>Original</h1>",
        replace: scenario === "applied" ? "<h1>Updated</h1>" : "<h1>Original</h1>" }] }) },
      toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 }, latencyMs: 0, finishReason: "stop" }) });
    const provider = { id: "offline-edit-fixture", getCapabilities: () => mock.getCapabilities(), createResponse: mock.createResponse.bind(mock) };
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const finalize = vi.fn(async (job: import("../src/sites/domain/entities.js").SiteJob) => ({ ...job, billingStatus: "CHARGED" as const, creditsCharged: 1 }));
    const preflight = vi.fn(async () => ({ ownerId: "offline", modelRate: { model: "mock-sites-v1", platform: "mock-agent", type: "ai_chat", creditsPer500Tokens: 1 } }));
    const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), execution: execution as never,
      agentRegistry: registry, orchestrationAgent: provider, billing: { preflight, finalizeSuccessfulJob: finalize } as unknown as SiteCreditBillingService });
    const siteId = "intelligent-edit-project" as SiteId, ownerId = "offline" as UserId, versionId = "initial-version" as VersionId;
    const original = "export function App(){return <main><h1>Original</h1></main>}";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<div id="root"></div>'));
    try {
      const environment = await execution.createEnvironment({});
      for (const [path, content] of Object.entries({ "src/App.tsx": original, "src/main.tsx": "// managed entry", "index.html": '<div id="root"></div>',
        "package.json": JSON.stringify({ scripts: { build: "vite build" } }) })) await execution.writeFile(environment.id, path, content);
      const sourceRef = "sites/intelligent-edit-project/current/source.json";
      await new SiteSourceSnapshotService(product.artifacts).capture(execution as never, environment.id, sourceRef, {
        technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1 });
      const initialBytes = await product.artifacts.get(sourceRef);
      await execution.destroyEnvironment(environment.id);
      const now = new Date();
      await product.projects.save({ id: siteId, ownerId, name: "Existing", slug: "existing", status: "ACTIVE", latestVersionId: versionId, createdAt: now, updatedAt: now });
      await product.versions.save({ id: versionId, siteId, versionNumber: 1, sourceArtifactRef: sourceRef, buildStatus: "SUCCEEDED", createdAt: now });
      const save = vi.spyOn(product.versions, "save");
      const promise = product.pipeline.edit({ userId: ownerId, siteId, instruction: scenario === "review" ? "Review the website and fix verified issues" : "Change the heading",
        agentProvider: provider.id, browserQAEnabled: false });
      if (scenario === "unchanged" || scenario === "missing-anchor") {
        await expect(promise).rejects.toMatchObject({ code: scenario === "unchanged" ? "EDIT_REQUIREMENT_INCOMPLETE" : "VALIDATION_FAILED" });
      } else {
        const result = await promise;
        expect(result.editOutcome).toBe(scenario === "review" ? "NO_CHANGES_REQUIRED" : "APPLIED");
        expect(result.newVersionId === versionId).toBe(scenario === "review");
      }
      expect(finalize).toHaveBeenCalledTimes(scenario === "applied" ? 1 : 0);
      expect(save).toHaveBeenCalledTimes(scenario === "applied" ? 1 : 0);
      const jobs = (await product.jobs.listBySite(siteId)).items;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.physicalRequests).toBe(1);
      expect(jobs[0]!.inputTokens).toBe(20);
      if (scenario !== "applied") {
        expect(jobs[0]!.creditsCharged).toBe(0);
        expect(jobs[0]!.billingStatus).toBe("NOT_CHARGED");
        expect((await product.projects.getById(siteId))!.latestVersionId).toBe(versionId);
        expect(await product.artifacts.get(sourceRef)).toEqual(initialBytes);
      }
    } finally { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

describe("Adaptive context patch boundaries", () => {
  it("adds a new component and wires it through an exact existing-source patch atomically", async () => {
    const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
    const source = "export function Shell(){return <main>Home</main>}";
    await execution.writeFile(environment.id, "src/Shell.tsx", source);
    const required = new Map([["src/Shell.tsx", source]]);
    await applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({ patches: [
      { path: "src/Comparison.tsx", find: "", replace: "export function Comparison(){return <section>Comparison</section>}", mode: "create" },
      { path: "src/Shell.tsx", find: source, replace: 'import {Comparison} from "./Comparison";export function Shell(){return <main><Comparison/></main>}', mode: "unique" },
    ] }), { instruction: "Add a comparison component to the page", relevantPaths: ["src/Shell.tsx"], requirementSource: required,
      sourceRanges: new Map([["src/Shell.tsx", [{ start: 0, end: source.length }]]]) });
    expect(await execution.readFile(environment.id, "src/Comparison.tsx")).toContain("export function Comparison");
    expect(await execution.readFile(environment.id, "src/Shell.tsx")).toContain("<Comparison/>");
  });
  it("rejects rewriting an unseen region without applying another valid operation", async () => {
    const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
    const source = "export const seen = 1;\nexport const unseen = 2;";
    await execution.writeFile(environment.id, "src/state.ts", source);
    await expect(applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({ patches: [
      { path: "src/New.ts", find: "", replace: "export const value = 3;", mode: "create" },
      { path: "src/state.ts", find: "unseen = 2", replace: "unseen = 3", mode: "unique" },
    ] }), { instruction: "Change the state", relevantPaths: ["src/state.ts"], requirementSource: new Map([["src/state.ts", source]]),
      sourceRanges: new Map([["src/state.ts", [{ start: 0, end: 22 }]]]) })).rejects.toMatchObject({ metadata: { reason: "PATCH_OUTSIDE_SUPPLIED_REGIONS" } });
    expect(await execution.fileExists(environment.id, "src/New.ts")).toBe(false);
    expect(await execution.readFile(environment.id, "src/state.ts")).toBe(source);
  });
  it("never uses create to overwrite an existing file", async () => {
    const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/state.ts", "export const old = 1;");
    await expect(applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({ patches: [
      { path: "src/state.ts", find: "", replace: "export const newValue = 2;", mode: "create" },
    ] }), { instruction: "Add state", relevantPaths: [], requirementSource: new Map([["src/state.ts", "export const old = 1;"]]) })).rejects.toThrow(/overwrite/);
  });
});

describe("Adaptive complete-region selection", () => {
  it("keeps the verified 21,572-byte file whole when it fits", () => {
    const content = 'export function Pricing(){return <p>Pricing</p>}\n/*' + "x".repeat(21_520) + "*/";
    const selected = selectAdaptiveEditContext({ files: [{ path: "src/Pricing.tsx", content }], instruction: "Change pricing", maxBytes: 64_000 });
    expect(selected.files[0]).toMatchObject({ content, full: true });
  });
  it("selects complete functions, imports, types and data from a file above 128 KiB", () => {
    const price = 'export function calculateTotal(price: Money, count: number){return price * count;}';
    const source = 'import type {Money} from "./models";\nconst unused = "' + "x".repeat(150_000) + '";\n' + price;
    const selected = selectAdaptiveEditContext({ files: [{ path: "src/commerce.ts", content: source },
      { path: "src/models.ts", content: "export type Money = number;" }], instruction: "Update calculateTotal pricing calculation", maxBytes: 32_000 });
    expect(selected.usesRegions).toBe(true);
    expect(selected.files.find(f => f.path === "src/commerce.ts")!.content).toContain(price);
    expect(selected.files.find(f => f.path === "src/commerce.ts")!.content).toContain('import type {Money}');
    expect(selected.files.find(f => f.path === "src/commerce.ts")!.content).not.toContain("const unused");
    expect(selected.files.some(f => f.path === "src/models.ts")).toBe(true);
  });
  it("includes cross-page state dependencies in arbitrary layouts", () => {
    const files = [
      { path: "src/views/Listing.tsx", content: 'import {selection} from "../shared/selection";export function Listing(){return <button onClick={()=>selection.push(1)}>Compare</button>}' },
      { path: "src/views/Details.tsx", content: 'import {selection} from "../shared/selection";export function Details(){return <p>{selection.length}</p>}' },
      { path: "src/shared/selection.ts", content: "export const selection: number[] = [];" },
    ];
    const selected = selectAdaptiveEditContext({ files, instruction: "Update comparison selection across pages", maxBytes: 64_000 });
    expect(selected.files.map(f => f.path)).toEqual(expect.arrayContaining(files.map(f => f.path)));
  });
  it("does not send only CSS for an interaction request", () => {
    expect(() => selectAdaptiveEditContext({ files: [{ path: "src/theme.css", content: ":root{color:red}" }], instruction: "Add comparison functionality", maxBytes: 64_000 }))
      .toThrow(/APPLICATION_SOURCE_MISSING/);
  });
  it("rejects missing local dependencies before inference", () => {
    expect(() => selectAdaptiveEditContext({ files: [{ path: "src/Shop.tsx", content: 'import {total} from "./missing";export function Shop(){return <p>{total}</p>}' }],
      instruction: "Change the total calculation", maxBytes: 64_000 })).toThrow(/LOCAL_IMPORT_SOURCE_MISSING/);
  });
  it("cannot shrink a required huge literal by arbitrary slicing", () => {
    expect(() => selectAdaptiveEditContext({ files: [{ path: "src/catalog.ts", content: 'export const pricing = "' + "x".repeat(150_000) + '";' }],
      instruction: "Change pricing", maxBytes: 16_000 })).toThrow(/REQUIRED_SOURCE_EXCEEDS_CONTEXT_LIMIT/);
  });
  it("respects a token allowance smaller than the byte allowance", () => {
    expect(() => selectAdaptiveEditContext({ files: [{ path: "src/data.ts", content: 'export const pricing = "' + "x".repeat(8_000) + '";' }],
      instruction: "Change pricing", maxBytes: 64_000, maxInputTokens: 1_000 })).toThrow(/CONTEXT/);
  });
});

describe("Visible edit verification", () => {
  const app = 'import {Events} from "./pages/Events";export function App(){return <Routes><Route path="/" element={<Events/>}/></Routes>}';
  const events = 'export function Events(){return <section className="events-grid"><article className={`card-${"featured"}`}>Gala</article></section>}';
  const css = ".events-grid{display:grid}\n.card-featured{color:red}";
  const before = new Map([["src/App.tsx", app], ["src/pages/Events.tsx", events], ["src/styles.css", css]]);
  const edit = (changes: Record<string, string>) => new Map([...before, ...Object.entries(changes)]);
  const failureOf = (run: () => unknown): unknown => { try { run(); } catch (error) { return error; } return undefined; };

  it("rejects a new component that nothing imports and keeps the prior version authoritative", () => {
    const after = edit({ "src/pages/OrganizerStudio.tsx": "export function OrganizerStudio(){return <main>Studio</main>}" });
    expect(failureOf(() => assessEditOutcome("Add an Organizer Studio page", before, after)))
      .toMatchObject({ code: "EDIT_REQUIREMENT_INCOMPLETE", metadata: { reason: "UNWIRED_NEW_MODULE", paths: ["src/pages/OrganizerStudio.tsx"] } });
  });
  it("rejects a module reachable only from another orphaned new module", () => {
    const after = edit({ "src/pages/Studio.tsx": 'import {Panel} from "./Panel";export function Studio(){return <Panel/>}', "src/pages/Panel.tsx": "export function Panel(){return <p/>}" });
    expect(() => assessEditOutcome("Add a studio page", before, after)).toThrow(/never imports/);
  });
  it("accepts a new component wired through a route", () => {
    const after = edit({ "src/pages/OrganizerStudio.tsx": "export function OrganizerStudio(){return <main>Studio</main>}",
      "src/App.tsx": app.replace("</Routes>", '<Route path="/studio" element={<OrganizerStudio/>}/></Routes>').replace("import", 'import {OrganizerStudio} from "./pages/OrganizerStudio";import') });
    expect(assessEditOutcome("Add an Organizer Studio page", before, after).outcome).toBe("APPLIED");
  });
  it("does not guess reachability when modules are loaded by glob", () => {
    const after = edit({ "src/App.tsx": app + 'const pages = import.meta.glob("./pages/*.tsx");', "src/pages/Studio.tsx": "export function Studio(){return <p/>}" });
    expect(assessEditOutcome("Add a studio page", before, after).outcome).toBe("APPLIED");
  });
  it("rejects a style-only redesign that targets classes absent from the markup", () => {
    const after = edit({ "src/styles.css": css + "\n.explore-events-layout{gap:2rem}\n.explore-hero-banner{padding:4rem}" });
    expect(failureOf(() => assessEditOutcome("Redesign the Explore Events section", before, after)))
      .toMatchObject({ code: "EDIT_REQUIREMENT_INCOMPLETE", metadata: { reason: "NO_VISIBLE_EFFECT" } });
  });
  it("accepts style changes to used, composed, element and removed selectors", () => {
    for (const next of [css.replace("display:grid", "display:flex"), css.replace("color:red", "color:blue"),
      css + "\nsection h2{margin:0}", ".card-featured{color:red}", css + "\n@media (min-width: 40rem){.events-grid{gap:1rem}}"])
      expect(assessEditOutcome("Redesign the events section", before, edit({ "src/styles.css": next })).outcome).toBe("APPLIED");
  });
  it("accepts new classes when the markup change adds them in the same edit", () => {
    const after = edit({ "src/styles.css": css + "\n.events-hero{padding:4rem}", "src/pages/Events.tsx": events.replace("events-grid", "events-grid events-hero") });
    expect(assessEditOutcome("Redesign the events hero", before, after).outcome).toBe("APPLIED");
  });
  it("rejects pricing work that only styles nonexistent selectors and accepts shared pricing data changes", () => {
    const pricing = new Map([...before, ["src/data/pricing.ts", "export const tiers = [{ name: 'Pro', price: 49 }];"]]);
    expect(() => assessEditOutcome("Update pricing to 59", pricing, new Map([...pricing, ["src/styles.css", css + "\n.price-badge{color:gold}"]]))).toThrow(/no visible effect/);
    expect(assessEditOutcome("Update pricing to 59", pricing, new Map([...pricing, ["src/data/pricing.ts", "export const tiers = [{ name: 'Pro', price: 59 }];"]])).outcome).toBe("APPLIED");
  });
});

describe("Adaptive selection for modular applications", () => {
  const filler = (name: string) => ({ path: `src/pages/${name}.tsx`, content: `export function ${name}(){return <section className="${name.toLowerCase()}">${"Lorem ipsum dolor. ".repeat(900)}</section>}` });
  const files = [
    { path: "src/App.tsx", content: 'import {Events} from "./pages/Events";import {About} from "./pages/About";import {Blog} from "./pages/Blog";export function App(){return <Routes><Route path="/" element={<Events/>}/><Route path="/about" element={<About/>}/><Route path="/blog" element={<Blog/>}/></Routes>}' },
    { path: "src/pages/Events.tsx", content: 'export function Events(){return <section className="events-grid">Events</section>}' },
    { path: "src/styles.css", content: ":root{--accent:#f00}\n.events-grid{display:grid}" },
    filler("About"), filler("Blog"),
  ];
  it("keeps a styling-only edit to styles and the affected component, not unrelated pages", () => {
    const selected = selectAdaptiveEditContext({ files, instruction: "Change the events grid styling to use more spacing", maxBytes: 64_000 });
    const paths = selected.files.map(f => f.path);
    expect(paths).toEqual(expect.arrayContaining(["src/styles.css", "src/pages/Events.tsx"]));
    expect(paths).not.toContain("src/pages/Blog.tsx");
  });
  it("includes the route owner for a new page request", () => {
    const selected = selectAdaptiveEditContext({ files, instruction: "Add an Organizer Studio page with a new route", maxBytes: 64_000 });
    expect(selected.files.map(f => f.path)).toContain("src/App.tsx");
    expect(selected.repositoryMap).toContain("routes=/,/about,/blog");
  });
});
