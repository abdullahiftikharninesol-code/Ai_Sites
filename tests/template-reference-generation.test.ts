import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest } from "../src/agents/agent-types.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { CatalogTemplateDesignReferenceResolver, deriveTemplateDesignReference, MAX_TEMPLATE_DESIGN_CONTEXT_BYTES, parseTemplateReference, templateDesignPrompt } from "../src/templates/application/template-design-context.js";
import { templateReferenceSiteSpec, validateTemplateReferenceBundle } from "../src/templates/application/template-reference-generation-contract.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";
import { loadTemplateManifest } from "../src/templates/publishing/template-manifest.js";
import type { SiteTemplate } from "../src/templates/domain/site-template.js";
import type { SiteSpec } from "../src/sites/domain/site-spec.js";
import type { SiteId, UserId } from "../src/shared/types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { AgentPlanningPipeline } from "../src/agents/intelligence/agent-intelligence.js";
import { PlaygroundService, loadPlaygroundConfig } from "../src/dev-server/playground-service.js";
import { MongoConnectionManager } from "../src/persistence/mongodb/mongo-connection.js";
import type { SiteGenerationResult } from "../src/sites/generation/local-site-generation-pipeline.js";
import type { SiteJob } from "../src/sites/domain/entities.js";
import { estimateTokensConservative } from "../src/agents/budget/token-estimator.js";

const prompt = "Build a premium online store for North & Loom, a modern clothing brand. Create a home page with hero promotion, categories, featured products, product cards, sale badges, newsletter signup and footer. Also create a product-detail experience with gallery placeholders, sizes, quantity controls and Add to Cart interactions. Use frontend mock data only.";
const selection = { templateKey: "ecommerce-store", version: 1 };
const owner = "offline-owner" as UserId;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp() { const root = await mkdtemp(join(tmpdir(), "sites-reference-offline-")); roots.push(root); return root; }
async function referenceFixture() {
  const directory = resolve("templates/ecommerce-store");
  const manifest = await loadTemplateManifest(directory);
  const archive = await packageTemplateSource(await validateTemplateSource(directory));
  const record: SiteTemplate = { ...manifest, id: "reference-v1", categoryId: "category-commerce", status: "active",
    sourceObject: "sites/templates/ecommerce-store/v1/source/template.zip", sourceSha256: archive.sha256,
    previews: {}, createdAt: new Date(0), updatedAt: new Date(0) };
  const templates = { findTemplateVersion: vi.fn(async () => record) };
  const storage = { readObject: vi.fn(async () => archive.bytes as Uint8Array | undefined) };
  const resolver = new CatalogTemplateDesignReferenceResolver(templates, storage);
  return { resolver, record, templates, storage, archive };
}

