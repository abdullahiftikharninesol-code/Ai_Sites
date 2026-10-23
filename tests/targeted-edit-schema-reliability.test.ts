import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../src/app/errors/application-error.js";
import { isBroadFunctionalEdit } from "../src/cli/runtime/edit-context-selection.js";
import { SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA, validateSiteEditPatchBundle, validateSiteCoderFileBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { parseStructuredAgentResponse } from "../src/agents/shared/structured-response-parser.js";
import type { AgentResponse } from "../src/agents/agent-types.js";
import { OpenAIAgentProvider } from "../src/agents/openai/openai-agent.provider.js";
import type { OpenAIResponseRequest } from "../src/agents/openai/openai-agent.mapper.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { InProcessAgentGateway } from "../src/agents/gateway/in-process-agent-gateway.js";
import { LocalCliAgentRuntime } from "../src/cli/runtime/local-cli-agent-runtime.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { createDevelopmentGenerationTelemetry } from "../src/sites/generation/generation-development-telemetry.js";

const instruction = "Rename ApexBridge Group to Nexora Technologies. Change the homepage headline and hero description. Change the primary accent color to #2563EB. Preserve the existing layout and all functionality.";
const contract = { type: "JSON_SCHEMA" as const, name: "SiteEditPatchBundle", schema: SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA, strict: true };
const patch = { path: "index.html", find: "ApexBridge Advisory", replace: "Nexora Technologies", mode: "all" };
function response(content: string, finishReason: AgentResponse["finishReason"] = "stop"): AgentResponse {
  return { id: "offline-schema-fixture", model: "gpt-5.6-luna", message: { role: "assistant", content }, finishReason, usage: { inputTokens: 100, outputTokens: 50 }, toolCalls: [], latencyMs: 0 };
}
const parse = (content: string, finishReason?: AgentResponse["finishReason"]) => parseStructuredAgentResponse({ response: response(content, finishReason), contract, validate: validateSiteEditPatchBundle, errorContext: "Site edit" });
function failure(action: () => unknown): ApplicationError {
  try { action(); } catch (error) { if (error instanceof ApplicationError) return error; throw error; }
  throw new Error("Expected ApplicationError");
}

describe("Targeted Edit contract selection", () => {
  it.each([
    instruction,
    "Change the homepage headline, preserve all existing functionality.",
    "Update all pages. Keep all buttons working.",
    "Rename the company and retain the existing website functionality.",
    "Change the homepage without breaking existing functionality.",
    "Do not make all buttons work. Change the headline only.",
  ])("preservation/negative clauses do not request a full-file rewrite: %s", text => {
    expect(isBroadFunctionalEdit(text)).toBe(false);
  });
  it.each([
    "make the pages functional as well", "make all buttons work",
    "Preserve the design but make all pages functional.",
    "Make all buttons work and keep the existing layout.",
  ])("real whole-app functional requests retain their existing route: %s", text => {
    expect(isBroadFunctionalEdit(text)).toBe(true);
  });
  it("reproduces the recorded index.html rejection without inventing an original response", () => {
    // Representative payload grounded in the retained job exception; not its unavailable response.
    expect(() => validateSiteCoderFileBundle({ files: [{ path: "index.html", content: "<title>Nexora Technologies</title>" }] }))
      .toThrow("Site coder bundle contains a disallowed path: index.html");
    expect(parse(JSON.stringify({ patches: [patch] })).value.patches[0]).toEqual(patch);
  });
});

describe("Safe deterministic Targeted Edit response handling", () => {
  it.each([JSON.stringify({ patches: [patch] }), "```json\n" + JSON.stringify({ patches: [patch] }) + "\n```"])("accepts only JSON or a single supported outer fence", content => {
    expect(parse(content).value.patches).toEqual([patch]);
  });
  it("retains the established safe legacy missing-mode default", () => {
    expect(parse(JSON.stringify({ patches: [{ path: patch.path, find: patch.find, replace: patch.replace }] })).value.patches[0]?.mode).toBe("unique");
  });
  it.each([
    [{}, "$.patches"],
    [{ files: [] }, "$.patches"],
    [{ patches: [{ path: "src/App.jsx", replace: "new" }] }, "$.patches[0].find"],
    [{ patches: [{ ...patch, replace: null }] }, "$.patches[0].replace"],
    [{ patches: [{ ...patch, path: 42 }] }, "$.patches[0].path"],
    [{ patches: [{ ...patch, mode: "fuzzy" }] }, "$.patches[0].mode"],
    [{ patches: [{ ...patch, path: "package.json" }] }, "$.patches[0].path"],
    [{ patches: [patch], files: [] }, "$"],
    [{ patches: [{ ...patch, arbitrary: "private-secret" }] }, "$.patches[0]"],
    [{ patches: [] }, "$.patches"],
  ])("rejects invalid shapes at the exact field without logging response content", (value, path) => {
    try { parse(JSON.stringify(value)); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toMatchObject({ code: "STRUCTURED_RESPONSE_SCHEMA_INVALID", metadata: { validationPath: path, responseSchema: "SiteEditPatchBundle", finishReason: "stop", truncated: false, inputTokens: 100, outputTokens: 50 } });
      expect((error as ApplicationError).metadata?.responseSchemaVersion).toMatch(/^[a-f0-9]{16}$/);
      expect((error as Error).message).not.toContain("private-secret");
    }
  });
  it("rejects malformed JSON safely, without embedding private parse excerpts", () => {
    expect(failure(() => parse('{"private-secret": bad-json}'))).toMatchObject({ code: "STRUCTURED_RESPONSE_PARSE_FAILED", metadata: { validationPath: "$", validationCategory: "MALFORMED_JSON" } });
    expect(() => parse('{"private-secret": bad-json}')).not.toThrow(/private-secret/);
  });
  it("never extracts JSON from prose or fabricates a truncated edit", () => {
    expect(failure(() => parse("Here is the response: " + JSON.stringify({ patches: [patch] })))).toMatchObject({ code: "STRUCTURED_RESPONSE_PARSE_FAILED" });
    expect(failure(() => parse('{"patches":[', "length"))).toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED", metadata: { truncated: true, finishReason: "length", responseSchema: "SiteEditPatchBundle" } });
  });
});

describe("Real runtime through injected OpenAI SDK boundary (zero network)", () => {
  it.each(["valid", "fenced", "missing", "malformed", "wrong-contract", "truncated"])("Corporate source receives the patch schema for %s output", async scenario => {
    const execution = new MockExecutionProvider(), env = await execution.createEnvironment({});
    const sent: OpenAIResponseRequest[] = [];
    const original = await readFile("templates/corporate-business/src/App.jsx", "utf8");
    try {
      for (const path of ["src/App.jsx", "src/styles.css", "index.html"]) await execution.writeFile(env.id, path, await readFile("templates/corporate-business/" + path, "utf8"));
      const bundle = { patches: [
        { path: "src/App.jsx", find: "ApexBridge Group", replace: "Nexora Technologies", mode: "all" },
        { path: "src/App.jsx", find: "APEXBRIDGE<small>GROUP</small>", replace: "NEXORA<small>TECHNOLOGIES</small>", mode: "all" },
        { path: "src/App.jsx", find: "ApexBridge", replace: "Nexora Technologies", mode: "all" },
        patch,
        { path: "src/App.jsx", find: "See the whole.<br/><em>Shape what’s next.</em>", replace: "Technology for tomorrow.<br/><em>Built with Nexora.</em>", mode: "unique" },
        { path: "src/App.jsx", find: "We help leaders make consequential decisions, move through complexity and build businesses that endure.", replace: "Nexora Technologies builds practical technology for ambitious businesses.", mode: "unique" },
        { path: "src/styles.css", find: "--brass:#bc9660", replace: "--brass:#2563EB", mode: "unique" },
      ] };
      const text = scenario === "missing" ? '{"patches":[{"path":"src/App.jsx"}]}' : scenario === "malformed" ? '{"patches":' : scenario === "wrong-contract" ? '{"files":[]}' : JSON.stringify(bundle);
      const provider = new OpenAIAgentProvider({ apiKey: "offline-dummy", model: "gpt-5.6-luna", reasoningEffort: "low", timeoutMs: 1000, maxRetries: 0 }, { client: { create: async mapped => {
        sent.push(mapped);
        return { id: "offline-edit", model: mapped.model, output_text: scenario === "fenced" ? "```json\n" + text + "\n```" : text,
          ...(scenario === "truncated" ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } : {}), usage: { input_tokens: 100, output_tokens: 50 } };
      } } });
      const registry = new AgentProviderRegistry(); registry.register(provider);
      const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, execution as never);
      const run = runtime.run(env.id, { jobId: "offline-schema-regression", siteId: "corporate-fixture", operation: "EDIT_SITE", runtime: "LOCAL_CLI", agentProvider: provider.id, userRequest: instruction });
      if (scenario === "valid" || scenario === "fenced") {
        expect((await run).success).toBe(true);
        expect(await execution.readFile(env.id, "src/App.jsx")).toContain("Technology for tomorrow");
        expect(await execution.readFile(env.id, "src/styles.css")).toContain("--brass:#2563EB");
      } else {
        await expect(run).rejects.toBeInstanceOf(ApplicationError);
        expect(await execution.readFile(env.id, "src/App.jsx")).toBe(original);
      }
      expect(sent).toHaveLength(1); // No schema-error retry, extra role or third call.
      expect(sent[0]?.text?.format).toMatchObject({ type: "json_schema", name: "SiteEditPatchBundle", strict: true, schema: SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA });
      const context = JSON.stringify(sent[0]?.input);
      expect(context).toContain("index.html"); expect(context).toContain("--brass:#bc9660"); expect(context).toContain("See the whole.");
    } finally { await execution.destroyEnvironment(env.id); }
  });
  it("keeps diagnostics development-only and explicitly whitelisted", () => {
    expect(createDevelopmentGenerationTelemetry("production")).toBeUndefined();
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      createDevelopmentGenerationTelemetry("development")!.record({ jobId: "safe-job", role: "sites.targeted-edit", responseSchema: "SiteEditPatchBundle", responseSchemaVersion: "safe-version", validationPath: "$.patches[0].find", billingStatus: "NOT_CHARGED", creditsCharged: 0, ...{ prompt: "private prompt", response: "private response", apiKey: "private credential" } });
      const logged = String(spy.mock.calls[0]?.[0]);
      expect(logged).toContain("safe-job"); expect(logged).toContain("$.patches[0].find"); expect(logged).not.toContain("private");
    } finally { spy.mockRestore(); }
  });
});
