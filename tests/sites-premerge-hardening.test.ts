import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DevJobManager } from "../src/dev-server/dev-job-manager.js";
import { normalizePlaygroundPrompt } from "../src/dev-server/playground-http-server.js";
import { InMemoryProgressBus } from "../src/sites/application/progress.js";
import {
  deriveSiteName,
  resolveGeneratedSiteName,
  validateSiteNameCandidate,
} from "../src/sites/generation/site-name.js";
import {
  SITE_CODER_FILE_BUNDLE_JSON_SCHEMA,
  validateSiteCoderFileBundle,
} from "../src/cli/runtime/site-coder-file-bundle.js";
import { attachmentUsageForPrompt } from "../web/src/components/attachment-usage.js";
import { ArtifactMediaStore, PLACEHOLDER_PNG } from "../src/sites/assets/media-store.js";
import { ingestUserImage, userAssetsManifest } from "../src/sites/assets/user-asset-ingestion.js";
import { assertStructuredResponseComplete, parseStructuredResponse } from "../src/agents/shared/structured-response-parser.js";
import { friendlyError } from "../web/src/error-messages.js";
import type { AgentResponse } from "../src/agents/agent-types.js";

class MemoryArtifacts {
  readonly files = new Map<string, Uint8Array>();
  async put(key: string, data: Uint8Array) { this.files.set(key, data); return { key, kind: "GENERATED_ASSET" as const, contentType: "image/png", sizeBytes: data.byteLength, createdAt: new Date() }; }
  async get(key: string) { return this.files.get(key); }
  async delete() {}
  async deletePrefix() {}
  async exists(key: string) { return this.files.has(key); }
}