const application = `import { useState } from "react";
export function App() {
  const [quantity, setQuantity] = useState(1);
  const [size, setSize] = useState("M");
  const [cart, setCart] = useState(0);
  const [subscribed, setSubscribed] = useState(false);
  const product = location.pathname === "/product";
  return <div className="reference-store">
    <header><a className="wordmark" href="/">North &amp; Loom</a><nav aria-label="Main"><a href="/">Home</a><a href="/product">Product detail</a></nav><span role="status" aria-label="Cart count">Cart: {cart}</span></header>
    <main>{product ? <section className="product-page"><div className="gallery"><div role="img" aria-label="Linen shirt front placeholder"/><div role="img" aria-label="Linen shirt back placeholder"/></div><div><h1>North &amp; Loom Linen Shirt</h1><p>Breathable layers for the modern wardrobe.</p><label>Size<select aria-label="Size" value={size} onChange={e => setSize(e.target.value)}><option>S</option><option>M</option><option>L</option></select></label><label>Quantity<input aria-label="Quantity" type="number" min="1" value={quantity} onChange={e => setQuantity(Math.max(1, Number(e.target.value)))}/></label><button onClick={() => setCart(cart + quantity)}>Add to Cart</button></div></section>
    : <><section className="store-hero"><div><p>North &amp; Loom new collection</p><h1>Clothing for a considered life.</h1><p>Premium natural layers for every day.</p><a href="/product">Shop the collection</a></div><div className="hero-art" role="img" aria-label="Clothing promotion placeholder"/></section><section><h2>Shop by category</h2><p>Shirts · Knitwear · Outerwear</p></section><section><h2>Featured products</h2><div className="product-grid"><article className="product-card"><div role="img" aria-label="Linen shirt placeholder"/><h3>North &amp; Loom Linen Shirt</h3><span>Sale — 20% off</span><a href="/product">View product</a></article><article className="product-card"><h3>Everyday Knit</h3><p>Soft, considered essentials.</p><a href="/product">View knitwear</a></article></div></section></>}</main>
    <footer><h2>North &amp; Loom newsletter</h2><form onSubmit={e => { e.preventDefault(); setSubscribed(true); }}><label>Email<input type="email" name="email" required aria-label="Email address"/></label><button type="submit">Subscribe</button>{subscribed && <p role="status">Subscribed to North &amp; Loom</p>}</form><p>North &amp; Loom · Frontend mock store</p></footer>
  </div>;
}`;
const stylesheet = `:root{--cream:#f6f0e5;--green:#25372d;--clay:#a9523c;--ink:var(--green);--surface:var(--cream);--accent:var(--clay)}
*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--green);font-family:Arial,sans-serif}header{display:flex;gap:28px;align-items:center;justify-content:space-between;padding:24px 5vw;border-bottom:1px solid var(--green)}a{color:inherit}nav{display:flex;gap:20px}.wordmark{font:28px Georgia,serif}main>section,main>div>section{padding:50px 5vw}h1,h2,h3{font-family:Georgia,serif;font-weight:400}h1{font-size:clamp(35px,5vw,68px)}.store-hero{display:grid;grid-template-columns:1.1fr .9fr;min-height:440px;align-items:center;gap:32px}.hero-art,.gallery>div,.product-card>[role=img]{background:#e1d7c6;min-height:180px}.product-grid,.product-page,.gallery{display:grid;grid-template-columns:1fr 1fr;gap:20px}.product-card{border-top:1px solid var(--green);padding:20px}footer{padding:40px 5vw;background:var(--green);color:var(--cream)}button,input,select{font:inherit;padding:10px;max-width:100%}label{display:block;margin:12px 0}@media(max-width:760px){header{flex-wrap:wrap}.store-hero,.product-page{grid-template-columns:1fr}.product-grid{grid-template-columns:1fr}h1{font-size:38px}}`;
const bundle = { siteName: "North & Loom", files: [{ path: "src/App.tsx", content: application }, { path: "src/styles.css", content: stylesheet }] };

