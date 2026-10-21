import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import {
  validateSiteEditPatchBundle,
  applySiteEditPatchBundle,
} from "../src/cli/runtime/site-coder-file-bundle.js";
import {
  selectEditContextFiles,
  isBroadFunctionalEdit,
  broadFunctionalEditChangesStyle,
  BASELINE_STYLESHEET,
  designTokenExcerpt,
} from "../src/cli/runtime/edit-context-selection.js";
import { styleSheetForSeed } from "../src/sites/scaffold/react-vite-scaffold.js";
import { mapAgentRequest } from "../src/agents/openai/openai-agent.mapper.js";
import { openAIPromptCacheKey } from "../src/agents/openai/prompt-cache-key.js";
import { EMBER_GRAIN_FILES } from "./fixtures/ember-grain-site.js";
import type { UserId } from "../src/shared/types.js";

const HEADER = EMBER_GRAIN_FILES.find((file) => file.path === "src/components/SiteHeader.tsx")!.content;

async function workspaceWith(files: readonly { path: string; content: string }[]) {
  const execution = new MockExecutionProvider();
  const environment = await execution.createEnvironment({});
  for (const file of files) await execution.writeFile(environment.id, file.path, file.content);
  return { execution, environmentId: environment.id };
}

const patch = (overrides: Record<string, unknown>) =>
  validateSiteEditPatchBundle({
    patches: [{ path: "src/components/SiteHeader.tsx", mode: "unique", ...overrides }],
  });

