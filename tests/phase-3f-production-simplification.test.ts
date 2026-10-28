import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { analyzeRequestProfile } from "../src/sites/generation/request-profile.js";
import {
  SITE_CODER_FILE_BUNDLE_JSON_SCHEMA,
  validateSiteCoderFileBundle,
  validateBuildRepairPatchBundle,
  materializeSiteCoderFileBundle,
  validateSiteCoderBundleCompletion,
} from "../src/cli/runtime/site-coder-file-bundle.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { applyDeterministicAutofix } from "../src/sites/generation/deterministic-autofix.js";
import { validateAssetReferences } from "../src/sites/assets/asset-reference-validator.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { resolveCapabilities } from "../src/sites/generation/capability-resolver.js";
import type { UserId } from "../src/shared/types.js";
import { SITES_SITE_CODER_PROMPT_V4 } from "../src/agents/prompts/sites-site-coder-v4.prompt.js";
import { DeterministicRequirementsPlanner } from "../src/planning/planning.js";

describe("Layer 3F production simplification", () => {
  it("keeps the scaffold stylesheet when the model returns only App.tsx", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/styles.css", "/* scaffold baseline */\nbody { margin: 0; }");
    const bundle = validateSiteCoderFileBundle({ files: [
      { path: "src/App.tsx", content: "export default function App() { return <main><h1>NovaChat</h1></main>; }" },
    ] }, { requiredFiles: ["src/App.tsx"], requiredPages: ["home", "dashboard"], requiredSections: ["hero"], requireNavigation: true, requireResponsiveImplementation: true });
    await materializeSiteCoderFileBundle(execution, environment.id, bundle);
    expect(await execution.readFile(environment.id, "src/styles.css")).toContain("scaffold baseline");
    await expect(validateSiteCoderBundleCompletion(execution, environment.id, bundle, {
      requiredFiles: ["src/App.tsx"], requiredPages: ["home", "dashboard"], requiredSections: ["hero"], requireNavigation: true, requireResponsiveImplementation: true, requireScaffoldBaseline: false,
    })).resolves.toMatchObject({ valid: true, issues: [] });
  });

  it("accepts a custom stylesheet without requiring src/styles.css in the bundle", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    const requirements = { requiredFiles: ["src/App.tsx"], requiredPages: ["home"], requiredSections: ["hero"], requireNavigation: false, requireResponsiveImplementation: true, requireScaffoldBaseline: false } as const;
    const bundle = validateSiteCoderFileBundle({ files: [
      { path: "src/App.tsx", content: 'import "./app.css"; export function App() { return <main>Hero</main>; }' },
      { path: "src/app.css", content: "main { padding: 2rem; }" },
    ] }, requirements);
    await materializeSiteCoderFileBundle(execution, environment.id, bundle);
    await expect(validateSiteCoderBundleCompletion(execution, environment.id, bundle, requirements)).resolves.toMatchObject({ valid: true });
  });

  it("still rejects malformed bundles and a missing App.tsx entry clearly", () => {
    expect(() => validateSiteCoderFileBundle({ files: "invalid" })).toThrow(/files array/);
    expect(() => validateSiteCoderFileBundle({ files: [{ path: "src/app.css", content: "body {}" }] }, {
      requiredFiles: ["src/App.tsx"], requiredPages: [], requiredSections: [], requireNavigation: false, requireResponsiveImplementation: false,
    })).toThrow(/missing required file: src\/App\.tsx/i);
  });

  it("exposes a compact validated siteName in the existing generation bundle", () => {
    expect(SITE_CODER_FILE_BUNDLE_JSON_SCHEMA).toMatchObject({
      required: ["siteName", "files"],
      properties: { siteName: { type: "string", minLength: 1, maxLength: 60 } },
    });
    expect(validateSiteCoderFileBundle({
      siteName: "  NOMA Living  ",
      files: [{ path: "src/App.tsx", content: "export function App() { return <main />; }" }],
    }).siteName).toBe("NOMA Living");
    expect(validateSiteCoderFileBundle({
      siteName: "Attached Reference",
      files: [{ path: "src/App.tsx", content: "export function App() { return <main />; }" }],
    }).siteName).toBeUndefined();
  });

  it("normalizes safe model paths and lets generated styles overlay the scaffold", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/styles.css", "/* scaffold */");
    const bundle = validateSiteCoderFileBundle({ files: [
      { path: "./src/App.tsx", content: "export function App() { return <main />; }" },
      { path: "src\\styles.css", content: "/* generated */" },
    ] }, { requiredFiles: ["src/App.tsx"], requiredPages: [], requiredSections: [], requireNavigation: false, requireResponsiveImplementation: false });
    expect(bundle.files.map(({ path }) => path)).toEqual(["src/App.tsx", "src/styles.css"]);
    await materializeSiteCoderFileBundle(execution, environment.id, bundle);
    expect(await execution.readFile(environment.id, "src/styles.css")).toBe("/* generated */");
  });

  it("rejects traversal, environment, dependency, and managed bootstrap paths", () => {
    for (const path of ["../../secret.ts", ".env", "node_modules/foo.ts", "src/main.tsx", "src/vite-env.d.ts"]) {
      expect(() => validateSiteCoderFileBundle({ files: [{ path, content: "x" }] })).toThrow(/managed|disallowed/i);
    }
  });

  it("does not infer menu or dashboard pages from generic UI terminology", async () => {
    const planner = new DeterministicRequirementsPlanner();
    const generic = await planner.plan("Build an app with a mobile navigation menu button and an example src/components/Dashboard.tsx file");
    expect(generic.pages.map(({ path }) => path)).toEqual(["/"]);
    const explicit = await planner.plan("Pages: Home, Menu, Dashboard");
    expect(explicit.pages.map(({ path }) => path)).toEqual(["/", "/menu", "/dashboard"]);
  });
  it("tells the active site coder to use local/system fonts", () => {
    expect(SITES_SITE_CODER_PROMPT_V4).toContain("do not import Google Fonts");
    expect(SITES_SITE_CODER_PROMPT_V4).toContain("fonts.googleapis.com");
    expect(SITES_SITE_CODER_PROMPT_V4).toContain("fonts.gstatic.com");
    expect(SITES_SITE_CODER_PROMPT_V4).not.toContain("must contain complete, non-empty src/App.tsx and src/styles.css");
    expect(SITES_SITE_CODER_PROMPT_V4).toContain("src/App.tsx is the application entry component");
  });
  it("rejects unsupported requests before a coder call and reports zero physical requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-preflight-"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), keepWorkspace: false });
    try {
      await expect(product.orchestrator.generateWebsite({
        userId: "preflight-user" as UserId,
        prompt: "Create a website with a custom database server",
        planningMode: "agent-with-fallback",
        agentProvider: "mock",
      })).rejects.toMatchObject({ code: "UNSUPPORTED_SITE_REQUIREMENT" });
      const log = info.mock.calls.map((args) => String(args[0])).find((line) => line.includes("SITES TOKEN USAGE"));
      expect(log).toContain("Failure Stage: REQUEST_VALIDATION");
      expect(log).toContain("Logical Calls: 0\nPhysical Requests: 0\nRetries: 0");
      expect(log).toContain("Model Output Received: NO");
    } finally {
      info.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("removes Google Fonts CSS loads before strict asset validation without touching fallback fonts", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/styles.css", '@import url("https://fonts.googleapis.com/css2?family=DM+Sans&display=swap");\nbody { font-family: "DM Sans", sans-serif; }');
    await expect(validateAssetReferences(execution, environment.id)).rejects.toMatchObject({ code: "ASSET_REFERENCE_INVALID" });
    const result = await applyDeterministicAutofix(execution, environment.id);
    expect(result.fixes.map(({ id }) => id)).toContain("REMOTE_GOOGLE_FONT_CLEANUP");
    const css = await execution.readFile(environment.id, "src/styles.css");
    expect(css).not.toContain("fonts.googleapis.com");
    expect(css).toContain('font-family: "DM Sans", sans-serif');
    await expect(validateAssetReferences(execution, environment.id)).resolves.toEqual([]);
    expect((await applyDeterministicAutofix(execution, environment.id)).changed).toBe(false);
  });

  it("handles quoted Google CSS imports and direct gstatic imports", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/styles.css", '@import "https://fonts.googleapis.com/css2?family=Inter";\n@import url(https://fonts.gstatic.com/s/inter.woff2);\nbody { font-family: Inter, system-ui; }');
    await applyDeterministicAutofix(execution, environment.id);
    const css = await execution.readFile(environment.id, "src/styles.css");
    expect(css).not.toContain("fonts.googleapis.com");
    expect(css).not.toContain("fonts.gstatic.com");
    expect(css).toContain("font-family: Inter, system-ui");
    await expect(validateAssetReferences(execution, environment.id)).resolves.toEqual([]);
  });

  it("removes multiline Google stylesheet links and font-face loads but preserves unrelated links", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "index.html", '<link\n rel="stylesheet"\n href="https://fonts.googleapis.com/css2?family=DM+Sans"\n>');
    await execution.writeFile(environment.id, "src/styles.css", '@font-face { font-family: DM; src: url("https://fonts.gstatic.com/s/dm.woff2"); }');
    const result = await applyDeterministicAutofix(execution, environment.id);
    expect(result.fixes.map(({ id }) => id)).toContain("REMOTE_GOOGLE_FONT_CLEANUP");
    expect(await execution.readFile(environment.id, "index.html")).not.toContain("fonts.googleapis.com");
    expect(await execution.readFile(environment.id, "src/styles.css")).not.toContain("fonts.gstatic.com");
    await expect(validateAssetReferences(execution, environment.id)).resolves.toEqual([]);
  });

  it("does not clean arbitrary external stylesheets and still rejects them", async () => {
    for (const [path, source] of [
      ["src/styles.css", '@import "https://malicious-or-random.example/style.css";'],
      ["index.html", '<link rel="stylesheet" href="https://malicious-or-random.example/style.css">'],
    ]) {
      const execution = new MockExecutionProvider();
      const environment = await execution.createEnvironment({});
      await execution.writeFile(environment.id, path!, source!);
      await applyDeterministicAutofix(execution, environment.id);
      expect(await execution.readFile(environment.id, path!)).toContain("malicious-or-random.example");
      await expect(validateAssetReferences(execution, environment.id)).rejects.toMatchObject({ code: "ASSET_REFERENCE_INVALID" });
    }
  });
  it("routes normal and complex requests deterministically", () => {
    expect(analyzeRequestProfile("Create a six-page dental marketing site")).toMatchObject({
      complexity: "NORMAL",
      needsAgentPlanning: false,
    });
    expect(analyzeRequestProfile("Create an authenticated admin dashboard with approval workflow")).toMatchObject({
      complexity: "COMPLEX",
      needsAgentPlanning: true,
    });
  });

  it("keeps the coder response source-only and rejects managed-file attacks", () => {
    expect(() => validateSiteCoderFileBundle({ files: [
      { path: "package.json", content: "{}" },
    ] })).toThrow(/managed|disallowed/i);
    expect(() => validateSiteCoderFileBundle({ files: [
      { path: "src/App.tsx", content: "x" },
      { path: "src/App.tsx", content: "y" },
    ] })).toThrow(/duplicate/i);
    expect(() => validateBuildRepairPatchBundle({ patches: [
      { path: "package-lock.json", find: "x", replace: "y" },
    ] })).toThrow(/managed|disallowed/i);
  });

  it("uses one normal coder request with no planner or repair request", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-layer-3f-"));
    const product = createLocalSitesProduct({
      executionRoot: join(root, "execution"),
      artifactRoot: join(root, "artifacts"),
      keepWorkspace: false,
    });
    try {
      const result = await product.orchestrator.generateWebsite({
        userId: "layer-3f-user" as UserId,
        prompt: "Create a static marketing site for a local studio",
        planningMode: "agent-with-fallback",
        agentProvider: "mock",
      });
      expect(result.requestProfile?.complexity).toBe("NORMAL");
      expect(result.inference).toMatchObject({ logicalRequests: 1, physicalRequests: 1 });
      expect(result.inference?.stages.SITE_PLANNING.logicalRequests ?? 0).toBe(0);
      expect(result.inference?.stages.GENERATE_SITE.logicalRequests).toBe(1);
      expect(result.usage.modelCalls).toBe(1);
      expect(resolveCapabilities(result.siteSpec).capabilities.some(({ id }) => id === "motion-basic")).toBe(false);
      const snapshot = JSON.parse(
        Buffer.from((await product.artifacts.get(result.sourceArtifactRef))!).toString("utf8"),
      ) as { files: Record<string, string> };
      expect(snapshot.files["src/styles.css"]).toContain("transition: transform 300ms ease");
      expect(snapshot.files["src/styles.css"]).toContain("transition: opacity 0.3s ease-out");
      expect(snapshot.files["src/styles.css"]).toContain("@keyframes fadeIn");
      expect(snapshot.files["src/styles.css"]).toContain("prefers-reduced-motion");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("materializes, typechecks, and builds a complex multi-file source bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-multifile-"));
    const provider = new MockAgentProvider({
      customResponse: async (request) => ({
        id: "multi-file-response",
        model: request.model,
        message: { role: "assistant", content: JSON.stringify({ files: [
          { path: "./src/App.tsx", content: 'import "./app.css";\nimport { Sidebar } from "./components/Sidebar";\nimport { ChatView } from "./views/ChatView";\nexport function App() { return <div className="shell" aria-label="AI Sites Generated Hero"><Sidebar /><ChatView /></div>; }\n' },
          { path: "src\\components\\Sidebar.tsx", content: 'import { useState } from "react";\nexport function Sidebar() { const [section, setSection] = useState("AI Chat"); return <nav aria-label="Workspace"><button type="button" onClick={() => setSection("AI Chat")}>AI Chat</button><button type="button" onClick={() => setSection("Settings")}>Settings</button><p role="status">Current section: {section}</p></nav>; }\n' },
          { path: "src/views/ChatView.tsx", content: 'import { useState } from "react";\nexport function ChatView() { const [value, setValue] = useState(""); const [sent, setSent] = useState(""); return <main><h1>AI Sites Generated Hero</h1><p>NovaChat workspace</p><textarea aria-label="Prompt" value={value} onChange={(event) => setValue(event.target.value)} /><button type="button" onClick={() => { setSent(value); setValue(""); }}>Send</button><p role="status">Local demo message: {sent}</p></main>; }\n' },
          { path: "src/app.css", content: '.shell { display: grid; grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr); min-height: 100vh; } nav, main { padding: 1rem; } @media (max-width: 700px) { .shell { grid-template-columns: 1fr; } }\n' },
        ] }) },
        toolCalls: [],
        usage: { inputTokens: 400, cachedInputTokens: 300, outputTokens: 500, totalTokens: 900 },
        latencyMs: 1,
        finishReason: "stop",
      }),
    });
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const product = createLocalSitesProduct({
      executionRoot: join(root, "execution"),
      artifactRoot: join(root, "artifacts"),
      agentRegistry: registry,
      orchestrationAgent: provider,
      keepWorkspace: false,
    });
    try {
      const result = await product.orchestrator.generateWebsite({
        userId: "multi-file-user" as UserId,
        prompt: "Create a polished multi-view frontend product demo with a sidebar and interactive chat composer",
        planningMode: "deterministic",
        agentProvider: "mock",
        browserQAEnabled: false,
      });
      expect(result.build.success).toBe(true);
      expect(result.inference).toMatchObject({ logicalRequests: 1, physicalRequests: 1 });
      const snapshot = JSON.parse(Buffer.from((await product.artifacts.get(result.sourceArtifactRef))!).toString("utf8")) as { files: Record<string, string> };
      expect(snapshot.files["src/components/Sidebar.tsx"]).toContain("Workspace");
      expect(snapshot.files["src/views/ChatView.tsx"]).toContain("useState");
      expect(snapshot.files["src/app.css"]).toContain("grid-template-columns");
      expect(snapshot.files["src/styles.css"]).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("preserves exact build diagnostics and invokes Build Repair at most once", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-bounded-repair-"));
    const requests: string[] = [];
    const provider = new MockAgentProvider({
      customResponse: async (request) => {
        requests.push(request.messages.at(-1)?.content ?? "");
        const repair = request.responseContract?.type === "JSON_SCHEMA" &&
          request.responseContract.name === "BuildRepairPatchBundle";
        return {
          id: repair ? "repair-response" : "coder-response",
          model: request.model,
          message: { role: "assistant", content: repair
            ? JSON.stringify({ patches: [] })
            : JSON.stringify({ files: [{
                path: "src/App.tsx",
                content: 'const brokenValue: string = 123;\nexport function App() { return <main aria-label="AI Sites Generated Hero">Broken</main>; }\n',
              }] }) },
          toolCalls: [],
          usage: repair
            ? { inputTokens: 50, outputTokens: 20, totalTokens: 70 }
            : { inputTokens: 200, cachedInputTokens: 150, outputTokens: 100, totalTokens: 300 },
          latencyMs: 1,
          finishReason: "stop" as const,
        };
      },
    });
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const product = createLocalSitesProduct({
      executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"),
      agentRegistry: registry, orchestrationAgent: provider, keepWorkspace: false,
    });
    try {
      let failure: unknown;
      try {
        await product.orchestrator.generateWebsite({
          userId: "repair-user" as UserId,
          prompt: "Create a static product landing page",
          planningMode: "deterministic",
          agentProvider: "mock",
          browserQAEnabled: false,
        });
      } catch (cause) { failure = cause; }
      const compilerDiagnostic: unknown = expect.stringContaining("TS2322");
      expect(failure).toMatchObject({
        code: "REPAIR_LIMIT_REACHED",
        metadata: {
          repairAttempts: 1,
          diagnostics: compilerDiagnostic,
        },
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain("Type 'number' is not assignable to type 'string'");
      expect(requests[1]).toContain("Relevant source files:");
      expect(requests[1]).toContain("Current dependency manifest:");
      const tokenLog = info.mock.calls.map((args) => String(args[0])).find((line) => line.includes("SITES TOKEN USAGE"));
      expect(tokenLog).toContain("Output Tokens: 120");
      expect(tokenLog).toContain("Model Output Received: YES");
      expect(tokenLog).toContain("Website Generated: NO");
    } finally {
      info.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("normalizes only an unambiguous TypeScript/Vite import and is idempotent", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/App.tsx", "export const App = () => null;\n");
    await execution.writeFile(environment.id, "src/entry.tsx", 'import App from "./App.js";\nvoid App;\n');

    const first = await applyDeterministicAutofix(execution, environment.id);
    expect(first.changed).toBe(true);
    expect(first.fixes[0]?.id).toBe("IMPORT_SPECIFIER_NORMALIZATION");
    expect(await execution.readFile(environment.id, "src/entry.tsx")).toContain('"./App"');

    const second = await applyDeterministicAutofix(execution, environment.id);
    expect(second).toEqual({ changed: false, fixes: [] });
  });

  it("adds an idempotent responsive safety guard without weakening overflow QA", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/styles.css", "body { color: red; }\n");

    const first = await applyDeterministicAutofix(execution, environment.id);
    expect(first.fixes.map(({ id }) => id)).toEqual(["RESPONSIVE_LAYOUT_SAFETY_GUARD", "INTRINSIC_GRID_SIZING_GUARD"]);
    expect(await execution.readFile(environment.id, "src/styles.css")).toContain(
      "Sites deterministic responsive safety guard",
    );
    expect(await execution.readFile(environment.id, "src/styles.css")).toContain("Sites intrinsic grid sizing guard");

    const second = await applyDeterministicAutofix(execution, environment.id);
    expect(second).toEqual({ changed: false, fixes: [] });
  });
});
