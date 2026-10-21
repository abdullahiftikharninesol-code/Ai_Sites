import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { containsRenameLiteral, parseEditRequirements, readEditRequirementFiles, validateEditRequirements, suppliedEditRequirementContext, mandatoryEditRequirements, validateEditPlanCoverage, editPlanCoverageDiagnostics, editRequirementDiagnostics } from "../src/cli/runtime/edit-requirements.js";
import { selectEditContextFiles, designTokenExcerpt, patchableStyleExcerpt, selectEditRepairContext } from "../src/cli/runtime/edit-context-selection.js";
import { applySiteEditPatchBundle, validateSiteEditPatchBundle, validateSiteCoderFileBundle, validateBuildRepairPatchBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { isEditableContextPath, LocalCliAgentRuntime } from "../src/cli/runtime/local-cli-agent-runtime.js";
import { InProcessAgentGateway } from "../src/agents/gateway/in-process-agent-gateway.js";
import { estimateTokens, estimateTokensConservative } from "../src/agents/budget/token-estimator.js";
import { SITE_V1_TECHNICAL_PROFILE } from "../src/cli/runtime/site-technical-profile.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import { ApplicationError } from "../src/app/errors/application-error.js";
import { listAgentContracts } from "../src/agents/contracts/agent-contract.js";

const renameInstruction = "Rename FlowPilot to NovaPay. Keep the existing layout.";
const combinedInstruction = "Rename FlowPilot to NovaPay. Change the primary accent from blue to a deep green and rewrite the hero. Keep the existing layout.";
const sources = new Map([
  ["index.html", "<title>FlowPilot</title>"],
  ["src/Brand.jsx", "<h1>FlowPilot</h1>"],
  ["src/About.jsx", "<p>FlowPilot story</p>"],
  ["src/global.css", ":root { --blue: #2563eb; }"],
]);
const renamed = () => new Map([...sources].map(([path, content]) => [path, content.replaceAll("FlowPilot", "NovaPay")]));

function captureFailure(operation: () => void): unknown {
  try { operation(); }
  catch (error) { return error; }
  throw new Error("Expected the edit requirement to reject the candidate");
}

describe("Phase 7C mandatory requirement guidance and plan coverage", () => {
  const supplied = [
    { path: "src/Brand.jsx", content: '<h1 className="brand">FlowPilot</h1>' },
    { path: "index.html", content: "<title>FlowPilot</title>" },
    { path: "src/styles/tokens.css", content: ":root { --accent: blue; }" },
  ];
  const requirements = parseEditRequirements(combinedInstruction);
  const context = suppliedEditRequirementContext(requirements, supplied);

  it("supplies compact mandatory rename/style guidance with actual selected style paths", () => {
    const block = mandatoryEditRequirements(requirements, context);
    expect(block).toContain("MANDATORY EDIT REQUIREMENTS: cover ALL");
    expect(block).toContain('RENAME "FlowPilot" -> "NovaPay"');
    expect(block).toContain("supplied editable old-literal occurrences");
    expect(block).toContain("STYLE: include at least one valid edit");
    expect(block).toContain("src/styles/tokens.css");
    expect(block).not.toContain("global.css");
    expect(block).not.toContain(combinedInstruction);
    expect(block).not.toContain("rewrite the hero");
    expect(estimateTokensConservative(block)).toBeLessThan(150);
    console.log("Phase 7C requirement guidance overhead", {
      characters: block.length,
      estimatedTokens: estimateTokens(block),
      conservativeTokens: estimateTokensConservative(block),
    });
  });

  it("omits absent requirements and leaves ordinary text-only request guidance empty", () => {
    expect(mandatoryEditRequirements(parseEditRequirements("Rename FlowPilot to NovaPay"), context)).not.toContain("STYLE:");
    expect(mandatoryEditRequirements(parseEditRequirements("Change the accent color"), context)).not.toContain("RENAME");
    expect(mandatoryEditRequirements(parseEditRequirements("Rewrite the homepage copy"), context)).toBe("");
  });

  it.each(["Change the color", "Change the accent", "Change the style", "Update the styling"])("includes a mandatory style operation for %s", (instruction) => {
    expect(mandatoryEditRequirements(parseEditRequirements(instruction), context)).toContain("STYLE:");
  });

  it("associates exact, unprefixed patchable token source with its real file without the oversized body", () => {
    const tokens = ":root {\n  --accent: blue;\n}";
    const oversized = `${tokens}\n${"/* not required style body */\n".repeat(1500)}`;
    const excerpt = designTokenExcerpt(oversized)!;
    const rendered = patchableStyleExcerpt({ path: "src/styles/tokens.css", content: excerpt });
    expect(rendered).toContain("--- src/styles/tokens.css\nEXACT PATCHABLE EXCERPT");
    expect(rendered).toContain("verbatim source below; patch this real file");
    expect(rendered).toContain("labels/line numbers are not source; no full-file rewrite");
    expect(rendered.endsWith(tokens)).toBe(true);
    expect(rendered).not.toContain("not required style body");
    expect(oversized.includes(excerpt)).toBe(true);
  });

  it("passes actual CSS and rename operations, without relying on model flags", () => {
    const plan = { patches: [
      { path: "index.html", find: "FlowPilot", replace: "NovaPay", mode: "all" },
      { path: "src/styles/tokens.css", find: "blue", replace: "green", mode: "unique" },
    ], styleCompleted: false, requirementsSatisfied: false };
    expect(() => validateEditPlanCoverage(requirements, context, validateSiteEditPatchBundle(plan).patches)).not.toThrow();
  });

  it("rejects style omission even when a rename changes a file containing unrelated className styling", () => {
    expect(() => validateEditPlanCoverage(requirements, context, [
      { path: "src/Brand.jsx", find: "FlowPilot", replace: "NovaPay" },
    ])).toThrow("required style operation");
  });

  it("rejects CSS operations on unsupplied paths and ignores self-reported success", () => {
    const claims = { styleCompleted: true, requirementsSatisfied: true, patches: [
      { path: "src/Brand.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
      { path: "src/unseen.css", find: "blue", replace: "green", mode: "unique" },
    ] };
    expect(() => validateEditPlanCoverage(requirements, context, validateSiteEditPatchBundle(claims).patches)).toThrow("required style operation");
  });

  it("rejects obvious rename omission before application", () => {
    expect(() => validateEditPlanCoverage(requirements, context, [
      { path: "src/styles/tokens.css", find: "blue", replace: "green" },
    ])).toThrow("required rename operation");
  });

  it("allows structural inline-style and theme-token operations on supplied source", () => {
    const style = parseEditRequirements("Change the color");
    const inline = { path: "src/App.jsx", content: '<h1 style={{ color: "blue" }}>Hello</h1>' };
    const selected = suppliedEditRequirementContext(style, [inline]);
    expect(() => validateEditPlanCoverage(style, selected, [
      { path: inline.path, find: 'style={{ color: "blue" }}', replace: 'style={{ color: "green" }}' },
    ])).not.toThrow();
    const theme = suppliedEditRequirementContext(style, [{ path: "src/theme.ts", content: 'const palette = { primary: "blue" };' }]);
    expect(() => validateEditPlanCoverage(style, theme, [
      { path: "src/theme.ts", find: 'primary: "blue"', replace: 'primary: "green"' },
    ])).not.toThrow();
  });

  it("leaves post-application checks authoritative after structural coverage passes", () => {
    const operations = [
      { path: "src/Brand.jsx", find: "FlowPilot", replace: "NovaPay" },
      { path: "src/styles/tokens.css", find: "blue", replace: "blue" },
    ];
    expect(() => validateEditPlanCoverage(requirements, context, operations)).not.toThrow();
    expect(() => validateEditRequirements(requirements, sources, sources)).toThrow("rename is incomplete");
    expect(() => validateEditRequirements(requirements, sources, renamed())).toThrow("style change is incomplete");
  });

  it("does not impose plan requirements on unrelated text-only edits", () => {
    expect(() => validateEditPlanCoverage(parseEditRequirements("Rewrite the hero"), context, [
      { path: "src/Brand.jsx", find: "Hello", replace: "Welcome" },
    ])).not.toThrow();
  });
});

describe("Phase 7G one bounded requirement-repair call without projects or live providers", () => {
  it.each(["missing-style", "missing-rename", "partial-rename", "unchanged-style"] as const)("handles %s with one candidate and never more than two requests", async (scenario) => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    const tokens = ":root {\n  --accent: blue;\n}";
    const files = [
      { path: "index.html", content: "<title>FlowPilot</title>" },
      { path: "src/Brand.jsx", content: '<h1 className="brand">FlowPilot</h1>' },
      { path: "src/About.jsx", content: "<p>FlowPilot story</p>" },
      { path: "src/App.jsx", content: "export default function App() { return <main>FlowPilot</main>; }" },
      { path: "src/styles/tokens.css", content: `${tokens}\n${"/* omitted stylesheet body */\n".repeat(1500)}` },
    ];
    for (const file of files) await execution.writeFile(environment.id, file.path, file.content);
    const prompts: string[] = [];
    const renamePatches = files.filter((file) => file.content.includes("FlowPilot")).map((file) => ({
      path: file.path, find: "FlowPilot", replace: "NovaPay", mode: "all",
    }));
    const stylePatch = { path: "src/styles/tokens.css", find: "--accent: blue;", replace: scenario === "unchanged-style" ? "--accent: blue;" : "--accent: green;", mode: "unique" };
    let attempt = 0;
    const provider = new MockAgentProvider({ customResponse: (request) => {
      const prompt = request.messages.map((message) => message.content).join("\n");
      prompts.push(prompt);
      attempt += 1;
      const first = scenario === "missing-style" ? renamePatches : scenario === "missing-rename" ? [stylePatch] :
        scenario === "partial-rename" ? [renamePatches[0], stylePatch] : [...renamePatches, stylePatch];
      const repair = scenario === "missing-style"
        ? [{ ...stylePatch, replace: "--accent: green;" }]
        : scenario === "missing-rename"
          ? renamePatches
          : scenario === "partial-rename"
            ? renamePatches.slice(1)
            : [stylePatch];
      return {
        id: "offline-plan", model: request.model,
        message: { role: "assistant", content: JSON.stringify({ patches: attempt === 1 ? first : repair }) },
        toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, finishReason: "stop",
      };
    } });
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, execution as never);
    const writes = vi.spyOn(execution, "writeFile");
    const commands = vi.spyOn(execution, "executeCommand");
    let failure: unknown;
    let report: Awaited<ReturnType<LocalCliAgentRuntime["run"]>> | undefined;
    try {
      report = await runtime.run(environment.id, {
        jobId: "offline-plan", siteId: "offline-source", operation: "EDIT_SITE", runtime: "LOCAL_CLI",
        agentProvider: provider.id, userRequest: combinedInstruction,
      });
    } catch (cause) { failure = cause; }
    if (scenario === "unchanged-style") {
      expect(failure).toMatchObject({
        code: "EDIT_REQUIREMENT_INCOMPLETE",
        retryable: false,
        metadata: { requirement: "style", attempts: 2, missingRequirements: ["style"], lastFailureStage: "COMPLETION" },
      });
      expect(commands).not.toHaveBeenCalled();
    } else {
      expect(failure).toBeUndefined();
      expect(report?.success).toBe(true);
      expect(commands).toHaveBeenCalledOnce();
    }
    expect(writes).toHaveBeenCalled();
    expect(provider.callCount).toBe(2);
    expect(prompts[0]).toContain('RENAME "FlowPilot" -> "NovaPay"');
    expect(prompts[0]).toContain("STYLE: include at least one valid edit");
    expect(prompts[0]).toContain("Targets: src/styles/tokens.css");
    expect(prompts[0]).toContain(`--- src/styles/tokens.css\nEXACT PATCHABLE EXCERPT`);
    expect(prompts[0]).toContain(tokens);
    expect(prompts[0]).not.toContain("omitted stylesheet body");
    expect(prompts[0]!.split(combinedInstruction)).toHaveLength(2);
    expect(prompts[1]).toContain("attempt 2 of 2");
    expect(prompts[1]).toContain("No further repair call is allowed");
    if (scenario.endsWith("style")) {
      expect(prompts[1]).toContain("MISSING MANDATORY REQUIREMENTS:\nSTYLE");
      expect(prompts[1]).toContain("--- src/styles/tokens.css\nEXACT PATCHABLE EXCERPT");
      expect(prompts[1]).not.toContain("--- index.html");
      expect(prompts[1]).not.toContain("omitted stylesheet body");
    } else {
      expect(prompts[1]).toContain("MISSING MANDATORY REQUIREMENTS:\nRENAME");
      expect(prompts[1]).not.toContain("src/styles/tokens.css");
      if (scenario === "partial-rename") expect(prompts[1]).not.toContain("--- index.html");
    }
    expect(provider.callCount).toBeLessThanOrEqual(2);
    await execution.destroyEnvironment(environment.id);
  });
});