describe("Targeted Edit patch contract", () => {
  it("applies a patch whose find text occurs exactly once", async () => {
    const { execution, environmentId } = await workspaceWith([
      { path: "src/components/SiteHeader.tsx", content: HEADER },
    ]);
    await applySiteEditPatchBundle(
      execution,
      environmentId,
      patch({ find: 'href="#services">Private dining', replace: 'href="#services">Events' }),
    );
    expect(await execution.readFile(environmentId, "src/components/SiteHeader.tsx")).toContain(
      ">Events<",
    );
  });

  it("rejects an ambiguous unique patch with the exact match count and path", async () => {
    const { execution, environmentId } = await workspaceWith([
      { path: "src/components/SiteHeader.tsx", content: HEADER },
    ]);
    // The brand appears twice in the header: as the link title and as its text.
    await expect(
      applySiteEditPatchBundle(
        execution,
        environmentId,
        patch({ find: "Ember &amp; Grain", replace: "Abdullah's Cafe" }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      metadata: { path: "src/components/SiteHeader.tsx", matches: 2, mode: "unique" },
    });
    // The file is left untouched when a patch is rejected.
    expect(await execution.readFile(environmentId, "src/components/SiteHeader.tsx")).toBe(HEADER);
  });

  it("accepts the same edit once the anchor carries surrounding context", async () => {
    const { execution, environmentId } = await workspaceWith([
      { path: "src/components/SiteHeader.tsx", content: HEADER },
    ]);
    await applySiteEditPatchBundle(
      execution,
      environmentId,
      patch({
        find: ">Ember &amp; Grain</a>",
        replace: ">Abdullah's Cafe</a>",
      }),
    );
    const source = await execution.readFile(environmentId, "src/components/SiteHeader.tsx");
    expect(source).toContain(">Abdullah's Cafe</a>");
    // The title attribute is a different occurrence and is deliberately untouched.
    expect(source).toContain('title="Ember &amp; Grain"');
  });

  it("replaces every occurrence in mode all for a deliberate rename", async () => {
    const { execution, environmentId } = await workspaceWith([
      { path: "src/components/SiteHeader.tsx", content: HEADER },
    ]);
    await applySiteEditPatchBundle(
      execution,
      environmentId,
      patch({ find: "Ember &amp; Grain", replace: "Abdullah's Cafe", mode: "all" }),
    );
    const source = await execution.readFile(environmentId, "src/components/SiteHeader.tsx");
    expect(source).not.toContain("Ember");
    expect(source.match(/Abdullah's Cafe/g)).toHaveLength(2);
  });

  it("fails with a clear diagnostic when the find text is absent", async () => {
    const { execution, environmentId } = await workspaceWith([
      { path: "src/components/SiteHeader.tsx", content: HEADER },
    ]);
    await expect(
      applySiteEditPatchBundle(execution, environmentId, patch({ find: "Nonexistent", replace: "x" })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { matches: 0 } });
  });

  describe("sequential patches on one file", () => {
    const HOME = [
      '<p className="eyebrow">FlowPilot</p>',
      '<p className="home-hero__lead">FlowPilot gives modern teams one clear place to plan.</p>',
      "<blockquote>“FlowPilot gave our team a common language.”</blockquote>",
    ].join("\n");
    const HERO = '<p className="home-hero__lead">FlowPilot gives modern teams one clear place to plan.</p>';
    const home = (patches: Record<string, unknown>[]) =>
      validateSiteEditPatchBundle({ patches: patches.map((item) => ({ path: "src/pages/HomePage.jsx", mode: "unique", ...item })) });

    it("rebases a hero rewrite written against the shown source after an earlier brand rename", async () => {
      const { execution, environmentId } = await workspaceWith([{ path: "src/pages/HomePage.jsx", content: HOME }]);
      await applySiteEditPatchBundle(execution, environmentId, home([
        { find: "FlowPilot", replace: "NovaPay", mode: "all" },
        { find: HERO, replace: '<p className="home-hero__lead">NovaPay is the AI-powered finance platform.</p>' },
      ]));
      const source = await execution.readFile(environmentId, "src/pages/HomePage.jsx");
      expect(source).toContain('<p className="home-hero__lead">NovaPay is the AI-powered finance platform.</p>');
      expect(source).not.toContain("FlowPilot");
      expect(source).toContain("“NovaPay gave our team a common language.”");
    });

    it("keeps exact matching first: a find already valid after earlier patches is used as-is", async () => {
      const { execution, environmentId } = await workspaceWith([{ path: "src/pages/HomePage.jsx", content: HOME }]);
      await applySiteEditPatchBundle(execution, environmentId, home([
        { find: "FlowPilot", replace: "NovaPay", mode: "all" },
        { find: HERO.replace("FlowPilot", "NovaPay"), replace: "<p>rewritten</p>" },
      ]));
      expect(await execution.readFile(environmentId, "src/pages/HomePage.jsx")).toContain("<p>rewritten</p>");
    });

    it("never rebases text the model invented or a near miss such as straight quotes", async () => {
      const { execution, environmentId } = await workspaceWith([{ path: "src/pages/HomePage.jsx", content: HOME }]);
      await expect(applySiteEditPatchBundle(execution, environmentId, home([
        { find: "FlowPilot", replace: "NovaPay", mode: "all" },
        { find: '"FlowPilot gave our team a common language."', replace: "x" },
      ]))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        metadata: { matches: 0, matchesInShownSource: 0, diagnostics: expect.stringContaining("FlowPilot gave our team") as string },
      });
    });

    it("rejects a rebased find that becomes ambiguous", async () => {
      const content = "<h2>Alpha</h2>\n<h2>Beta</h2>";
      const { execution, environmentId } = await workspaceWith([{ path: "src/pages/HomePage.jsx", content }]);
      await expect(applySiteEditPatchBundle(execution, environmentId, home([
        { find: "Beta", replace: "Alpha", mode: "all" },
        { find: "<h2>Beta</h2>", replace: "<h2>Gamma</h2>" },
      ]))).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { matches: 2 } });
    });

    it("fails a later patch whose region an earlier patch rewrote away", async () => {
      const { execution, environmentId } = await workspaceWith([{ path: "src/pages/HomePage.jsx", content: HOME }]);
      await expect(applySiteEditPatchBundle(execution, environmentId, home([
        { find: HERO, replace: "<p>new hero</p>" },
        { find: "one clear place", replace: "one place" },
      ]))).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { matches: 0, matchesInShownSource: 1 } });
    });
  });

  it("still rejects unsafe and managed paths, and an unknown mode", () => {
    for (const path of ["../secrets.tsx", "/etc/passwd", "src/main.tsx", "src/sites-ui/primitives/Button.tsx"])
      expect(() => patch({ path, find: "a", replace: "b" })).toThrowError(/disallowed path/);
    expect(() => patch({ find: "a", replace: "b", mode: "fuzzy" })).toThrowError(/must be "unique" or "all"/);
  });
});

