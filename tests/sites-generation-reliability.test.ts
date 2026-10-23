import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import {
  DEFAULT_TSCONFIG,
  DEFAULT_MAIN_TSX,
  DESIGN_DIRECTIONS,
  pickDesignDirection,
  styleSheetForSeed,
  scaffoldDeterministicReactVite,
} from "../src/sites/scaffold/react-vite-scaffold.js";
import { LocalExecutionProvider } from "../src/execution/local/local-execution.provider.js";
import { BROWSER_QA_CHECK_DEFINITIONS } from "../src/browser-qa/browser-qa-check-registry.js";
import { isEditableContextPath } from "../src/cli/runtime/local-cli-agent-runtime.js";
import {
  validateSiteEditPatchBundle,
  applySiteEditPatchBundle,
} from "../src/cli/runtime/site-coder-file-bundle.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { buildCapabilityAwareGenerationContext } from "../src/cli/runtime/capability-aware-generation-context.js";
import { SITES_UI_REGISTRY } from "../src/sites/generation/sites-ui-registry.js";
import { SITE_V1_TECHNICAL_PROFILE } from "../src/cli/runtime/site-technical-profile.js";
import type { UserId } from "../src/shared/types.js";

/**
 * A simple SaaS landing page with hero/features/pricing/faq/cta sections,
 * written the way a real model routinely writes first-pass React: a prop
 * planned for later use, and an import kept for a follow-up effect. Neither
 * changes behavior; both used to fail the build under `noUnusedLocals` /
 * `noUnusedParameters`, forcing Build Repair (or REPAIR_LIMIT_REACHED) on an
 * otherwise-correct simple generation.
 */
const LANDING_PAGE_FILES = [
  {
    path: "src/App.tsx",
    content: `import { Hero } from "./components/Hero";
import { Features } from "./components/Features";
import { Pricing } from "./components/Pricing";
import { Faq } from "./components/Faq";
import { Cta } from "./components/Cta";

export function App() {
  return (
    <div aria-label="AI Sites Generated Hero">
      <Hero />
      <Features />
      <Pricing />
      <Faq />
      <Cta />
    </div>
  );
}
`,
  },
  {
    path: "src/components/Hero.tsx",
    content: `export function Hero() {
  return (
    <section aria-label="Hero">
      <h1>Ship faster with Acme</h1>
      <p>The all-in-one platform for modern teams.</p>
    </section>
  );
}
`,
  },
  {
    path: "src/components/Features.tsx",
    content: `const FEATURES = ["Automation", "Insights", "Integrations"];

export function Features() {
  return (
    <section aria-label="Features">
      {FEATURES.map((feature) => (
        <article key={feature}>{feature}</article>
      ))}
    </section>
  );
}
`,
  },
  {
    path: "src/components/Pricing.tsx",
    content: `function PricingTier({ name, price, index }: { name: string; price: string; index: number }) {
  return (
    <div>
      <h3>{name}</h3>
      <p>{price}</p>
    </div>
  );
}

export function Pricing() {
  return (
    <section aria-label="Pricing">
      <PricingTier name="Starter" price="$0" index={0} />
      <PricingTier name="Pro" price="$29" index={1} />
    </section>
  );
}
`,
  },
  {
    path: "src/components/Faq.tsx",
    content: `function FaqItem({ question, answer }: { question: string; answer: string }) {
  return (
    <div>
      <h4>{question}</h4>
      <p>{answer}</p>
    </div>
  );
}

export function Faq() {
  return (
    <section aria-label="FAQ">
      <FaqItem question="Is there a free trial?" answer="Yes, 14 days." />
    </section>
  );
}
`,
  },
  {
    path: "src/components/Cta.tsx",
    content: `import { useState, useEffect } from "react";

export function Cta() {
  const [email, setEmail] = useState("");
  const [started, setStarted] = useState(false);
  return (
    <section aria-label="Call to action">
      <label htmlFor="cta-email">Email</label>
      <input
        id="cta-email"
        name="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="button" onClick={() => setStarted(true)}>Get started</button>
      {started && <p role="status">Demo request noted locally. Nothing was sent.</p>}
    </section>
  );
}
`,
  },
];

