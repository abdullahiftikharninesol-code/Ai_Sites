import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../src/app/errors/application-error.js";
import {
  markTemplateInstantiationStage,
  reportTemplateAuthenticationFailure,
  reportTemplatePreviewFailure,
  withTemplateInstantiationDiagnostics,
  type TemplateInstantiationStage,
} from "../src/templates/application/template-instantiation-diagnostics.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("sanitized template-first diagnostics (offline only)", () => {
  it("returns the unchanged success result without logging or persisting anything", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = { projectId: "fixture-project", versionId: "fixture-project:v1" };
    await expect(withTemplateInstantiationDiagnostics("corporate-business", () => Promise.resolve(result))).resolves.toBe(result);
    expect(logger).not.toHaveBeenCalled();
  });

  it.each<TemplateInstantiationStage>([
    "TEMPLATE_RESOLUTION", "GCS_DOWNLOAD", "SHA_VALIDATION", "EXTRACTION", "SOURCE_VALIDATION",
    "BUILD", "BROWSER_QA", "PERSISTENCE", "PREVIEW_INITIALIZATION",
  ])("records the precise %s stage while preserving the original failure", async (stage) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = new ApplicationError("TEMPLATE_INSTANTIATION_QA_FAILED", "Template Browser QA failed");
    await expect(withTemplateInstantiationDiagnostics("corporate-business", () => {
      markTemplateInstantiationStage(stage, { command: "offline fixture" });
      return Promise.reject(original);
    })).rejects.toBe(original);
    expect(logger).toHaveBeenCalledOnce();
    expect(String(logger.mock.calls[0]?.[1])).toContain(`"stage":"${stage}"`);
    expect(String(logger.mock.calls[0]?.[1])).toContain('"code":"TEMPLATE_INSTANTIATION_QA_FAILED"');
  });

  it("redacts credentials/JWTs and does not serialize private source, headers or arbitrary fields", async () => {
    vi.stubEnv("TEMPLATE_TEST_API_KEY", "fake-secret-not-a-live-credential");
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = Object.assign(new Error("Driver failed: fake-secret-not-a-live-credential Bearer secret-token mongodb://user:pass@localhost/db"), {
      source: "PRIVATE_SOURCE_MUST_NOT_BE_LOGGED", headers: { authorization: "PRIVATE_HEADER_MUST_NOT_BE_LOGGED" },
    });
    const wrapped = new ApplicationError("PERSISTENCE_WRITE_FAILED", "Unable to save current project", { cause: root });
    await expect(withTemplateInstantiationDiagnostics("corporate-business", () => {
      markTemplateInstantiationStage("PERSISTENCE");
      return Promise.reject(wrapped);
    })).rejects.toBe(wrapped);
    const output = String(logger.mock.calls[0]?.[1]);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("PERSISTENCE_WRITE_FAILED");
    for (const forbidden of ["fake-secret-not-a-live-credential", "secret-token", "user:pass", "PRIVATE_SOURCE_MUST_NOT_BE_LOGGED", "PRIVATE_HEADER_MUST_NOT_BE_LOGGED"])
      expect(output).not.toContain(forbidden);
    expect(output).toContain("frames");
  });

  it("isolates concurrent operations and never substitutes a logging failure for the original error", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await Promise.allSettled(["corporate-business", "restaurant"].map((key) =>
      withTemplateInstantiationDiagnostics(key, async () => {
        markTemplateInstantiationStage(key === "restaurant" ? "PERSISTENCE" : "BROWSER_QA");
        await Promise.resolve(); throw new Error("offline fixture");
      }),
    ));
    expect(logger).toHaveBeenCalledTimes(2);
    const messages = logger.mock.calls.map((call) => String(call[1]));
    expect(messages.some((line) => line.includes('"templateKey":"restaurant"') && line.includes('"stage":"PERSISTENCE"'))).toBe(true);
    expect(messages.some((line) => line.includes('"templateKey":"corporate-business"') && line.includes('"stage":"BROWSER_QA"'))).toBe(true);
    logger.mockImplementation(() => { throw new Error("logger unavailable"); });
    const original = new Error("original failure");
    await expect(withTemplateInstantiationDiagnostics("corporate-business", () => Promise.reject(original))).rejects.toBe(original);
  });

  it("records AUTH and final preview-adoption failures without authentication data", () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportTemplateAuthenticationFailure(401);
    reportTemplatePreviewFailure("corporate-business", new Error("Preview adoption failed"));
    expect(String(logger.mock.calls[0]?.[1])).toBe('{"stage":"AUTH","status":401}');
    expect(String(logger.mock.calls[1]?.[1])).toContain('"stage":"PREVIEW_INITIALIZATION"');
  });
});