describe("Targeted Edit context selection", () => {
  const files = [
    ...EMBER_GRAIN_FILES.map((file) => ({ path: file.path, content: file.content })),
    { path: BASELINE_STYLESHEET, content: styleSheetForSeed("ember") },
  ];
  const paths = (instruction: string) =>
    selectEditContextFiles(instruction, files).selected.map((file) => file.path);

  it("routes whole-site functionality requests to full editable source, but keeps small edits targeted", () => {
    expect(isBroadFunctionalEdit("make the pages functional as well")).toBe(true);
    expect(isBroadFunctionalEdit("make all buttons work")).toBe(true);
    expect(isBroadFunctionalEdit("change the hero headline")).toBe(false);
    expect(broadFunctionalEditChangesStyle("make every page functional while preserving the styling")).toBe(false);
    expect(broadFunctionalEditChangesStyle("make every page functional and redesign the theme")).toBe(true);
    const selected = selectEditContextFiles("make the pages functional as well", files, { includeAllEditable: true }).selected.map((file) => file.path);
    expect(selected).toContain("src/App.tsx");
    expect(selected).toContain("src/components/Menu.tsx");
    expect(selected).not.toContain(BASELINE_STYLESHEET);
  });

  it("A. brand rename reaches every file holding the name, without the baseline stylesheet", () => {
    const selected = paths("Change Ember & Grain to Abdullah's Cafe");
    expect(selected).toContain("src/components/SiteHeader.tsx");
    expect(selected).toContain("src/components/Hero.tsx");
    expect(selected).toContain("src/components/SiteFooter.tsx");
    expect(selected).not.toContain(BASELINE_STYLESHEET);
  });

  it("B. a theme request includes the stylesheets", () => {
    const selected = paths("Make the website dark");
    expect(selected).toContain(BASELINE_STYLESHEET);
    expect(selected).toContain("src/site.css");
    expect(selected).toContain("src/App.tsx");
  });

  it("C. a hero copy change reaches the hero, not the whole project", () => {
    const selected = paths("Change the hero button text to Book a Table");
    expect(selected).toContain("src/components/Hero.tsx");
    expect(selected).not.toContain(BASELINE_STYLESHEET);
    expect(selected.length).toBeLessThan(files.length);
  });

  it("D. a service heading style change reaches the services component and its css", () => {
    const selected = paths("Make all service card headings uppercase");
    expect(selected).toContain("src/components/Services.tsx");
    expect(selected).toContain("src/site.css");
  });

  it("falls back to the editable application set when nothing matches, still excluding the baseline", () => {
    const selection = selectEditContextFiles("zzzz qqqq", files);
    expect(selection.reason).toBe("fallback");
    expect(selection.selected.map((file) => file.path)).not.toContain(BASELINE_STYLESHEET);
    expect(selection.selected.length).toBe(files.length - 1);
  });

  it("sends materially less than the whole project for a one-sentence edit", () => {
    const wholeProject = files.reduce((total, file) => total + file.content.length, 0);
    const selected = selectEditContextFiles("Change the hero button text to Book a Table", files);
    const sent = selected.selected.reduce((total, file) => total + file.content.length, 0);
    // The baseline stylesheet alone is most of the project's bytes.
    expect(sent).toBeLessThan(wholeProject * 0.3);
  });

  it("never selects scaffold-owned or build files", () => {
    const withNoise = [
      ...files,
      { path: "src/main.tsx", content: "managed entry" },
      { path: "dist/index.html", content: "<html></html>" },
    ];
    // Selection only ever sees the editable set, but a manifest bug must not leak them.
    const selected = selectEditContextFiles("Make the website dark", withNoise).selected.map(
      (file) => file.path,
    );
    expect(selected).not.toContain("dist/index.html");
  });
});

describe("Targeted Edit design tokens", () => {
  it("treats a visual-direction request as style work", () => {
    const files = [
      { path: "src/App.jsx", content: "export default function App(){return <h1>Ember &amp; Olive</h1>}" },
      { path: BASELINE_STYLESHEET, content: ":root{--olive:#263328;--paper:#efe4ce}" },
    ];
    const selection = selectEditContextFiles(
      "Rename the restaurant and change the visual direction to warm burgundy and cream.",
      files,
      { entryPath: "src/App.jsx" },
    );
    expect(selection.styleIntent).toBe(true);
    expect(selection.selected.map((file) => file.path)).toContain(BASELINE_STYLESHEET);
  });

  it("excerpts :root blocks verbatim so a patch against them still matches exactly", () => {
    const css = ".a{color:red}\n:root {\n  --blue: #2563eb;\n}\n.b{}\n:root{--x:1px}\n.c{}";
    const excerpt = designTokenExcerpt(css)!;
    expect(excerpt).toBe(":root {\n  --blue: #2563eb;\n}\n\n:root{--x:1px}");
    for (const block of excerpt.split("\n\n")) expect(css).toContain(block);
    expect(designTokenExcerpt(".a{color:red}")).toBeUndefined();
  });
});