describe("Trusted compact template design context", () => {
  it("resolves exact active v1 through the catalog, verifies ZIP SHA and extracts design without sending its source/products", async () => {
    const h = await referenceFixture(); const reference = await h.resolver.resolve(selection);
    expect(h.templates.findTemplateVersion).toHaveBeenCalledExactlyOnceWith("ecommerce-store", 1);
    expect(h.storage.readObject).toHaveBeenCalledExactlyOnceWith(h.record.sourceObject);
    expect(reference.design.tokens.join(";")).toContain("--cream");
    expect(reference.design.typography.join(";")).toContain("Georgia");
    expect(reference.design.layoutPatterns.join(";")).toContain(".store-hero");
    expect(reference.originalBrands.map((name) => name.toLowerCase())).toContain("atelier row");
    expect(reference.originalProductNames).toContain("Contour Carafe");
    const context = templateDesignPrompt(reference.design);
    expect(context).toContain("user's requested structure takes priority");
    expect(context).not.toContain("Contour Carafe"); expect(context).not.toContain("function Home");
    expect(context).not.toContain("sourceObject"); expect(context).not.toContain("package-lock.json");
    expect(Buffer.byteLength(JSON.stringify(reference.design))).toBeLessThanOrEqual(MAX_TEMPLATE_DESIGN_CONTEXT_BYTES);
    expect(estimateTokensConservative(context)).toBeLessThan(4_000);
  });
  it("rejects archived/unknown references before storage and SHA mismatch before analysis", async () => {
    const h = await referenceFixture(); h.templates.findTemplateVersion.mockResolvedValueOnce({ ...h.record, status: "archived" });
    await expect(h.resolver.resolve(selection)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" }); expect(h.storage.readObject).not.toHaveBeenCalled();
    h.storage.readObject.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    await expect(h.resolver.resolve(selection)).rejects.toMatchObject({ code: "TEMPLATE_SOURCE_INTEGRITY_FAILED" });
  });
  it.each([{ templateKey: "../source", version: 1 }, { ...selection, sourceObject: "evil.zip" }, { ...selection, version: 0 }, { ...selection, source: "private source" }])("rejects untrusted reference payload %j", (value) => {
    expect(() => parseTemplateReference(value)).toThrow();
  });
  it("deterministically bounds large/multibyte design input and removes URL/secret tokens", () => {
    const css = Array.from({ length: 1000 }, (_, i) => `.card-${i}{padding:${i}px;background:#eeeeee;display:grid;gap:20px}`).join("");
    const files = { "src/styles.css": `:root{--secret-key:do-not-forward;--image:url(https://private.invalid)}${css}` };
    const a = deriveTemplateDesignReference(selection, "hash", files, ["/"]); const b = deriveTemplateDesignReference(selection, "hash", files, ["/"]);
    expect(a).toEqual(b); expect(Buffer.byteLength(JSON.stringify(a.design))).toBeLessThanOrEqual(MAX_TEMPLATE_DESIGN_CONTEXT_BYTES);
    expect(templateDesignPrompt(a.design)).not.toContain("do-not-forward"); expect(templateDesignPrompt(a.design)).not.toContain("private.invalid");
  });
  it("rejects unchanged application, old branding, old products and inert controls without another AI call", async () => {
    const h = await referenceFixture(); const reference = await h.resolver.resolve(selection);
    expect(() => validateTemplateReferenceBundle(bundle, reference, prompt)).not.toThrow();
    const original = await readFile("templates/ecommerce-store/src/App.jsx", "utf8");
    expect(() => validateTemplateReferenceBundle({ files: [{ path: "src/App.tsx", content: original }] }, reference, prompt)).toThrow();
    for (const bad of [application.replaceAll("North &amp; Loom", "Atelier Row"), application.replace("Everyday Knit", "Contour Carafe"), application.replace("onClick={() => setCart(cart + quantity)}", "onClick={() => {}}")])
      expect(() => validateTemplateReferenceBundle({ files: [{ path: "src/App.tsx", content: bad }] }, reference, prompt)).toThrow();
  });
});

describe("Reference-guided generation through the real Site Coder/build/Browser QA pipeline", () => {
  it("supplies reference context only to an existing planner invocation and isolates planning cache identities", async () => {
    const h = await referenceFixture(); const reference = await h.resolver.resolve(selection);
    const provider = new MockAgentProvider(); const request = vi.spyOn(provider, "createResponse");
    const planner = new AgentPlanningPipeline(provider, { mode: "AGENT" });
    const brief = "Build a staff portal named Reference Planning Fixture with Home and About pages.";
    await planner.planSite(brief, undefined, undefined, templateDesignPrompt(reference.design));
    expect(provider.callCount).toBe(1);
    expect(request.mock.calls[0]?.[0].messages[0]?.content).toContain("TemplateDesignContext");
    expect(request.mock.calls[0]?.[0].messages[0]?.content).toContain(brief);
    await planner.planSite(brief, undefined, undefined, templateDesignPrompt(reference.design));
    expect(provider.callCount).toBe(1);
    await planner.planSite(brief, undefined, undefined, templateDesignPrompt({ ...reference.design, version: 2 }));
    expect(provider.callCount).toBe(2);
  });
  it("generates North & Loom, validates real mock interactions, commits once and reloads its current source with one coder call", async () => {
    vi.stubEnv("npm_config_offline", "true");
    const root = await temp(); const h = await referenceFixture(); const requests: AgentRequest[] = [];
    const provider = new MockAgentProvider({ customResponse: (request) => {
      requests.push(request);
      return { id: "offline-coder", model: request.model, message: { role: "assistant", content: JSON.stringify(bundle) },
        toolCalls: [], usage: { inputTokens: 100, outputTokens: 100 }, latencyMs: 0, finishReason: "stop" };
    } });
    // Still the deterministic mock provider; alias exercises existing billing paths.
    Object.defineProperty(provider, "id", { value: "offline-reference-fixture" });
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn(async (job: SiteJob) => job) };
    const api = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"),
      agentRegistry: registry, orchestrationAgent: provider, templateDesignReferences: h.resolver, billing: billing as unknown as SiteCreditBillingService });
    const planner = vi.spyOn(AgentPlanningPipeline.prototype, "planSite");
    const result = await api.pipeline.generate({ userId: owner, prompt, templateReference: selection,
      planningMode: "agent-with-fallback", agentProvider: provider.id, browserQAEnabled: true, retainPreview: true });
    try {
      expect(provider.callCount).toBe(1); expect(planner).not.toHaveBeenCalled();
      expect(requests[0]?.responseContract).toMatchObject({ name: "SiteCoderFileBundle" });
      const sent = requests[0]!.messages.map(({ content }) => content).join("\n");
      expect(sent).toContain("TemplateDesignContext"); expect(sent).toContain("ecommerce-store"); expect(sent).toContain("--cream");
      expect(sent).toContain(prompt); expect(sent).not.toContain("Contour Carafe"); expect(sent).not.toContain("function ProductVisual");
      expect(result.inference?.logicalRequests).toBe(1); expect(result.inference?.physicalRequests).toBe(1);
      expect(result.build.success).toBe(true); expect(result.browserQA?.status).not.toBe("FAIL");
      expect(result.siteSpec.requirements.pages.map(({ path }) => path)).toEqual(["/", "/product"]);
      expect(result.browserQA?.checks.filter(({ checkId }) => checkId === "template-reference.requirements")).toHaveLength(6);
      expect(result.browserQA?.checks.filter(({ status, severity }) => status === "FAIL" && severity === "ERROR")).toEqual([]);
      expect((await api.projects.listByOwner(owner)).items).toHaveLength(1);
      expect((await api.versions.listBySite(result.siteId)).items).toHaveLength(1);
      const current = (await api.versions.getById((await api.projects.getById(result.siteId))!.latestVersionId!))!;
      expect(current).toMatchObject({ templateId: "ecommerce-store", templateVersion: 1 });
      const snapshot = JSON.parse(Buffer.from((await api.artifacts.get(current.sourceArtifactRef))!).toString()) as { files: Record<string, string> };
      expect(snapshot.files["src/App.tsx"]).toContain("North &amp; Loom"); expect(snapshot.files["src/App.tsx"]).not.toContain("Atelier Row");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage(); await page.goto(`${result.preview.url}/product`, { waitUntil: "networkidle" });
        await page.getByLabel("Size", { exact: true }).selectOption("L"); await page.getByLabel("Quantity", { exact: true }).fill("3");
        await page.getByRole("button", { name: "Add to Cart" }).click();
        expect(await page.getByRole("status", { name: "Cart count" }).innerText()).toBe("Cart: 3");
        expect(await page.getByLabel("Size", { exact: true }).inputValue()).toBe("L");
        const computed = await page.locator(".wordmark").evaluate((node) => getComputedStyle(node).fontFamily);
        expect(computed).toContain("Georgia");
        expect(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(246, 240, 229)");
      } finally { await browser.close(); }
      expect(billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    } finally { await api.execution.destroyEnvironment(result.preview.environmentId); }
  }, 120_000);

  it("uses only user-requested new pages, never forces reference routes", () => {
    const spec = { project: { name: "Demo" }, requirements: { siteType: "business", pages: [{ name: "Home", path: "/" }], features: [] }, design: {}, technical: { framework: "React", language: "TypeScript", styling: "CSS" } } satisfies SiteSpec;
    const enriched = templateReferenceSiteSpec(spec, "Build a Careers page and a product-detail experience");
    expect(enriched.requirements.pages.map(({ path }) => path)).toEqual(["/", "/product", "/careers"]);
    expect(enriched.requirements.pages.map(({ path }) => path)).not.toContain("/shop");
  });

  it("does not persist a baseline or finalize billing when identity completion is rejected", async () => {
    vi.stubEnv("npm_config_offline", "true");
    const root = await temp(); const h = await referenceFixture();
    const provider = new MockAgentProvider({ customResponse: (request) => ({ id: "bad", model: request.model,
      message: { role: "assistant", content: JSON.stringify({ ...bundle, files: [{ path: "src/App.tsx", content: application.replaceAll("North &amp; Loom", "Atelier Row") }] }) },
      toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, finishReason: "stop" }) });
    Object.defineProperty(provider, "id", { value: "offline-reference-fixture" });
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn() };
    const api = createLocalSitesProduct({ executionRoot: join(root, "execution"), artifactRoot: join(root, "artifacts"), agentRegistry: registry,
      orchestrationAgent: provider, templateDesignReferences: h.resolver, billing: billing as unknown as SiteCreditBillingService });
    const siteId = "retry-candidate" as SiteId;
    for (let retry = 0; retry < 2; retry++)
      await expect(api.pipeline.generate({ userId: owner, prompt, templateReference: selection, referenceGenerationSiteId: siteId,
        planningMode: "deterministic", agentProvider: provider.id, browserQAEnabled: true })).rejects.toMatchObject({ code: "GENERATION_INCOMPLETE" });
    expect(provider.callCount).toBe(2); expect((await api.projects.listByOwner(owner)).items).toHaveLength(0);
    expect((await api.versions.listBySite(siteId)).items).toHaveLength(0); expect(billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
  }, 120_000);
});