describe("Sites generation reliability recovery", () => {
  it("does not enforce noUnusedLocals/noUnusedParameters in the generated project's tsconfig", () => {
    const compilerOptions = (JSON.parse(DEFAULT_TSCONFIG) as { compilerOptions: Record<string, unknown> }).compilerOptions;
    expect(compilerOptions.noUnusedLocals).toBeUndefined();
    expect(compilerOptions.noUnusedParameters).toBeUndefined();
    expect(compilerOptions.strict).toBe(true);
  });

  it("owns its files even when the starter template ships its own copies", async () => {
    // The product seeds from a starter template first. Sites-owned files must win,
    // or the scaffold silently has no effect in production.
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    for (const path of ["src/main.tsx", "src/styles.css", "tsconfig.json", "index.html"])
      await execution.writeFile(environment.id, path, "/* stale template copy */");
    await execution.writeFile(
      environment.id,
      "package.json",
      '{"name":"template-pinned-to-lockfile"}',
    );
    await scaffoldDeterministicReactVite(execution, environment.id, { designSeed: "seed" });

    expect(await execution.readFile(environment.id, "src/main.tsx")).toBe(DEFAULT_MAIN_TSX);
    expect(await execution.readFile(environment.id, "tsconfig.json")).toBe(DEFAULT_TSCONFIG);
    expect(await execution.readFile(environment.id, "src/styles.css")).toContain("--accent");
    // package.json stays paired with the template's lockfile for `npm ci`.
    expect(await execution.readFile(environment.id, "package.json")).toContain(
      "template-pinned-to-lockfile",
    );
  });

  it("ships a working light and dark theme for every art direction", () => {
    for (const direction of DESIGN_DIRECTIONS) {
      const sheet = styleSheetForSeed(direction.id);
      // Initial paint follows the site's light design, not the viewer's OS.
      expect(sheet).not.toContain("@media (prefers-color-scheme: dark)");
      expect(sheet).toContain(':root[data-theme="dark"]');
      // A dark surface needs its own accent, or buttons go unreadable. Surfaces
      // themselves come from the shared dark base unless a direction overrides them.
      expect(direction.dark).toContain("--accent:");
      expect(sheet).toContain("--ink: #f2f1ee");
    }
  });

  it("gives every site a theme toggle and splash primitives", () => {
    expect(DEFAULT_MAIN_TSX).toContain("<ThemeToggle />");
    expect(DEFAULT_MAIN_TSX).toContain('aria-label={theme === "dark"');
    const sheet = styleSheetForSeed("any");
    for (const utility of [".splash-stage", ".splash", ".splash--ring", ".theme-toggle"])
      expect(sheet).toContain(utility);
    // Splash colour is a token so a near-black accent cannot smear the light theme.
    expect(sheet).toContain("var(--splash-color)");
  });

  it("gives different requests different art directions, and the same request the same one", () => {
    const ids = new Set(
      [
        "a dental clinic site",
        "a SaaS landing page",
        "a portfolio",
        "a restaurant",
        "a law firm",
      ].map((seed) => pickDesignDirection(seed).id),
    );
    expect(ids.size).toBeGreaterThan(1);
    expect(pickDesignDirection("a portfolio").id).toBe(pickDesignDirection("a portfolio").id);
    // Every direction must define the accent the utilities are built on.
    for (const direction of DESIGN_DIRECTIONS) expect(direction.tokens).toContain("--accent:");
  });

  it("applies several edit patches to the same file", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(
      environment.id,
      "src/App.tsx",
      `export default function App() {
  return (
    <div>
      <h1>Old headline</h1>
      <a className="button" href="#cta">Old CTA</a>
    </div>
  );
}
`,
    );
    // "Change the headline and the button text" is one ordinary edit.
    const bundle = validateSiteEditPatchBundle({
      patches: [
        { path: "src/App.tsx", find: "Old headline", replace: "New headline" },
        { path: "src/App.tsx", find: "Old CTA", replace: "New CTA" },
      ],
    });
    const changed = await applySiteEditPatchBundle(execution, environment.id, bundle);
    const source = await execution.readFile(environment.id, "src/App.tsx");
    expect(changed).toEqual(["src/App.tsx", "src/App.tsx"]);
    expect(source).toContain("New headline");
    expect(source).toContain("New CTA");
    expect(source).not.toContain("Old");
  });

  it("still rejects edit patches that target managed files", () => {
    expect(() =>
      validateSiteEditPatchBundle({
        patches: [{ path: "src/main.tsx", find: "a", replace: "b" }],
      }),
    ).toThrowError(/disallowed path/);
    expect(() =>
      validateSiteEditPatchBundle({
        patches: [{ path: "src/sites-ui/primitives/Button.tsx", find: "a", replace: "b" }],
      }),
    ).toThrowError(/disallowed path/);
  });

  it("sends editable application source and root HTML branding to a targeted edit", () => {
    const editable = (path: string) => isEditableContextPath(path, SITE_V1_TECHNICAL_PROFILE);
    // Worth paying for: the edit can actually patch these.
    expect(editable("src/App.tsx")).toBe(true);
    expect(editable("src/components/Hero.tsx")).toBe(true);
    expect(editable("src/styles.css")).toBe(true);
    // Managed: the edit is forbidden to touch them, so they are cost without capability.
    expect(editable("src/main.tsx")).toBe(false);
    expect(editable("src/vite-env.d.ts")).toBe(false);
    expect(editable("src/sites-ui/primitives/Button.tsx")).toBe(false);
    expect(editable("package.json")).toBe(false);
    expect(editable("tsconfig.json")).toBe(false);
    expect(editable("index.html")).toBe(true);
    expect(editable("vite.config.ts")).toBe(false);
  });

  it("keeps only real breakage and safety checks blocking in Browser QA", () => {
    const blocking = BROWSER_QA_CHECK_DEFINITIONS.filter(
      ({ defaultSeverity }) => defaultSeverity === "ERROR",
    ).map(({ checkId }) => checkId);
    // Missing destinations are real navigation breakage, not polish findings.
    expect(blocking.sort()).toEqual([
      "internal-links",
      "network.failed-request",
      "page-readiness",
      "route.load",
      "runtime.page-error",
    ]);
  });

  it("builds a site whose entry component uses a default export", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-default-export-"));
    const execution = new LocalExecutionProvider({
      rootDirectory: join(root, "execution"),
      keepWorkspace: false,
      previewHost: "127.0.0.1",
      previewStartTimeoutMs: 15_000,
      commandTimeoutMs: 120_000,
      maxLogBytes: 100_000,
    });
    try {
      const environment = await execution.createEnvironment({});
      await scaffoldDeterministicReactVite(execution, environment.id, {});
      await execution.writeFile(
        environment.id,
        "package-lock.json",
        await readFile(join("tests", "fixtures", "react-vite-site", "package-lock.json"), "utf8"),
      );
      // src/main.tsx is managed, so a default export must not break the build.
      await execution.writeFile(
        environment.id,
        "src/App.tsx",
        `export default function App() {
  return <div><h1>Acme</h1></div>;
}
`,
      );
      const install = await execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
        timeoutMs: 120_000,
      });
      expect(
        install,
        `fixture=${root}\ninstall stdout:\n${install.stdout}\ninstall stderr:\n${install.stderr}`,
      ).toMatchObject({ exitCode: 0, timedOut: false });
      const build = await execution.executeCommand(environment.id, {
        executable: "npm",
        args: ["run", "build"],
        timeoutMs: 60_000,
      });
      expect(`${build.stdout}${build.stderr}`).not.toContain("TS2614");
      expect(build.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 240_000);

  it("advertises every Sites UI item by a specifier that actually resolves in the generated project", async () => {
    const context = buildCapabilityAwareGenerationContext({
      profile: SITE_V1_TECHNICAL_PROFILE,
      capabilities: {
        profileId: SITE_V1_TECHNICAL_PROFILE.id,
        profileVersion: SITE_V1_TECHNICAL_PROFILE.version,
        capabilityRegistryVersion: "site-capabilities-v1",
        capabilities: [
          { id: "core-web", version: 1 },
          { id: "ui", version: 1 },
        ],
      },
      uiRegistryItems: SITES_UI_REGISTRY.listItems(),
    });
    // Every registry item must be reachable from the advertised context alone.
    for (const item of SITES_UI_REGISTRY.listItems()) {
      const separator = item.importPath.lastIndexOf("/");
      expect(context).toContain(item.importPath.slice(0, separator));
      expect(context).toContain(item.importPath.slice(separator + 1));
    }
  });

  it("builds a site that imports a Sites UI component by its advertised specifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-ui-import-"));
    const button = SITES_UI_REGISTRY.getItem("Button");
    const provider = new MockAgentProvider({
      customResponse: async (request) => ({
        id: "ui-import-response",
        model: request.model,
        message: {
          role: "assistant",
          content: JSON.stringify({
            files: [
              {
                path: "src/App.tsx",
                content: `import { Button } from "${button.importPath}";
import { useState } from "react";

export function App() {
  const [started, setStarted] = useState(false);
  return (
    <div aria-label="AI Sites Generated Hero">
      <h1>Acme</h1>
      <Button onClick={() => setStarted(true)}>Get started</Button>
      {started && <p role="status">Demo started locally.</p>}
    </div>
  );
}
`,
              },
            ],
          }),
        },
        toolCalls: [],
        usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 400, totalTokens: 700 },
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
        userId: "ui-import-user" as UserId,
        prompt: "Create a simple landing page with a call to action button.",
        planningMode: "deterministic",
        agentProvider: "mock",
        browserQAEnabled: false,
      });
      expect(result.build.success).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("builds a realistic multi-section landing page bundle with harmless unused locals with zero Build Repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-reliability-"));
    const provider = new MockAgentProvider({
      customResponse: async (request) => ({
        id: "landing-page-response",
        model: request.model,
        message: { role: "assistant", content: JSON.stringify({ files: LANDING_PAGE_FILES }) },
        toolCalls: [],
        usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 700, totalTokens: 1200 },
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
        userId: "reliability-user" as UserId,
        prompt: "Create a modern SaaS landing page with hero, features, pricing, FAQ and CTA.",
        planningMode: "deterministic",
        agentProvider: "mock",
        browserQAEnabled: false,
      });
      expect(result.build.success).toBe(true);
      expect(result.usage.modelCalls).toBe(1);
      expect(result.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