describe("Phase 7G focused repair selection, budgets, and non-retry failures", () => {
  it("uses the existing targeted-edit contract without registering a repair agent", () => {
    const ids = listAgentContracts().map(({ agentId }) => agentId);
    expect(ids.filter((id) => id === "sites.targeted-edit")).toHaveLength(1);
    expect(ids.some((id) => /requirement-repair|retry/i.test(id))).toBe(false);
  });

  it("keeps a complete text-only edit at one targeted-edit call", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/App.jsx", "export default function App() { return <h1>Hello</h1>; }");
    const provider = new MockAgentProvider({ customResponse: (request) => ({
      id: "complete-first", model: request.model,
      message: { role: "assistant", content: JSON.stringify({ patches: [
        { path: "src/App.jsx", find: "<h1>Hello</h1>", replace: "<h1>Welcome</h1>", mode: "unique" },
      ] }) },
      toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, finishReason: "stop",
    }) });
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, execution as never);
    const report = await runtime.run(environment.id, {
      jobId: "complete-first", siteId: "plain-generated-site", operation: "EDIT_SITE",
      runtime: "LOCAL_CLI", agentProvider: provider.id, userRequest: "Rewrite the heading to Welcome",
    });
    expect(report.success).toBe(true);
    expect(provider.callCount).toBe(1);
    expect((report.usage as { readonly requirementRepair?: unknown }).requirementRepair).toBeUndefined();
    expect(await execution.readFile(environment.id, "src/App.jsx")).toContain("Welcome");
    await execution.destroyEnvironment(environment.id);
  });

  it("selects only current style tokens for a missing-style repair and is meaningfully smaller", () => {
    const css = `:root {\n  --accent: #2563eb;\n}\n${"/* unrelated style body */\n".repeat(2_000)}`;
    const candidate = new Map([
      ["index.html", "<title>NovaPay</title>"],
      ["src/App.jsx", `<main>${"large unrelated application copy ".repeat(1_000)}</main>`],
      ["src/styles/global.css", css],
    ]);
    const selection = selectEditRepairContext(
      parseEditRequirements(combinedInstruction),
      ["style"],
      candidate,
      { renamePaths: ["index.html"], stylePaths: ["src/styles/global.css"] },
    );
    expect(selection.files.map(({ path }) => path)).toEqual(["src/styles/global.css"]);
    expect(selection.text).toContain("--accent: #2563eb");
    expect(selection.text).not.toContain("unrelated style body");
    expect(selection.text).not.toContain("large unrelated application copy");
    const fullContext = [...candidate.values()].join("\n");
    const repairTokens = estimateTokensConservative(selection.text);
    const fullTokens = estimateTokensConservative(fullContext);
    expect(repairTokens).toBeLessThan(fullTokens / 4);
    console.log("Phase 7G style repair context", {
      fullTokens,
      repairTokens,
      relativePercent: Number(((repairTokens / fullTokens) * 100).toFixed(2)),
    });
  });

  it("selects only remaining case-insensitive rename files from the current candidate", () => {
    const candidate = new Map([
      ["index.html", "<title>NovaPay</title>"],
      ["src/Brand.jsx", "<h1>NovaPay</h1>"],
      ["src/components/ProductPreview.jsx", "<span>flowpilot / launch-plan</span>"],
      ["src/styles/global.css", ":root { --accent: #14532d; }"],
    ]);
    const selection = selectEditRepairContext(
      parseEditRequirements(renameInstruction),
      ["rename"],
      candidate,
      { renamePaths: [...candidate.keys()], stylePaths: ["src/styles/global.css"] },
    );
    expect(selection.files).toEqual([
      { path: "src/components/ProductPreview.jsx", content: "<span>flowpilot / launch-plan</span>" },
    ]);
    expect(selection.text).not.toContain("--- index.html");
    expect(selection.text).not.toContain("src/styles/global.css");
    expect(selection.requirementContext.renamePaths).toEqual(["src/components/ProductPreview.jsx"]);
  });

  it("reports all missing requirements together for a narrow combined repair", () => {
    const requirements = parseEditRequirements(combinedInstruction);
    const candidate = new Map(sources);
    const plan = editPlanCoverageDiagnostics(requirements, suppliedEditRequirementContext(requirements, [...sources].map(([path, content]) => ({ path, content }))), []);
    const completion = editRequirementDiagnostics(requirements, sources, candidate);
    expect(plan.map(({ requirement }) => requirement)).toEqual(["rename", "style"]);
    expect(completion.map(({ requirement }) => requirement)).toEqual(["rename", "style"]);
  });

  it("rechecks quota immediately before repair and prevents the second provider call", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/App.jsx", "FlowPilot");
    await execution.writeFile(environment.id, "src/styles.css", ":root { --accent: blue; }");
    const provider = new MockAgentProvider({ customResponse: (request) => ({
      id: "quota-first", model: request.model,
      message: { role: "assistant", content: JSON.stringify({ patches: [
        { path: "src/App.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
      ] }) },
      toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, finishReason: "stop",
    }) });
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, execution as never);
    const repairPreflight = vi.fn(async () => { throw new ApplicationError("CREDIT_LIMIT_REACHED", "quota exhausted"); });
    await expect(runtime.run(environment.id, {
      jobId: "quota-repair", siteId: "plain-site", operation: "EDIT_SITE", runtime: "LOCAL_CLI",
      agentProvider: provider.id, userRequest: combinedInstruction,
    }, undefined, undefined, repairPreflight)).rejects.toMatchObject({ code: "CREDIT_LIMIT_REACHED" });
    expect(repairPreflight).toHaveBeenCalledOnce();
    expect(provider.callCount).toBe(1);
    await execution.destroyEnvironment(environment.id);
  });

  it("does not retry provider or infrastructure failures", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "src/App.jsx", "FlowPilot");
    const provider = new MockAgentProvider({ customResponse: () => {
      throw new ApplicationError("PROVIDER_NOT_AVAILABLE", "offline provider failure");
    } });
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, execution as never);
    await expect(runtime.run(environment.id, {
      jobId: "provider-failure", siteId: "plain-site", operation: "EDIT_SITE", runtime: "LOCAL_CLI",
      agentProvider: provider.id, userRequest: renameInstruction,
    })).rejects.toMatchObject({ code: "PROVIDER_NOT_AVAILABLE" });
    expect(provider.callCount).toBe(1);
    await execution.destroyEnvironment(environment.id);
  });
});