describe("Sites pre-merge edge matrix", () => {
  it.each(["", "   ", "x".repeat(20_001)])("rejects an invalid prompt", (prompt) => {
    expect(() => normalizePlaygroundPrompt(prompt)).toThrow(/3 to 20000/);
  });

  it.each(["صمّم موقعاً لمقهى الندى", "🚀 Build a playful robotics portfolio"])(
    "accepts Unicode and emoji prompts",
    (prompt) => expect(normalizePlaygroundPrompt(prompt)).toBe(prompt),
  );

  it("resolves explicit, reference-image, content-image, and structured names canonically", () => {
    expect(resolveGeneratedSiteName({ prompt: 'Build a website for "TaskFlow"' })).toBe("TaskFlow");
    expect(resolveGeneratedSiteName({ prompt: 'I attached an image. Build a website for "Brew & Bean" using it as reference.' })).toBe("Brew & Bean");
    expect(resolveGeneratedSiteName({ prompt: "I attached an image. Generate a website using this as reference.", structuredSiteName: "NOMA Living" })).toBe("NOMA Living");
    expect(resolveGeneratedSiteName({ prompt: "Create a modern portfolio.", structuredSiteName: "Studio North" })).toBe("Studio North");
    expect(deriveSiteName("I attached an image. Generate a website using this as reference.")).toBe("Untitled site");
  });

  it("rejects generic, multiline, markup, and path-like structured names", () => {
    for (const value of ["Attached Reference", "Have Attached Image", "src/App.tsx", "one\ntwo", "<b>Name</b>"])
      expect(validateSiteNameCandidate(value)).toBeUndefined();
    expect(SITE_CODER_FILE_BUNDLE_JSON_SCHEMA).toMatchObject({ required: ["siteName", "files"] });
    expect(validateSiteCoderFileBundle({ siteName: "NOMA Living", files: [{ path: "src/App.tsx", content: "export function App(){return <main/>}" }] }).siteName).toBe("NOMA Living");
    expect(() => validateSiteCoderFileBundle({ files: "bad" })).toThrow(/files array/);
  });

  it("classifies reference and content images and supports multiple duplicate filenames", async () => {
    const content = { file: new File(["x"], "photo.png", { type: "image/png" }), usage: "CONTENT" as const };
    expect(attachmentUsageForPrompt(content, "Place this image in the gallery")).toBe("CONTENT");
    expect(attachmentUsageForPrompt(content, "Use this screenshot as reference")).toBe("REFERENCE");
    const store = new ArtifactMediaStore(new MemoryArtifacts());
    const first = await ingestUserImage(store, { originalName: "same.png", mimeType: "image/png", bytes: PLACEHOLDER_PNG });
    const second = await ingestUserImage(store, { originalName: "same.png", mimeType: "image/png", bytes: Uint8Array.from([...PLACEHOLDER_PNG, 0]) });
    expect(first.id).not.toBe(second.id);
    expect(userAssetsManifest([first, second]).assets).toHaveLength(2);
    await expect(ingestUserImage(store, { originalName: "bad.exe", mimeType: "application/octet-stream", bytes: PLACEHOLDER_PNG })).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_TYPE" });
  });

  it("blocks rapid duplicate generate and edit submissions at the job boundary", async () => {
    const jobs = new DevJobManager(new InMemoryProgressBus());
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = jobs.start("GENERATE", async () => { await pending; return { projectId: "site", versionId: "v1" }; });
    for (const operation of ["GENERATE", "EDIT"] as const) {
      let failure: unknown;
      try { jobs.start(operation, async () => ({ projectId: "duplicate", versionId: "v2" })); } catch (cause) { failure = cause; }
      expect(failure).toMatchObject({ code: "DEV_JOB_BUSY" });
    }
    finish();
    await vi.waitFor(() => expect(first.status).toBe("SUCCEEDED"));
  });

  it("fails malformed and truncated structured output deterministically", () => {
    const contract = { type: "JSON_SCHEMA" as const, name: "SiteCoderFileBundle", schema: SITE_CODER_FILE_BUNDLE_JSON_SCHEMA, strict: true };
    expect(() => parseStructuredResponse({ content: '{"files":', contract, capability: "FALLBACK_TEXT", validate: validateSiteCoderFileBundle, errorContext: "Site coder" })).toThrowError(expect.objectContaining({ code: "STRUCTURED_RESPONSE_PARSE_FAILED" }));
    const response: AgentResponse = { id: "truncated", model: "mock", message: { role: "assistant", content: '{"files":[' }, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, finishReason: "length" };
    expect(() => assertStructuredResponseComplete(response, "Site coder")).toThrowError(expect.objectContaining({ code: "MODEL_OUTPUT_TRUNCATED" }));
  });

  it("keeps provider, build-repair, and Browser QA failure categories user-safe", () => {
    const job = (code: string, status?: number) => ({ id: "job", status: "FAILED" as const, currentStage: "FAILED", error: { code, message: code, ...(status ? { status } : {}) } });
    expect(friendlyError(job("AGENT_FAILED", 429))).toMatch(/temporarily busy/i);
    expect(friendlyError(job("AGENT_FAILED", 503))).toMatch(/temporarily busy/i);
    expect(friendlyError(job("REPAIR_LIMIT_REACHED"))).toMatch(/couldn't be built/i);
    expect(friendlyError(job("BROWSER_QA_FAILED"))).toMatch(/browser check/i);
  });

  it("retains the mocked timeout, build, repair, QA, edit-preservation, and cancellation fixtures", async () => {
    const fixtures = await Promise.all([
      readFile("tests/openai-request-timeout.test.ts", "utf8"),
      readFile("tests/phase-3f-production-simplification.test.ts", "utf8"),
      readFile("tests/phase-3d-8-final-acceptance.test.ts", "utf8"),
      readFile("tests/sites-edit-persistence.test.ts", "utf8"),
      readFile("tests/phase-5.test.ts", "utf8"),
    ]);
    for (const marker of ["fails cleanly at the configured timeout", "invokes Build Repair at most once", "Browser QA failures", "failed edit leaves the working site exactly as it was", "honors cancellation before gateway work"])
      expect(fixtures.join("\n")).toContain(marker);
  });
});