describe("Reference generation owner-scoped request recovery", () => {
  it("reuses the same job on duplicate submission and never bills/generates twice for preview-delivery recovery", async () => {
    const root = await temp();
    const service = new PlaygroundService({ ...loadPlaygroundConfig({}), dataRoot: root, agentProvider: "mock" }, new MongoConnectionManager());
    const generate = vi.spyOn(service.product.orchestrator, "generateWebsite").mockResolvedValue({ siteId: "owned-generated", jobId: "internal-job", versionId: "current-1",
      preview: { environmentId: "environment", url: "http://127.0.0.1:9999", port: 9999 } } as unknown as SiteGenerationResult);
    const adopt = vi.spyOn(service.previews, "adopt").mockRejectedValueOnce(new Error("Preview adoption interrupted")).mockResolvedValue({ id: "preview", url: "http://127.0.0.1:9999" } as never);
    vi.spyOn(service.product.jobs, "getById").mockResolvedValue(undefined);
    vi.spyOn(service.product, "readCanonicalQuota").mockResolvedValue(undefined);
    const requestId = "offline-reference-request-1";
    const first = service.generate(owner, prompt, undefined, [], selection, requestId);
    expect(service.generate(owner, prompt, undefined, [], selection, requestId).id).toBe(first.id);
    await vi.waitFor(() => expect(first.status).toBe("FAILED"));
    const retry = service.generate(owner, prompt, undefined, [], selection, requestId);
    await vi.waitFor(() => expect(retry.status).toBe("SUCCEEDED"));
    expect(generate).toHaveBeenCalledOnce(); expect(adopt).toHaveBeenCalledTimes(2);
    expect(service.generate(owner, prompt, undefined, [], selection, requestId).id).toBe(retry.id);
    expect(() => service.generate(owner, "different brief", undefined, [], selection, requestId)).toThrow();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ templateReference: selection, prompt });
  });
});