describe("Phase 7E case-insensitive explicit brand rename", () => {
  const requirements = parseEditRequirements(renameInstruction);
  const variants = ["FlowPilot", "flowpilot", "FLOWPILOT", "fLoWpIlOt"];

  it.each(variants)("discovers %s and preserves the supplied source byte-for-byte", (brand) => {
    const file = { path: "src/components/ProductPreview.jsx", content: `<span>${brand} / launch-plan</span>` };
    expect(containsRenameLiteral(file.content, "FlowPilot")).toBe(true);
    const selected = selectEditContextFiles(renameInstruction, [file]).selected;
    expect(selected).toEqual([file]);
    expect(selected[0]).toBe(file);
    expect(suppliedEditRequirementContext(requirements, selected).renamePaths).toEqual([file.path]);
  });

  it("extends only explicit brand coverage beyond eight ranked files, including baseline CSS and index.html", () => {
    const files = [
      ...Array.from({ length: 12 }, (_, index) => ({ path: `src/Brand${index}.jsx`, content: `<p>${variants[index % variants.length]}</p>` })),
      { path: "index.html", content: "<title>flowpilot</title>" },
      { path: "src/styles.css", content: "/* FLOWPILOT */" },
      ...Array.from({ length: 12 }, (_, index) => ({ path: `src/Other${index}.jsx`, content: "unrelated content" })),
    ];
    const selection = selectEditContextFiles(renameInstruction, files);
    expect(selection.selected).toEqual(files.slice(0, 14));
    expect(suppliedEditRequirementContext(requirements, selection.selected).renamePaths).toHaveLength(14);
    expect(selectEditContextFiles("Update the content", files).selected).toHaveLength(8);
    // Term scoring can select casing variants normally, but cannot bypass the cap without a parsed rename.
    expect(selectEditContextFiles("Describe FlowPilot", files).selected).toHaveLength(8);
  });

  it("adds compact casing guidance without duplicating source or changing normal-edit guidance", () => {
    const context = { renamePaths: ["src/App.jsx"], stylePaths: [] };
    const guidance = mandatoryEditRequirements(requirements, context);
    const previous = 'MANDATORY EDIT REQUIREMENTS: cover ALL in returned plan operations; omit none.\nRENAME "FlowPilot" -> "NovaPay": cover supplied editable old-literal occurrences.';
    expect(guidance).toContain("including casing variants; use exact source anchors");
    expect(guidance.length - previous.length).toBeLessThan(60);
    expect(mandatoryEditRequirements(parseEditRequirements("Rewrite the hero"), context)).toBe("");
  });

  it.each(variants)("rejects remaining %s with case-insensitive rename diagnostics and no source rewrite", (brand) => {
    const candidate = new Map([["src/Preview.jsx", `<span>${brand}</span>`]]);
    const unchanged = new Map(candidate);
    expect(captureFailure(() => validateEditRequirements(requirements, sources, candidate))).toMatchObject({
      code: "EDIT_REQUIREMENT_INCOMPLETE",
      metadata: { requirement: "rename", oldLiteral: "FlowPilot", matchMode: "case-insensitive", remainingFiles: ["src/Preview.jsx"] },
    });
    expect(candidate).toEqual(unchanged);
  });

  it.each(["flowpilot", "FLOWPILOT"])("includes %s inside index.html in coverage and completion", (brand) => {
    const file = { path: "index.html", content: `<title>${brand}</title>` };
    expect(suppliedEditRequirementContext(requirements, [file]).renamePaths).toEqual(["index.html"]);
    expect(captureFailure(() => validateEditRequirements(requirements, new Map(), new Map([[file.path, file.content]])))).toMatchObject({
      metadata: { requirement: "rename", oldLiteral: "FlowPilot", matchMode: "case-insensitive", remainingFiles: ["index.html"] },
    });
  });

  it("reports all remaining files once in sorted order and excludes already-renamed files", () => {
    const candidate = new Map([
      ["src/Z.jsx", "flowpilot FLOWPILOT"], ["src/A.jsx", "fLoWpIlOt"],
      ["index.html", "flowpilot"], ["src/Renamed.jsx", "NovaPay"],
    ]);
    expect(captureFailure(() => validateEditRequirements(requirements, sources, candidate))).toMatchObject({
      metadata: { requirement: "rename", oldLiteral: "FlowPilot", matchMode: "case-insensitive", remainingFiles: ["index.html", "src/A.jsx", "src/Z.jsx"] },
    });
  });

  it("accepts zero remaining variants after exact model-authored patches", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    const original = variants.join(" | ");
    try {
      await execution.writeFile(environment.id, "src/App.jsx", original);
      await applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({
        patches: variants.map((find) => ({ path: "src/App.jsx", find, replace: "NovaPay", mode: "all" })),
      }));
      const candidate = await readEditRequirementFiles(execution, environment.id);
      expect(candidate.get("src/App.jsx")).toBe("NovaPay | NovaPay | NovaPay | NovaPay");
      expect(() => validateEditRequirements(requirements, new Map([["src/App.jsx", original]]), candidate)).not.toThrow();
    } finally { await execution.destroyEnvironment(environment.id); }
  });

  it("keeps all-mode patches case-sensitive rather than auto-replacing casing variants", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    try {
      await execution.writeFile(environment.id, "src/App.jsx", "FlowPilot flowpilot FLOWPILOT");
      await applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({
        patches: [{ path: "src/App.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" }],
      }));
      expect(await execution.readFile(environment.id, "src/App.jsx")).toBe("NovaPay flowpilot FLOWPILOT");
    } finally { await execution.destroyEnvironment(environment.id); }
  });

  it("rejects wrong-case patch anchors without fuzzy matching or writes", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    try {
      await execution.writeFile(environment.id, "src/App.jsx", "flowpilot");
      const writes = vi.spyOn(execution, "writeFile");
      await expect(applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({
        patches: [{ path: "src/App.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" }],
      }))).rejects.toMatchObject({ code: "VALIDATION_FAILED", metadata: { matches: 0 } });
      expect(writes).not.toHaveBeenCalled();
    } finally { await execution.destroyEnvironment(environment.id); }
  });

  it("keeps deterministic sequential rebasing exact for a lowercase brand", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    try {
      await execution.writeFile(environment.id, "src/App.jsx", "<h1>flowpilot finance</h1>");
      await applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({ patches: [
        { path: "src/App.jsx", find: "flowpilot", replace: "NovaPay", mode: "all" },
        { path: "src/App.jsx", find: "<h1>flowpilot finance</h1>", replace: "<h1>NovaPay AI finance</h1>", mode: "unique" },
      ] }));
      expect(await execution.readFile(environment.id, "src/App.jsx")).toBe("<h1>NovaPay AI finance</h1>");
    } finally { await execution.destroyEnvironment(environment.id); }
  });

  it("does not treat literal punctuation as regex or use fuzzy brand matching", () => {
    expect(containsRenameLiteral("FLOW.PILOT", "Flow.Pilot")).toBe(true);
    expect(containsRenameLiteral("FlowXPilot", "Flow.Pilot")).toBe(false);
    expect(containsRenameLiteral("Flow Pilot", "FlowPilot")).toBe(false);
  });

  it("leaves style validation authoritative after all casing variants are renamed", () => {
    const before = new Map([["src/App.jsx", "flowpilot"], ["src/theme.css", ":root { --accent: blue; }"]]);
    const candidate = new Map(before).set("src/App.jsx", "NovaPay");
    const combined = parseEditRequirements(combinedInstruction);
    expect(captureFailure(() => validateEditRequirements(combined, before, candidate))).toMatchObject({ metadata: { requirement: "style" } });
    candidate.set("src/theme.css", ":root { --accent: green; }");
    expect(() => validateEditRequirements(combined, before, candidate)).not.toThrow();
  });

  it("does not impose rename coverage or completeness on normal text edits", () => {
    const normal = parseEditRequirements("Rewrite the hero");
    const files = [{ path: "src/App.jsx", content: "flowpilot" }];
    const context = suppliedEditRequirementContext(normal, files);
    expect(context.renamePaths).toEqual([]);
    expect(() => validateEditPlanCoverage(normal, context, [{ path: "src/App.jsx", find: "Hello", replace: "Welcome" }])).not.toThrow();
    expect(() => validateEditRequirements(normal, new Map(), new Map([[files[0]!.path, files[0]!.content]]))).not.toThrow();
  });

  it("uses lowercase-only supplied files for early rename plan coverage", () => {
    const context = suppliedEditRequirementContext(requirements, [{ path: "src/Preview.jsx", content: "flowpilot" }]);
    expect(() => validateEditPlanCoverage(requirements, context, [{ path: "src/Preview.jsx", find: "flowpilot", replace: "NovaPay" }])).not.toThrow();
    expect(() => validateEditPlanCoverage(requirements, context, [])).toThrow("required rename operation");
  });

  it("does not discover, read, or validate blocked/managed files", async () => {
    const blocked = ["package.json", "package-lock.json", "yarn.lock", ".env", ".env.local", "credentials.json", "dist/index.html", "build/output.js", "node_modules/brand/index.js", "site-template.json", "src/main.tsx", "src/sites-ui/tokens.ts"];
    const files = blocked.map((path) => ({ path, content: "flowpilot FLOWPILOT" }));
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    try {
      for (const file of files) await execution.writeFile(environment.id, file.path, file.content);
      const reads = vi.spyOn(execution, "readFile");
      expect(await readEditRequirementFiles(execution, environment.id)).toEqual(new Map());
      expect(reads).not.toHaveBeenCalled();
      expect(selectEditContextFiles(renameInstruction, files).selected).toEqual([]);
      expect(suppliedEditRequirementContext(requirements, files).renamePaths).toEqual([]);
      expect(() => validateEditRequirements(requirements, new Map(), new Map(files.map(({ path, content }) => [path, content])))).not.toThrow();
    } finally { await execution.destroyEnvironment(environment.id); }
  });
});

