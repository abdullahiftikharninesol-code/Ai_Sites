import { describe, expect, it } from "vitest";
import { openAIPromptCacheKey } from "../src/agents/openai/prompt-cache-key.js";
import { mapAgentRequest } from "../src/agents/openai/openai-agent.mapper.js";
import type { OpenAIResponseRequest } from "../src/agents/openai/openai-agent.mapper.js";
import { OpenAIAgentProvider } from "../src/agents/openai/openai-agent.provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { InProcessAgentGateway } from "../src/agents/gateway/in-process-agent-gateway.js";
import { LocalCliAgentRuntime } from "../src/cli/runtime/local-cli-agent-runtime.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";

const projectId = "94633e2b-66fe-4e44-aae1-4261f0812b14";
const normalIdentity = `sites:${projectId}:EDIT_SITE`;
const repairIdentity = `${normalIdentity}:requirement-repair`;
const model = "gpt-5.6-luna";
const config = {
  apiKey: "offline-dummy-key",
  model,
  reasoningEffort: "low" as const,
  timeoutMs: 1_000,
  maxRetries: 0,
};
const request = {
  model,
  messages: [{ role: "user" as const, content: "Stable source prefix; variable edit" }],
};

describe("OpenAI bounded prompt cache identities", () => {
  it.each([
    ["normal targeted edit", normalIdentity],
    ["repair targeted edit (previously 71 characters)", repairIdentity],
    ["generation", `sites:${projectId}:GENERATE_SITE`],
    ["arbitrarily long project ID", `sites:${"project-id".repeat(20_000)}:EDIT_SITE:requirement-repair`],
    ["multibyte identity", `sites:${"项目🚀".repeat(10_000)}:EDIT_SITE`],
    ["64-character identity", "a".repeat(64)],
    ["65-character identity", "a".repeat(65)],
    ["empty helper input", ""],
  ])("bounds %s to 49 ASCII characters", (_label, identity) => {
    const key = openAIPromptCacheKey(identity);
    expect(key).toMatch(/^sites-[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(49);
    expect(Buffer.byteLength(key, "utf8")).toBeLessThanOrEqual(64);
  });

  it("is stable for the same full logical identity", () => {
    expect(openAIPromptCacheKey(repairIdentity)).toBe(openAIPromptCacheKey(repairIdentity));
    expect(mapAgentRequest({ ...request, promptCacheKey: repairIdentity }).prompt_cache_key)
      .toBe(mapAgentRequest({ ...request, promptCacheKey: repairIdentity }).prompt_cache_key);
  });

  it("distinguishes projects, operations, attempts, and suffixes beyond the limit", () => {
    const sharedPrefix = "long-project-id-".repeat(100);
    const identities = [
      normalIdentity,
      repairIdentity,
      `sites:another-project:EDIT_SITE`,
      `sites:${projectId}:GENERATE_SITE`,
      `${sharedPrefix}:one`,
      `${sharedPrefix}:two`,
    ];
    expect(new Set(identities.map(openAIPromptCacheKey)).size).toBe(identities.length);
  });

  it("never copies raw identity, secrets, source, or prompt content into the key", () => {
    const secret = "sk-offline-secret-marker";
    const source = '<h1 className="hero">PRIVATE_SOURCE_MARKER</h1>';
    const mapped = mapAgentRequest({
      ...request,
      systemInstructions: "PRIVATE_SYSTEM_PROMPT",
      messages: [{ role: "user", content: source }],
      // Even an incorrectly supplied sensitive cache identity must be opaque.
      promptCacheKey: `${secret}:${source}`,
    });
    for (const raw of [secret, source, "PRIVATE_SOURCE_MARKER", "PRIVATE_SYSTEM_PROMPT"])
      expect(mapped.prompt_cache_key).not.toContain(raw);
    expect(mapped.prompt_cache_key).toMatch(/^sites-[A-Za-z0-9_-]{43}$/);
    expect(mapped.instructions).toBe("PRIVATE_SYSTEM_PROMPT");
    expect(mapped.input).toEqual([{ role: "user", content: source }]);
  });

  it("uses only the intended identity, retaining cache reuse across variable prompts", () => {
    const first = mapAgentRequest({ ...request, promptCacheKey: normalIdentity });
    const second = mapAgentRequest({
      ...request,
      promptCacheKey: normalIdentity,
      messages: [{ role: "user", content: "A different edit and source context" }],
    });
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(second.input).not.toEqual(first.input);
  });

  it("keeps caching optional and changes no other mapped request fields", () => {
    const uncached = mapAgentRequest({ ...request, cachePrefixChars: 7 }, "low");
    const { prompt_cache_key: cacheKey, ...cached } = mapAgentRequest({
      ...request,
      cachePrefixChars: 7,
      promptCacheKey: normalIdentity,
    }, "low");
    expect(cacheKey).toBe(openAIPromptCacheKey(normalIdentity));
    expect(cached).toEqual(uncached);
    expect(uncached.prompt_cache_key).toBeUndefined();
    expect(mapAgentRequest({ ...request, promptCacheKey: "" }).prompt_cache_key).toBeUndefined();
  });
});

describe("OpenAI SDK request boundary (injected client, no network)", () => {
  it.each([normalIdentity, repairIdentity, "long-id".repeat(20_000)])(
    "bounds every supplied identity before the SDK receives it (%#)",
    async (identity) => {
      const sent: OpenAIResponseRequest[] = [];
      const provider = new OpenAIAgentProvider(config, { client: {
        create: async (mapped) => {
          sent.push(mapped);
          return { id: "offline-response", model, output_text: "ok" };
        },
      } });
      await expect(provider.createResponse({ ...request, promptCacheKey: identity }))
        .resolves.toMatchObject({ message: { content: "ok" } });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.prompt_cache_key).toBe(openAIPromptCacheKey(identity));
      expect(sent[0]?.prompt_cache_key).toHaveLength(49);
      expect(sent[0]?.model).toBe(model);
    },
  );
});

describe("Targeted Edit cache-key regression through OpenAI mapping (no network)", () => {
  it.each(["complete-first", "complete-repair", "incomplete-repair"] as const)(
    "%s preserves exact edits and the one-repair maximum",
    async (scenario) => {
      const execution = new MockExecutionProvider();
      const environment = await execution.createEnvironment({});
      const sent: OpenAIResponseRequest[] = [];
      try {
        await execution.writeFile(environment.id, "src/App.jsx", "export default function App() { return <h1>FlowPilot</h1>; }");
        await execution.writeFile(environment.id, "src/styles.css", ":root { --accent: #2563eb; }");
        const rename = { path: "src/App.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" };
        const style = { path: "src/styles.css", find: "#2563eb", replace: "#14532d", mode: "unique" };
        const provider = new OpenAIAgentProvider(config, { client: {
          create: async (mapped) => {
            sent.push(mapped);
            // No third response is available. A third call is also a test failure.
            if (sent.length > 2) throw new Error("Unexpected third Targeted Edit call");
            const patches = sent.length === 1
              ? scenario === "complete-first" ? [rename, style] : [rename]
              : [{ ...style, replace: scenario === "complete-repair" ? style.replace : style.find }];
            return {
              id: `offline-edit-${sent.length}`,
              model,
              output_text: JSON.stringify({ patches }),
              usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
            };
          },
        } });
        const registry = new AgentProviderRegistry();
        registry.register(provider);
        const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, execution as never);
        const run = runtime.run(environment.id, {
          jobId: "offline-cache-key-regression",
          siteId: projectId,
          operation: "EDIT_SITE",
          runtime: "LOCAL_CLI",
          agentProvider: provider.id,
          userRequest: "Rename FlowPilot to NovaPay. Change the primary accent to deep green.",
        });
        if (scenario === "incomplete-repair") {
          await expect(run).rejects.toMatchObject({
            code: "EDIT_REQUIREMENT_INCOMPLETE",
            retryable: false,
            metadata: { attempts: 2, missingRequirements: ["style"] },
          });
        } else {
          const result = await run;
          const calls = scenario === "complete-first" ? 1 : 2;
          expect(result.success).toBe(true);
          expect(result.turns).toBe(calls);
          expect(result.buildRepairInvoked).toBe(false);
          expect(result.usage).toMatchObject({ modelCalls: calls, inputTokens: calls * 11, outputTokens: calls * 22 });
          expect(await execution.readFile(environment.id, "src/styles.css")).toContain("#14532d");
        }
        expect(await execution.readFile(environment.id, "src/App.jsx")).toContain("NovaPay");
        expect(sent).toHaveLength(scenario === "complete-first" ? 1 : 2);
        expect(sent.length).toBeLessThanOrEqual(2);
        expect(sent[0]?.prompt_cache_key).toBe(openAIPromptCacheKey(normalIdentity));
        for (const mapped of sent) {
          expect(mapped.prompt_cache_key).toHaveLength(49);
          expect(mapped.text?.format?.name).toBe("SiteEditPatchBundle");
          expect(mapped.model).toBe(model);
        }
        if (sent.length === 2) {
          expect(sent[1]?.prompt_cache_key).toBe(openAIPromptCacheKey(repairIdentity));
          const repairInput = JSON.stringify(sent[1]?.input);
          expect(repairInput).toContain("attempt 2 of 2");
          expect(repairInput).toContain("No further repair call is allowed");
          expect(repairInput).toContain("src/styles.css");
          expect(repairInput).not.toContain("src/App.jsx");
        }
      } finally {
        await execution.destroyEnvironment(environment.id);
      }
    },
  );
});