describe("Targeted Edit prompt caching", () => {
  const request = {
    model: "gpt-5.6-luna",
    messages: [{ role: "user" as const, content: "STABLE-PREFIX\n\nVARIABLE-TAIL" }],
  };

  it("marks the reusable prefix with an explicit breakpoint at the exact boundary", () => {
    const mapped = mapAgentRequest({
      ...request,
      promptCacheKey: "sites:abc:EDIT_SITE",
      cachePrefixChars: "STABLE-PREFIX\n\n".length,
    });
    expect(mapped.prompt_cache_key).toBe(openAIPromptCacheKey("sites:abc:EDIT_SITE"));
    const content = mapped.input[0]!.content as readonly Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: "input_text",
      text: "STABLE-PREFIX\n\n",
      prompt_cache_breakpoint: { mode: "explicit" },
    });
    expect(content[1]).toMatchObject({ type: "input_text", text: "VARIABLE-TAIL" });
  });

  it("sends a plain message when there is no boundary to split on", () => {
    for (const cachePrefixChars of [undefined, 0, 9_999])
      expect(
        mapAgentRequest({ ...request, ...(cachePrefixChars === undefined ? {} : { cachePrefixChars }) })
          .input[0]!.content,
      ).toBe(request.messages[0]!.content);
    expect(mapAgentRequest(request).prompt_cache_key).toBeUndefined();
  });

  it("keeps the prefix byte-identical across different edits to one site", async () => {
    const root = await mkdtemp(join(tmpdir(), "edit-cache-"));
    const prompts: { system: string; content: string; boundary: number }[] = [];
    const provider = new MockAgentProvider({
      customResponse: async (request) => {
        const content = request.messages.map((message) => message.content).join("\n");
        const isEdit = content.includes("SiteEditPatchBundle");
        if (isEdit)
          prompts.push({
            system: request.systemInstructions ?? "",
            content,
            boundary: request.cachePrefixChars ?? 0,
          });
        return {
          id: "r",
          model: request.model,
          message: {
            role: "assistant",
            content: isEdit
              ? JSON.stringify({
                  patches: [
                    { path: "src/site.css", find: ".menu-note", replace: ".menu-note", mode: "unique" },
                  ],
                })
              : JSON.stringify({ files: EMBER_GRAIN_FILES }),
          },
          toolCalls: [],
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 },
          latencyMs: 1,
          finishReason: "stop" as const,
        };
      },
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
      const generated = await product.orchestrator.generateWebsite({
        userId: "u" as UserId,
        prompt: "Create a website for a neighborhood restaurant called Ember & Grain",
        planningMode: "deterministic",
        agentProvider: "mock",
        browserQAEnabled: false,
      });
      for (const instruction of [
        "Change the menu heading to On the board",
        // A style edit pulls the large baseline stylesheet in; it must land in the
        // variable tail so the reusable prefix stays byte-identical.
        "Make the website dark",
      ])
        await product.orchestrator.editWebsite({
          userId: "u" as UserId,
          siteId: generated.siteId,
          instruction,
          agentProvider: "mock-agent",
          browserQAEnabled: false,
        });

      expect(prompts).toHaveLength(2);
      const [first, second] = prompts;
      expect(first!.boundary).toBeGreaterThan(0);
      expect(second!.content.slice(0, second!.boundary)).toBe(
        first!.content.slice(0, first!.boundary),
      );
      expect(second!.system).toBe(first!.system);
      // Small projects put all application source inside the prefix, which is what
      // carries it past the provider's minimum cacheable length.
      expect(first!.content.slice(0, first!.boundary)).toContain("--- src/components/SiteHeader.tsx");
      expect(Math.ceil((first!.system.length + first!.boundary) / 4)).toBeGreaterThan(1_024);
      // The stylesheet only appears for the style edit, and only after the boundary.
      expect(first!.content.slice(first!.boundary)).not.toContain("--- src/styles.css");
      expect(second!.content.slice(second!.boundary)).toContain("--- src/styles.css");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});

describe("Targeted Edit end to end", () => {
  it("uses a complete editable file bundle for a whole-site functionality request", async () => {
    const root = await mkdtemp(join(tmpdir(), "broad-functional-edit-"));
    const entry = EMBER_GRAIN_FILES.find((file) => file.path === "src/App.tsx")!;
    let broadSchema = "";
    const provider = new MockAgentProvider({ customResponse: async (request) => {
      const broad = request.messages.some((message) => message.content.includes("make the pages functional as well"));
      if (broad) broadSchema = request.responseContract?.type === "JSON_SCHEMA" ? request.responseContract.name : "";
      return {
        id: "broad-edit-response", model: request.model,
        message: { role: "assistant", content: JSON.stringify({ files: broad
          ? [
              { path: "src/App.tsx", content: entry.content.replace("<Hero />", "<Hero /><p>Interactive demo ready</p>") },
              { path: "src/site.css", content: "body { background: red; }" },
              { path: "src/styles.css", content: "body { background: red; }" },
            ]
          : EMBER_GRAIN_FILES }) },
        toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 },
        latencyMs: 1, finishReason: "stop" as const,
      };
    } });
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry, orchestrationAgent: provider, keepWorkspace: false });
    try {
      const generated = await product.orchestrator.generateWebsite({ userId: "u" as UserId, prompt: "Create a website for a neighborhood restaurant called Ember & Grain", planningMode: "deterministic", agentProvider: "mock", browserQAEnabled: false });
      const edited = await product.orchestrator.editWebsite({ userId: "u" as UserId, siteId: generated.siteId, instruction: "make the pages functional as well", agentProvider: "mock-agent", browserQAEnabled: false });
      expect(broadSchema).toBe("SiteCoderFileBundle");
      expect(edited.build.success).toBe(true);
      const version = await product.versions.getById(edited.newVersionId);
      const snapshot = JSON.parse(Buffer.from((await product.artifacts.get(version!.sourceArtifactRef))!).toString("utf8")) as { files: Record<string, string> };
      expect(snapshot.files["src/App.tsx"]).toContain("Interactive demo ready");
      expect(snapshot.files["src/components/SiteHeader.tsx"]).toBe(HEADER);
      expect(snapshot.files["src/site.css"]).toBe(EMBER_GRAIN_FILES.find((file) => file.path === "src/site.css")!.content);
      expect(snapshot.files["src/styles.css"]).not.toBe("body { background: red; }");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it("applies a multi-file rename through the pipeline and still builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "targeted-edit-"));
    const provider = new MockAgentProvider({
      customResponse: async (request) => {
        const isEdit = request.messages.some((message) =>
          message.content.includes("SiteEditPatchBundle"),
        );
        return {
          id: "r",
          model: request.model,
          message: {
            role: "assistant",
            content: isEdit
              ? JSON.stringify({
                  patches: [
                    {
                      path: "src/components/SiteHeader.tsx",
                      find: "Ember &amp; Grain",
                      replace: "Abdullah's Cafe",
                      mode: "all",
                    },
                    {
                      path: "src/components/Hero.tsx",
                      find: '<h1 className="display">Ember &amp; Grain</h1>',
                      replace: '<h1 className="display">Abdullah\'s Cafe</h1>',
                      mode: "unique",
                    },
                  ],
                })
              : JSON.stringify({ files: EMBER_GRAIN_FILES }),
          },
          toolCalls: [],
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 },
          latencyMs: 1,
          finishReason: "stop" as const,
        };
      },
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
      const generated = await product.orchestrator.generateWebsite({
        userId: "u" as UserId,
        prompt: "Create a website for a neighborhood restaurant called Ember & Grain",
        planningMode: "deterministic",
        agentProvider: "mock",
        browserQAEnabled: false,
      });
      const edited = await product.orchestrator.editWebsite({
        userId: "u" as UserId,
        siteId: generated.siteId,
        instruction: "Change Ember & Grain to Abdullah's Cafe",
        agentProvider: "mock-agent",
        browserQAEnabled: true,
      });
      expect(edited.browserQA?.status).not.toBe("FAIL");

      expect(edited.build.success).toBe(true);
      // One logical model call for the edit itself.
      expect(edited.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(1);
      expect(edited.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);

      expect(edited.changedFiles.filesModified).toContain("src/components/SiteHeader.tsx");
      expect(edited.changedFiles.filesModified).toContain("src/components/Hero.tsx");
      expect(edited.changedFiles.filesModified).not.toContain("src/components/Menu.tsx");

      const version = await product.versions.getById(edited.newVersionId);
      const snapshot = JSON.parse(
        Buffer.from((await product.artifacts.get(version!.sourceArtifactRef))!).toString("utf8"),
      ) as { files: Record<string, string> };
      expect(snapshot.files["src/components/SiteHeader.tsx"]).toContain("Abdullah's Cafe");
      expect(snapshot.files["src/components/Hero.tsx"]).toContain("Abdullah's Cafe");
      // Untouched files stay byte-identical.
      expect(snapshot.files["src/components/Menu.tsx"]).toBe(
        EMBER_GRAIN_FILES.find((file) => file.path === "src/components/Menu.tsx")!.content,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it("sends only the verbatim design tokens of an oversized stylesheet on a colour edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "targeted-edit-tokens-"));
    const siteCss = EMBER_GRAIN_FILES.find((file) => file.path === "src/site.css")!.content;
    const oversized = `:root {\n  --accent: #2563eb;\n}\n${siteCss}\n${"/* oversized-padding */\n".repeat(800)}`;
    const files = EMBER_GRAIN_FILES.map((file) => file.path === "src/site.css" ? { ...file, content: oversized } : file);
    let editContext = "";
    const provider = new MockAgentProvider({
      customResponse: async (request) => {
        const isEdit = request.messages.some((message) => message.content.includes("SiteEditPatchBundle"));
        if (isEdit) editContext = request.messages.map((message) => message.content).join("\n");
        return {
          id: "r", model: request.model,
          message: { role: "assistant", content: isEdit
            ? JSON.stringify({ patches: [{ path: "src/site.css", find: "--accent: #2563eb;", replace: "--accent: #14532d;", mode: "unique" }] })
            : JSON.stringify({ files }) },
          toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 },
          latencyMs: 1, finishReason: "stop" as const,
        };
      },
    });
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const product = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry, orchestrationAgent: provider, keepWorkspace: false });
    try {
      const generated = await product.orchestrator.generateWebsite({ userId: "u" as UserId, prompt: "Create a website for a neighborhood restaurant called Ember & Grain", planningMode: "deterministic", agentProvider: "mock", browserQAEnabled: false });
      const edited = await product.orchestrator.editWebsite({ userId: "u" as UserId, siteId: generated.siteId, instruction: "Change the primary accent from blue to a deep green", agentProvider: "mock-agent", browserQAEnabled: false });
      expect(editContext).toContain("--- src/site.css\nEXACT PATCHABLE EXCERPT");
      expect(editContext).toContain(":root {\n  --accent: #2563eb;\n}");
      expect(editContext).not.toContain("oversized-padding");
      expect(edited.build.success).toBe(true);
      const version = await product.versions.getById(edited.newVersionId);
      const snapshot = JSON.parse(Buffer.from((await product.artifacts.get(version!.sourceArtifactRef))!).toString("utf8")) as { files: Record<string, string> };
      expect(snapshot.files["src/site.css"]).toContain("--accent: #14532d;");
      expect(snapshot.files["src/site.css"]).toContain("oversized-padding");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it("applies a stylesheet-only edit and still builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "targeted-edit-css-"));
    const provider = new MockAgentProvider({
      customResponse: async (request) => {
        const isEdit = request.messages.some((message) =>
          message.content.includes("SiteEditPatchBundle"),
        );
        return {
          id: "r",
          model: request.model,
          message: {
            role: "assistant",
            content: isEdit
              ? JSON.stringify({
                  patches: [
                    {
                      path: "src/site.css",
                      find: ".service-heading {\n  font-size: 1.125rem;\n}",
                      replace: ".service-heading {\n  font-size: 1.125rem;\n  text-transform: uppercase;\n}",
                      mode: "unique",
                    },
                  ],
                })
              : JSON.stringify({ files: EMBER_GRAIN_FILES }),
          },
          toolCalls: [],
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 },
          latencyMs: 1,
          finishReason: "stop" as const,
        };
      },
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
      const generated = await product.orchestrator.generateWebsite({
        userId: "u" as UserId,
        prompt: "Create a website for a neighborhood restaurant called Ember & Grain",
        planningMode: "deterministic",
        agentProvider: "mock",
        browserQAEnabled: false,
      });
      const edited = await product.orchestrator.editWebsite({
        userId: "u" as UserId,
        siteId: generated.siteId,
        instruction: "Make all service card headings uppercase",
        agentProvider: "mock-agent",
        browserQAEnabled: false,
      });

      expect(edited.build.success).toBe(true);
      expect(edited.changedFiles.filesModified).toEqual(["src/site.css"]);
      const version = await product.versions.getById(edited.newVersionId);
      const snapshot = JSON.parse(
        Buffer.from((await product.artifacts.get(version!.sourceArtifactRef))!).toString("utf8"),
      ) as { files: Record<string, string> };
      expect(snapshot.files["src/site.css"]).toContain("text-transform: uppercase");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
