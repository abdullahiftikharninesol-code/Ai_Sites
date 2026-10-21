import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import type { SiteJob, SiteProject, SiteVersion } from "../src/sites/domain/entities.js";
import type { UserId, VersionId } from "../src/shared/types.js";
import type { SiteTemplate } from "../src/templates/domain/site-template.js";
import type { BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { TemplateInstantiationService } from "../src/templates/application/template-instantiation-service.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";
import type { UnnumberedSiteVersion } from "../src/persistence/version-committer.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";

const roots: string[] = [];

const passingTemplateQA: BrowserQAReport = {
  reportVersion: 1,
  runId: "template-instantiation-qa",
  status: "PASS",
  browser: { name: "chromium", version: "test" },
  viewports: [],
  routes: ["/", "/features", "/pricing", "/about", "/contact"],
  checks: [],
  artifactRefs: [],
  screenshots: [],
  summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
  startedAt: "2026-10-19T00:00:00.000Z",
  completedAt: "2026-10-19T00:00:01.000Z",
  durationMs: 1_000,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sourceOf(
  product: ReturnType<typeof createLocalSitesProduct>,
  versionId: VersionId,
) {
  const version = await product.versions.getById(versionId);
  const bytes = version ? await product.artifacts.get(version.sourceArtifactRef) : undefined;
  if (!bytes) throw new Error("Version source is unavailable");
  return (JSON.parse(Buffer.from(bytes).toString("utf8")) as { files: Record<string, string> }).files;
}

describe("Phase 7 template customization compatibility", () => {
  it("edits an instantiated template through the normal targeted-edit/version pipeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "sites-template-phase7-"));
    roots.push(root);
    let editCalls = 0;
    const mock = new MockAgentProvider({
      customResponse: async (request) => {
        editCalls += 1;
        const fails = request.messages.some((message) => message.content.includes("impossible missing text"));
        const requirementRepair = request.messages.some((message) => message.content.includes("attempt 2 of 2"));
        return {
          id: `targeted-edit-${editCalls}`,
          model: request.model,
          message: {
            role: "assistant",
            content: JSON.stringify({
              patches: requirementRepair
                ? [
                    { path: "index.html", find: "FlowPilot", replace: "NovaPay", mode: "all" },
                    { path: "src/pages/AboutPage.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
                    { path: "src/pages/HomePage.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
                    { path: "src/components/ProductPreview.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
                    { path: "src/components/ProductPreview.jsx", find: "flowpilot", replace: "novapay", mode: "all" },
                    { path: "src/components/SiteLayout.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
                  ]
                : fails
                ? [{ path: "src/components/Brand.jsx", find: "missing brand text", replace: "x", mode: "unique" }]
                : [
                    { path: "src/components/Brand.jsx", find: "FlowPilot", replace: "NovaPay", mode: "all" },
                    {
                      path: "src/pages/HomePage.jsx",
                      find: "FlowPilot gives modern teams one clear place to plan, coordinate, and improve the work that matters.",
                      replace: "NovaPay gives finance teams an AI-powered platform for clearer, faster decisions.",
                      mode: "unique",
                    },
                    {
                      path: "src/styles/global.css",
                      find: "--blue: #2563eb;\n  --blue-dark: #1d4ed8;\n  --blue-soft: #eaf1ff;",
                      replace: "--blue: #166534;\n  --blue-dark: #14532d;\n  --blue-soft: #ecfdf5;",
                      mode: "unique",
                    },
                  ],
            }),
          },
          toolCalls: [],
          usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 80, totalTokens: 200 },
          latencyMs: 1,
          finishReason: "stop" as const,
        };
      },
    });
    const provider = {
      id: "offline-template-fixture",
      getCapabilities: () => mock.getCapabilities(),
      createResponse: mock.createResponse.bind(mock),
    };
    const registry = new AgentProviderRegistry();
    registry.register(provider);
    const preflight = vi.fn(async () => ({
      userId: "phase-7-owner",
      provider: provider.id,
      modelRate: { model: "mock-sites-v1", platform: provider.id, type: "ai_chat", creditsPer500Tokens: 1 },
    }));
    const finalizeSuccessfulJob = vi.fn(async (job: SiteJob) => ({
      ...job,
      billingStatus: "CHARGED" as const,
      creditsCharged: 1,
    }));
    const product = createLocalSitesProduct({
      executionRoot: join(root, "execution"),
      artifactRoot: join(root, "artifacts"),
      agentRegistry: registry,
      orchestrationAgent: provider,
      keepWorkspace: false,
      billing: { preflight, finalizeSuccessfulJob } as unknown as SiteCreditBillingService,
    });
    const editBrowserQA = vi.spyOn(product.browserQA, "run").mockResolvedValue(passingTemplateQA);

    const source = await validateTemplateSource(resolve("templates/modern-saas"));
    const archive = await packageTemplateSource(source);
    const now = new Date("2026-10-19T00:00:00.000Z");
    const template: SiteTemplate = {
      id: "modern-saas-v1",
      templateKey: "modern-saas",
      version: 1,
      name: "Modern SaaS",
      description: "Modern SaaS template",
      categoryId: "saas",
      tags: ["saas"],
      status: "active",
      routes: [
        { path: "/", label: "Home" },
        { path: "/features", label: "Features" },
        { path: "/pricing", label: "Pricing" },
        { path: "/about", label: "About" },
        { path: "/contact", label: "Contact" },
      ],
      sourceObject: "sites/templates/modern-saas/v1/source/template.zip",
      sourceSha256: createHash("sha256").update(archive.bytes).digest("hex"),
      previews: { desktop: "desktop.webp", tablet: "tablet.webp", mobile: "mobile.webp" },
      createdAt: now,
      updatedAt: now,
    };
    const templates = {
      findTemplateVersion: vi.fn(async () => template),
      findLatestActiveTemplate: vi.fn(async () => template),
      listActiveTemplates: vi.fn(),
      findById: vi.fn(),
    };
    const templateSource = { readObject: vi.fn(async () => archive.bytes) };
    const commit = async (project: SiteProject, draft: UnnumberedSiteVersion) => {
      const current = await product.versions.listBySite(project.id);
      const version: SiteVersion = { ...draft, versionNumber: current.items.length + 1 };
      await product.versions.save(version);
      await product.projects.save({
        ...project,
        latestVersionId: version.id,
        status: "ACTIVE",
        updatedAt: new Date(),
      });
      return version;
    };
    const instantiation = new TemplateInstantiationService({
      templates,
      source: templateSource,
      execution: product.execution,
      artifacts: product.artifacts,
      projects: product.projects,
      versions: { commit },
      browserQA: { run: vi.fn(async () => passingTemplateQA) } as never,
      cleanupSite: async () => undefined,
    });

    const ownerId = "phase-7-owner" as UserId;
    const created = await instantiation.instantiate({
      ownerId,
      templateKey: template.templateKey,
      version: template.version,
      projectName: "NovaPay Site",
    });
    const originalSource = await sourceOf(product, created.versionId);
    await product.execution.destroyEnvironment(created.environmentId);
    templates.findTemplateVersion.mockClear();
    templates.findLatestActiveTemplate.mockClear();
    templateSource.readObject.mockClear();

    const edited = await product.orchestrator.editWebsite({
      userId: ownerId,
      siteId: created.projectId,
      versionId: created.versionId,
      instruction: "Rename FlowPilot to NovaPay, use deep green, and rewrite the hero for AI finance while preserving the layout.",
      agentProvider: provider.id,
      browserQAEnabled: true,
    });

    expect(editCalls).toBe(2);
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(finalizeSuccessfulJob).toHaveBeenCalledOnce();
    expect(edited.inference?.stages.TARGETED_EDIT.logicalRequests).toBe(2);
    expect(edited.inference?.stages.SITE_PLANNING.logicalRequests).toBe(0);
    expect(edited.inference?.stages.GENERATE_SITE.logicalRequests).toBe(0);
    expect(edited.inference?.stages.BUILD_REPAIR.logicalRequests).toBe(0);
    expect(edited.browserQA?.status).not.toBe("FAIL");
    expect(editBrowserQA).toHaveBeenCalledOnce();
    expect(templates.findTemplateVersion).not.toHaveBeenCalled();
    expect(templates.findLatestActiveTemplate).not.toHaveBeenCalled();
    expect(templateSource.readObject).not.toHaveBeenCalled();

    const project = await product.projects.getById(created.projectId);
    const versions = await product.versions.listBySite(created.projectId);
    expect(project).toMatchObject({ ownerId, latestVersionId: edited.newVersionId });
    expect(versions.items).toHaveLength(2);
    expect(versions.items[0]).toMatchObject({ id: created.versionId, versionNumber: 1 });
    expect(versions.items[1]).toMatchObject({
      id: edited.newVersionId,
      parentVersionId: created.versionId,
      versionNumber: 2,
    });
    const editedSource = await sourceOf(product, edited.newVersionId);
    expect(editedSource["src/components/Brand.jsx"]).toContain("NovaPay");
    expect(editedSource["src/components/ProductPreview.jsx"]).not.toMatch(/flowpilot/i);
    expect(editedSource["src/pages/HomePage.jsx"]).toContain("AI-powered platform");
    expect(editedSource["src/styles/global.css"]).toContain("--blue: #166534");
    expect(editedSource["src/pages/ContactPage.jsx"]).toBe(originalSource["src/pages/ContactPage.jsx"]);
    expect(await sourceOf(product, created.versionId)).toEqual(originalSource);

    const restored = await product.pipeline.restoreVersion(created.versionId);
    expect(await product.execution.readFile(restored.environmentId, "src/components/Brand.jsx")).toContain("FlowPilot");
    await product.pipeline.disposeRestoredEnvironment(restored.environmentId);

    await expect(product.orchestrator.editWebsite({
      userId: ownerId,
      siteId: created.projectId,
      instruction: "Replace impossible missing text",
      agentProvider: provider.id,
      browserQAEnabled: false,
    })).rejects.toThrow();
    expect((await product.projects.getById(created.projectId))?.latestVersionId).toBe(edited.newVersionId);
    expect((await product.versions.listBySite(created.projectId)).items).toHaveLength(2);
  }, 300_000);
});