describe("explicit targeted edit requirements", () => {
  it.each([
    renameInstruction,
    "Rename FlowPilot to NovaPay, then rewrite the hero.",
    "Change FlowPilot to NovaPay.",
    "Replace FlowPilot with NovaPay.",
    'Rename "Flow Pilot" to "Nova Pay".',
  ])("extracts a clear literal pair: %s", (instruction) => {
    const rename = parseEditRequirements(instruction).rename;
    expect(rename).toEqual(instruction.includes('"')
      ? { oldLiteral: "Flow Pilot", newLiteral: "Nova Pay" }
      : { oldLiteral: "FlowPilot", newLiteral: "NovaPay" });
  });

  it.each([
    "Change the hero button text to Book a Table",
    "Change the primary accent from blue to a deep green",
    "Rename the company to NovaPay",
    "Rename FlowPilot to FlowPilot Pro",
    "Rename Alpha to Beta. Rename Gamma to Delta.",
  ])("falls back for ambiguous or nonliteral rename instructions: %s", (instruction) => {
    expect(parseEditRequirements(instruction).rename).toBeUndefined();
  });

  it("includes every literal rename casing match beyond eight files without growing unrelated ranked context", () => {
    const files = [
      ...Array.from({ length: 12 }, (_, index) => ({ path: `src/Brand${index}.jsx`, content: `FlowPilot ${index}` })),
      ...Array.from({ length: 20 }, (_, index) => ({ path: `src/Other${index}.jsx`, content: "unrelated hero" })),
      { path: "index.html", content: "<title>FlowPilot</title>" },
      { path: "src/Case.jsx", content: "flowpilot" },
      { path: ".env", content: "FlowPilot" },
    ];
    const selected = selectEditContextFiles(renameInstruction, files).selected;
    expect(selected.filter((file) => file.content.includes("FlowPilot") && file.path !== ".env")).toHaveLength(13);
    expect(selected.some((file) => file.path === "src/Case.jsx")).toBe(true);
    expect(selected.some((file) => file.path === ".env")).toBe(false);
    const ordinary = selectEditContextFiles("Update the hero", files).selected;
    expect(ordinary).toHaveLength(8);
  });

  it.each(["package.json", "package-lock.json", ".env", ".env.local", "vite.config.ts", "site-template.json", "../index.html", "/index.html", "src/main.tsx"])("keeps %s forbidden", (path) => {
    expect(() => validateSiteEditPatchBundle({ patches: [{ path, find: "x", replace: "y", mode: "all" }] })).toThrow();
    expect(isEditableContextPath(path, SITE_V1_TECHNICAL_PROFILE)).toBe(false);
  });

  it("allows root index.html for targeted patches only", async () => {
    expect(isEditableContextPath("index.html", SITE_V1_TECHNICAL_PROFILE)).toBe(true);
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    await execution.writeFile(environment.id, "index.html", "<title>FlowPilot</title>");
    await applySiteEditPatchBundle(execution, environment.id, validateSiteEditPatchBundle({
      patches: [{ path: "index.html", find: "FlowPilot", replace: "NovaPay", mode: "all" }],
    }));
    expect(await execution.readFile(environment.id, "index.html")).toBe("<title>NovaPay</title>");
    expect(() => validateSiteCoderFileBundle({ files: [{ path: "index.html", content: "x" }] })).toThrow();
    expect(() => validateBuildRepairPatchBundle({ patches: [{ path: "index.html", find: "x", replace: "y" }] })).toThrow();
  });

  it("scans only safe editable text and accepts zero remaining exact old literals", async () => {
    const execution = new MockExecutionProvider();
    const environment = await execution.createEnvironment({});
    for (const [path, content] of renamed()) await execution.writeFile(environment.id, path, content);
    for (const path of [".env", "package.json", "src/main.tsx"])
      await execution.writeFile(environment.id, path, "FlowPilot");
    const after = await readEditRequirementFiles(execution, environment.id);
    expect(after.size).toBe(4);
    expect(() => validateEditRequirements(parseEditRequirements(renameInstruction), sources, after)).not.toThrow();
  });

  it("rejects an incomplete rename with exact remaining-file diagnostics", () => {
    const candidate = renamed();
    candidate.set("src/About.jsx", sources.get("src/About.jsx")!);
    let failure: unknown;
    try { validateEditRequirements(parseEditRequirements(renameInstruction), sources, candidate); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({
      code: "EDIT_REQUIREMENT_INCOMPLETE",
      metadata: { requirement: "rename", oldLiteral: "FlowPilot", remainingFiles: ["src/About.jsx"] },
    });
  });

  it.each(["color", "colour", "accent", "palette", "theme", "visual styling"])("detects explicit %s requests", (term) => {
    expect(parseEditRequirements(`Change the ${term} to suit the new brand.`).style).toBe(true);
  });

  it("does not enforce a style change when asked to preserve it", () => {
    expect(parseEditRequirements("Rewrite the hero. Keep the existing theme and colors.").style).toBe(false);
  });

  it("keeps token context for a combined functionality and explicit accent request", () => {
    const selection = selectEditContextFiles("Make every page functional and change the primary accent to deep green", [
      { path: "src/App.tsx", content: "<main>Hello</main>" },
      { path: "src/styles.css", content: ":root { --accent: blue; }" },
    ], { includeAllEditable: true });
    expect(selection.styleIntent).toBe(true);
    expect(selection.selected.map((file) => file.path)).toContain("src/styles.css");
  });

  it("includes style tokens and requires an actual CSS change, without choosing or writing a color", () => {
    const requirements = parseEditRequirements(combinedInstruction);
    const candidate = renamed();
    expect(selectEditContextFiles(combinedInstruction, [...sources].map(([path, content]) => ({ path, content }))).selected.map((file) => file.path)).toContain("src/global.css");
    let failure: unknown;
    try { validateEditRequirements(requirements, sources, candidate); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({
      code: "EDIT_REQUIREMENT_INCOMPLETE", metadata: { requirement: "style" },
    });
    expect(candidate.get("src/global.css")).toBe(sources.get("src/global.css"));
    candidate.set("src/global.css", ":root { --blue: #14532d; }");
    expect(() => validateEditRequirements(requirements, sources, candidate)).not.toThrow();
  });

  it("recognizes inline style/theme token changes while rejecting unrelated text in a styled file", () => {
    const before = new Map([["src/App.jsx", '<div style={{ color: "blue" }}>Hello</div>']]);
    const requirements = parseEditRequirements("Change the color to green");
    expect(() => validateEditRequirements(requirements, before, new Map([
      ["src/App.jsx", '<div style={{ color: "blue" }}>World</div>'],
    ]))).toThrow();
    expect(() => validateEditRequirements(requirements, before, new Map([
      ["src/App.jsx", '<div style={{ color: "green" }}>Hello</div>'],
    ]))).not.toThrow();
    expect(() => validateEditRequirements(requirements, new Map([["src/theme.ts", 'const theme = { primary: "blue" };']]),
      new Map([["src/theme.ts", 'const theme = { primary: "green" };']]))).not.toThrow();
  });

  it("leaves ordinary edits without explicit requirements unchanged", () => {
    expect(() => validateEditRequirements(parseEditRequirements("Rewrite the hero"), sources, sources)).not.toThrow();
  });
});

describe("completion failure ordering through the existing edit pipeline (offline fixtures only)", () => {
  it.each(["rename", "style", "rename-lowercase", "rename-uppercase"] as const)("preserves current source/version and never finalizes billing after incomplete %s", async (scenario) => {
    const requirement = scenario === "style" ? "style" : "rename";
    const remainingVariant = scenario === "rename-lowercase" ? "flowpilot" : scenario === "rename-uppercase" ? "FLOWPILOT" : undefined;
    const root = await mkdtemp(join(tmpdir(), "sites-edit-completeness-"));
    let editContext = "";
    const mock = new MockAgentProvider({ customResponse: (request) => {
      editContext = request.messages.map((message) => message.content).join("\n");
      return {
      id: "offline-response", model: request.model,
      message: { role: "assistant", content: JSON.stringify({ patches:
        (remainingVariant ? ["index.html", "src/Brand.jsx", "src/About.jsx", "src/App.jsx"] : ["src/App.jsx"])
          .map((path) => ({ path, find: "FlowPilot", replace: "NovaPay", mode: "all" })),
      }) },
      toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      latencyMs: 1, finishReason: "stop",
      };
    } });
    const provider = {
      id: "offline-fixture",
      getCapabilities: () => mock.getCapabilities(),
      createResponse: mock.createResponse.bind(mock),
    };
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const finalize = vi.fn();
    const preflight = vi.fn(async () => ({
      userId: "offline-owner", provider: provider.id,
      modelRate: { model: "mock-sites-v1", platform: provider.id, type: "ai_chat", creditsPer500Tokens: 1 },
    }));
    const product = createLocalSitesProduct({
      executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"),
      agentRegistry: registry, orchestrationAgent: provider,
      billing: { preflight, finalizeSuccessfulJob: finalize } as unknown as SiteCreditBillingService,
    });
    const siteId = "offline-existing-project" as SiteId;
    const owner = "offline-owner" as UserId;
    const versionId = "offline-current-version" as VersionId;
    try {
      const environment = await product.execution.createEnvironment({});
      for (const [path, content] of sources) await product.execution.writeFile(environment.id, path, content);
      if (scenario === "rename") {
        // More than the inline-prefix threshold and eight ranked files: exact matches must all survive selection.
        for (let index = 0; index < 12; index += 1)
          await product.execution.writeFile(environment.id, `src/brand/Brand${index}.jsx`, `/* ${"padding ".repeat(250)} */\nexport const label = "FlowPilot";`);
        await product.execution.writeFile(environment.id, "public/logo.svg", "<svg><title>FlowPilot</title></svg>");
      }
      if (remainingVariant)
        await product.execution.writeFile(environment.id, "src/components/ProductPreview.jsx", `<span>${remainingVariant} / launch-plan</span>`);
      await product.execution.writeFile(environment.id, "src/App.jsx", "export default function App() { return <main>FlowPilot</main>; }");
      await product.execution.writeFile(environment.id, "package.json", JSON.stringify({
        scripts: { build: "vite build", dev: "vite" },
        dependencies: { react: "18.3.1", "react-dom": "18.3.1" }, devDependencies: { vite: "6.4.1" },
      }));
      const sourceRef = "sites/offline-existing-project/versions/v1/source/source.json";
      await new SiteSourceSnapshotService(product.artifacts).capture(product.execution, environment.id, sourceRef, {
        technicalProfileId: "react-vite-v1", templateId: "react-vite-v1", templateVersion: 1,
      });
      const originalBytes = await product.artifacts.get(sourceRef);
      await product.execution.destroyEnvironment(environment.id);
      const now = new Date();
      await product.projects.save({ id: siteId, ownerId: owner, name: "Existing project", slug: "existing", status: "ACTIVE", latestVersionId: versionId, createdAt: now, updatedAt: now });
      await product.versions.save({ id: versionId, siteId, versionNumber: 1, sourceArtifactRef: sourceRef, buildStatus: "SUCCEEDED", createdAt: now });
      // Installation is stubbed: this test runs no shell commands or network requests.
      const commands = vi.spyOn(product.execution, "executeCommand").mockResolvedValue({
        exitCode: 0, stdout: "offline", stderr: "", timedOut: false, durationMs: 0, startedAt: now, finishedAt: now,
      });
      const commit = vi.spyOn(product.versions, "save");
      const projectUpdate = vi.spyOn(product.projects, "save");
      await expect(product.orchestrator.editWebsite({
        userId: owner, siteId, agentProvider: provider.id,
        instruction: requirement === "rename" ? renameInstruction : "Change the primary accent to deep green",
        browserQAEnabled: false,
      })).rejects.toMatchObject({
        code: "EDIT_REQUIREMENT_INCOMPLETE",
        metadata: remainingVariant
          ? { requirement, oldLiteral: "FlowPilot", matchMode: "case-insensitive", remainingFiles: ["src/components/ProductPreview.jsx"] }
          : { requirement },
      });
      expect(mock.callCount).toBe(2);
      if (scenario === "rename") {
        for (let index = 0; index < 12; index += 1)
          expect(editContext).toContain(`--- src/brand/Brand${index}.jsx\n`);
        expect(editContext).toContain("--- index.html\n");
        expect(editContext).toContain("--- public/logo.svg\n");
      }
      if (remainingVariant) {
        // Plain pre-existing/generated project: no published template or instantiation path is needed.
        expect(editContext).toContain(`--- src/components/ProductPreview.jsx\n`);
        expect(editContext).toContain(`<span>${remainingVariant} / launch-plan</span>`);
      }
      expect(preflight).toHaveBeenCalledTimes(2);
      expect(finalize).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(projectUpdate).not.toHaveBeenCalled();
      expect(commands.mock.calls.every(([, command]) => command.args?.[0] === "ci")).toBe(true);
      expect((await product.projects.getById(siteId))?.latestVersionId).toBe(versionId);
      expect(await product.artifacts.get(sourceRef)).toEqual(originalBytes);
      expect((await product.versions.listBySite(siteId)).items).toHaveLength(1);
      expect((await product.jobs.listBySite(siteId)).items[0]).toMatchObject({
        status: "FAILED", billingStatus: "NOT_CHARGED", creditsCharged: 0, logicalCalls: 2, physicalRequests: 2, retries: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
