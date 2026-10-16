import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApplicationError } from "../src/app/errors/application-error.js";
import { BROWSER_QA_VIEWPORTS, type BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import {
  toPublicSiteTemplate,
  type SiteCategory,
  type SiteTemplate,
} from "../src/templates/domain/site-template.js";
import type { TemplatePublicationRepository } from "../src/templates/repositories.js";
import type {
  TemplateArtifactStorage,
  TemplateArtifactWrite,
} from "../src/templates/publishing/template-artifact-storage.js";
import type { TemplateBuildRunner } from "../src/templates/publishing/template-build.js";
import {
  PlaywrightTemplateBrowserQA,
  type TemplateBrowserQA,
  type TemplateBrowserQAInput,
  type TemplateBrowserQAResult,
} from "../src/templates/publishing/template-browser-qa.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { StaticTemplatePreviewServer } from "../src/templates/publishing/template-preview-server.js";
import {
  TemplatePublisher,
  type TemplateCacheInvalidator,
  type TemplateCategoryLookup,
} from "../src/templates/publishing/template-publisher.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";

const fixture = resolve("tests/fixtures/template-publisher-valid");
const roots: string[] = [];

async function temporaryRoot(prefix = "sites-template-t2b-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function builtSite(html: string): Promise<{ root: string; previews: string }> {
  const root = await temporaryRoot();
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), html);
  return { root, previews: join(root, "generated-previews") };
}

const validHtml = `<!doctype html><html><head><style>body{margin:0}main{min-height:100vh;padding:24px;box-sizing:border-box}</style></head><body><div id="root"><main><h1>Responsive template</h1><p>Useful visible content.</p></main></div></body></html>`;

describe("T2B loopback preview server", () => {
  it("starts and serves the built index", async () => {
    const site = await builtSite(validHtml);
    const server = new StaticTemplatePreviewServer();
    const session = await server.start(join(site.root, "dist"));
    try {
      expect(await (await fetch(session.baseUrl)).text()).toContain("Responsive template");
    } finally {
      await session.close();
    }
  });

  it("binds only to the IPv4 loopback host", async () => {
    const site = await builtSite(validHtml);
    const session = await new StaticTemplatePreviewServer().start(join(site.root, "dist"));
    expect(session.host).toBe("127.0.0.1");
    expect(new URL(session.baseUrl).hostname).toBe("127.0.0.1");
    await session.close();
  });

  it("uses a dynamically assigned nonzero port", async () => {
    const site = await builtSite(validHtml);
    const session = await new StaticTemplatePreviewServer().start(join(site.root, "dist"));
    expect(session.port).toBeGreaterThan(0);
    await session.close();
  });

  it("provides SPA history fallback for direct routes", async () => {
    const site = await builtSite(validHtml);
    const session = await new StaticTemplatePreviewServer().start(join(site.root, "dist"));
    try {
      const response = await fetch(`${session.baseUrl}/pricing`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Responsive template");
    } finally {
      await session.close();
    }
  });

  it("does not turn missing asset paths into SPA HTML", async () => {
    const site = await builtSite(validHtml);
    const session = await new StaticTemplatePreviewServer().start(join(site.root, "dist"));
    try {
      expect((await fetch(`${session.baseUrl}/missing.js`)).status).toBe(404);
    } finally {
      await session.close();
    }
  });

  it("terminates and tracks no active server after close", async () => {
    const site = await builtSite(validHtml);
    const server = new StaticTemplatePreviewServer();
    const session = await server.start(join(site.root, "dist"));
    await session.close();
    expect(session.closed).toBe(true);
    expect(server.activeSessionCount).toBe(0);
  });

  it("fails deterministically when production output is absent", async () => {
    const root = await temporaryRoot();
    await expect(new StaticTemplatePreviewServer().start(root)).rejects.toMatchObject({
      code: "TEMPLATE_PREVIEW_SERVER_FAILED",
    });
  });
});

describe("T2B real Browser QA and WebP capture", () => {
  let site: Awaited<ReturnType<typeof builtSite>>;
  let qa: PlaywrightTemplateBrowserQA;
  let result: TemplateBrowserQAResult;
  let browserRoot: string;

  beforeAll(async () => {
    browserRoot = await mkdtemp(join(tmpdir(), "sites-template-t2b-browser-"));
    await mkdir(join(browserRoot, "dist"), { recursive: true });
    await writeFile(join(browserRoot, "dist", "index.html"), validHtml);
    site = { root: browserRoot, previews: join(browserRoot, "generated-previews") };
    qa = new PlaywrightTemplateBrowserQA();
    result = await qa.run({
      buildDirectory: site.root,
      routes: ["/", "/pricing", "/about"],
      previewDirectory: site.previews,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(browserRoot, { recursive: true, force: true });
  });

  it("passes home route QA", () => {
    expect(result.passed).toBe(true);
    expect(result.report.routes).toContain("/");
  });

  it("checks every declared route", () => {
    expect(result.routesChecked).toBe(3);
    expect(result.report.routes).toEqual(["/", "/about", "/pricing"]);
  });

  it("uses the canonical desktop, tablet, and mobile viewports", () => {
    expect(result.report.viewports).toEqual(
      [...BROWSER_QA_VIEWPORTS].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(result.viewportsChecked).toBe(3);
  });

  it("generates desktop.webp", async () => {
    await expect(access(result.previews.desktop.path)).resolves.toBeUndefined();
  });

  it("generates tablet.webp", async () => {
    await expect(access(result.previews.tablet.path)).resolves.toBeUndefined();
  });

  it("generates mobile.webp", async () => {
    await expect(access(result.previews.mobile.path)).resolves.toBeUndefined();
  });

  it.each(["desktop", "tablet", "mobile"] as const)(
    "writes a valid WebP signature for %s",
    async (name) => {
      const bytes = await readFile(result.previews[name].path);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(result.previews[name].path).toBe(join(site.previews, `${name}.webp`));
      expect(result.previews[name].sizeBytes).toBe(bytes.byteLength);
    },
  );

  it("captures previews only from the home route", () => {
    const captures = result.report.checks.filter(
      ({ checkId, status }) => checkId === "template.preview-capture" && status === "PASS",
    );
    expect(captures).toHaveLength(3);
    expect(captures.every(({ route }) => route === "/")).toBe(true);
  });

  it("runs bounded safe interaction smoke without arbitrary button clicks", () => {
    const checks = result.report.checks.filter(({ checkId }) => checkId === "interaction-smoke");
    expect(checks).toHaveLength(9);
    expect(checks.every(({ status }) => status === "SKIPPED")).toBe(true);
  });

  it("closes Chromium after success", () => {
    expect(qa.activeBrowserCount).toBe(0);
  });

  it("closes the preview server after success", () => {
    expect(qa.activeServerCount).toBe(0);
  });
});

async function expectQAFailure(
  html: string,
  expected: { code: string; viewport?: string; check: string },
): Promise<PlaywrightTemplateBrowserQA> {
  const site = await builtSite(html);
  const qa = new PlaywrightTemplateBrowserQA();
  const { code, ...metadata } = expected;
  let failure: unknown;
  try {
    await qa.run({ buildDirectory: site.root, routes: ["/"], previewDirectory: site.previews });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ApplicationError);
  const applicationError = failure as ApplicationError;
  expect(applicationError.code).toBe(code);
  expect(applicationError.metadata).toMatchObject(metadata);
  return qa;
}

describe("T2B blocking QA policy", () => {
  it("blocks an uncaught runtime page error", async () => {
    await expectQAFailure(
      `<div id="root"><main>Visible</main></div><script>setTimeout(()=>{throw new Error('runtime boom')},0)</script>`,
      { code: "TEMPLATE_BROWSER_QA_FAILED", check: "runtime.page-error" },
    );
  });

  it("blocks a serious console error", async () => {
    await expectQAFailure(
      `<div id="root"><main>Visible</main></div><script>console.error('fatal template boot')</script>`,
      { code: "TEMPLATE_BROWSER_QA_FAILED", check: "template.console-error" },
    );
  });

  it("blocks an otherwise blank page", async () => {
    await expectQAFailure(`<div id="root"></div>`, {
      code: "TEMPLATE_BROWSER_QA_FAILED",
      check: "template.meaningful-content",
    });
  });

  it("detects desktop document overflow", async () => {
    await expectQAFailure(
      `<style>body{margin:0}@media(min-width:1000px){#wide{width:1600px}}</style><div id="root"><main id="wide">Visible</main></div>`,
      { code: "TEMPLATE_BROWSER_QA_FAILED", viewport: "DESKTOP", check: "responsive-overflow" },
    );
  });

  it("detects tablet document overflow", async () => {
    await expectQAFailure(
      `<style>body{margin:0}@media(min-width:600px) and (max-width:900px){#wide{width:900px}}</style><div id="root"><main id="wide">Visible</main></div>`,
      { code: "TEMPLATE_BROWSER_QA_FAILED", viewport: "TABLET", check: "responsive-overflow" },
    );
  });

  it("detects mobile document overflow", async () => {
    await expectQAFailure(
      `<style>body{margin:0}@media(max-width:500px){#wide{width:600px}}</style><div id="root"><main id="wide">Visible</main></div>`,
      { code: "TEMPLATE_BROWSER_QA_FAILED", viewport: "MOBILE", check: "responsive-overflow" },
    );
  });

  it("blocks a failed required local application resource", async () => {
    await expectQAFailure(
      `<div id="root"><main>Visible</main></div><script src="/missing.js"></script>`,
      { code: "TEMPLATE_BROWSER_QA_FAILED", check: "template.local-resources" },
    );
  });

  it("treats unavailable optional external media as advisory when rendering remains usable", async () => {
    const site = await builtSite(
      `<div id="root"><main>Visible<img alt="optional" style="width:10px;height:10px" src="https://example.invalid/image.png"></main></div>`,
    );
    const result = await new PlaywrightTemplateBrowserQA().run({
      buildDirectory: site.root,
      routes: ["/"],
      previewDirectory: site.previews,
    });
    expect(result.report.status).toBe("PASS_WITH_WARNINGS");
  });

  it("runs a deterministic semantic expandable interaction", async () => {
    const site = await builtSite(
      `<div id="root"><main>Visible<button aria-expanded="false" aria-controls="answer">Question</button><div id="answer" hidden>Answer</div></main></div><script>const b=document.querySelector('button');const a=document.querySelector('#answer');b.onclick=()=>{const open=b.getAttribute('aria-expanded')==='false';b.setAttribute('aria-expanded',String(open));a.hidden=!open}</script>`,
    );
    const result = await new PlaywrightTemplateBrowserQA().run({
      buildDirectory: site.root,
      routes: ["/"],
      previewDirectory: site.previews,
    });
    expect(
      result.report.checks
        .filter(({ checkId }) => checkId === "interaction-smoke")
        .every(({ status }) => status === "PASS"),
    ).toBe(true);
  });

  it("closes Chromium and the server after QA failure", async () => {
    const qa = await expectQAFailure(`<div id="root"></div>`, {
      code: "TEMPLATE_BROWSER_QA_FAILED",
      check: "template.meaningful-content",
    });
    expect(qa.activeBrowserCount).toBe(0);
    expect(qa.activeServerCount).toBe(0);
  });
});

class FakeTemplates implements TemplatePublicationRepository {
  created: SiteTemplate | undefined;
  constructor(private readonly events: string[]) {}
  findTemplateVersion(): Promise<SiteTemplate | undefined> {
    this.events.push("mongo-read");
    return Promise.resolve(undefined);
  }
  createTemplateVersion(template: SiteTemplate): Promise<SiteTemplate> {
    this.events.push("mongo-write");
    this.created = template;
    return Promise.resolve(template);
  }
}

class FakeCategories implements TemplateCategoryLookup {
  constructor(private readonly events: string[]) {}
  findCategoryByKey(): Promise<SiteCategory> {
    this.events.push("category-read");
    return Promise.resolve({
      id: "saas",
      categoryKey: "saas",
      name: "SaaS",
      description: "SaaS",
      status: "active",
      sortOrder: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }
}

class FakeStorage implements TemplateArtifactStorage {
  readonly bucketName = "test-bucket";
  readonly writes: TemplateArtifactWrite[] = [];
  readonly deletes: string[] = [];
  failObject: string | undefined;
  constructor(private readonly events: string[]) {}
  objectExists(object: string): Promise<boolean> {
    this.events.push(`gcs-read:${object}`);
    return Promise.resolve(false);
  }
  putObject(write: TemplateArtifactWrite): Promise<void> {
    this.events.push(`gcs-write:${write.object}`);
    if (write.object === this.failObject) return Promise.reject(new Error("upload failed"));
    this.writes.push(write);
    return Promise.resolve();
  }
  deleteObject(object: string): Promise<void> {
    this.events.push(`gcs-delete:${object}`);
    this.deletes.push(object);
    return Promise.resolve();
  }
}

class FakeCache implements TemplateCacheInvalidator {
  calls = 0;
  constructor(private readonly events: string[]) {}
  invalidateTemplateCatalogCache(): Promise<void> {
    this.events.push("redis");
    this.calls++;
    return Promise.resolve();
  }
}

class FakeBuilder implements TemplateBuildRunner {
  constructor(private readonly events: string[]) {}
  build(): Promise<{ durationMs: number; packageManager: "npm" }> {
    this.events.push("build");
    return Promise.resolve({ durationMs: 1, packageManager: "npm" });
  }
}

class FakeQA implements TemplateBrowserQA {
  input: TemplateBrowserQAInput | undefined;
  failureCode: "TEMPLATE_BROWSER_QA_FAILED" | "TEMPLATE_PREVIEW_CAPTURE_FAILED" | undefined;
  constructor(private readonly events: string[]) {}
  async run(input: TemplateBrowserQAInput): Promise<TemplateBrowserQAResult> {
    this.events.push("browser-qa");
    this.input = input;
    if (this.failureCode)
      throw new ApplicationError(this.failureCode, "controlled QA failure", {
        metadata: { route: "/", viewport: "MOBILE", check: "controlled" },
      });
    await mkdir(input.previewDirectory, { recursive: true });
    const previews = {} as Record<
      "desktop" | "tablet" | "mobile",
      { path: string; sizeBytes: number }
    >;
    for (const name of ["desktop", "tablet", "mobile"] as const) {
      const path = join(input.previewDirectory, `${name}.webp`);
      const bytes = Buffer.from(`RIFFxxxxWEBP${name}`);
      await writeFile(path, bytes);
      previews[name] = { path, sizeBytes: bytes.byteLength };
    }
    return {
      passed: true,
      routesChecked: input.routes.length,
      viewportsChecked: 3,
      report: {} as BrowserQAReport,
      previews,
    };
  }
}

interface PublisherHarness {
  readonly directory: string;
  readonly events: string[];
  readonly templates: FakeTemplates;
  readonly storage: FakeStorage;
  readonly cache: FakeCache;
  readonly qa: FakeQA;
  readonly publisher: TemplatePublisher;
}

async function publisherHarness(): Promise<PublisherHarness> {
  const root = await temporaryRoot("sites-template-t2b-publisher-");
  const directory = join(root, "template");
  await cp(fixture, directory, { recursive: true });
  const events: string[] = [];
  const templates = new FakeTemplates(events);
  const storage = new FakeStorage(events);
  const cache = new FakeCache(events);
  const qa = new FakeQA(events);
  const publisher = new TemplatePublisher(
    templates,
    new FakeCategories(events),
    storage,
    cache,
    new FakeBuilder(events),
    { info: () => undefined, warn: () => undefined },
    qa,
  );
  return { directory, events, templates, storage, cache, qa, publisher };
}

describe("T2B publisher integration and mutation safety", () => {
  let harness: PublisherHarness;

  beforeEach(async () => {
    harness = await publisherHarness();
  });

  it("does not require manually authored previews", async () => {
    await rm(join(harness.directory, "previews"), { recursive: true });
    await expect(validateTemplateSource(harness.directory)).resolves.toBeDefined();
  });

  it("runs Browser QA after build and before any GCS access", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: false });
    expect(harness.events.indexOf("build")).toBeLessThan(harness.events.indexOf("browser-qa"));
    expect(harness.events.indexOf("browser-qa")).toBeLessThan(
      harness.events.findIndex((event) => event.startsWith("gcs-")),
    );
  });

  it("uploads generated previews with the frozen object mapping", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: false });
    expect(harness.storage.writes.slice(1).map(({ object }) => object)).toEqual([
      "sites/templates/publisher-fixture/v1/previews/desktop.webp",
      "sites/templates/publisher-fixture/v1/previews/tablet.webp",
      "sites/templates/publisher-fixture/v1/previews/mobile.webp",
    ]);
  });

  it("keeps generated and author-supplied previews out of source ZIP", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: false });
    const entries = Object.keys(unzipSync(harness.storage.writes[0]!.bytes));
    expect(entries.some((entry) => entry.startsWith("previews/"))).toBe(false);
  });

  it("QA failure causes zero GCS uploads or collision reads", async () => {
    harness.qa.failureCode = "TEMPLATE_BROWSER_QA_FAILED";
    await expect(
      harness.publisher.publish({ directory: harness.directory, dryRun: false }),
    ).rejects.toMatchObject({ code: "TEMPLATE_BROWSER_QA_FAILED" });
    expect(harness.storage.writes).toHaveLength(0);
    expect(harness.events.some((event) => event.startsWith("gcs-"))).toBe(false);
  });

  it("QA failure causes zero Mongo version operations", async () => {
    harness.qa.failureCode = "TEMPLATE_BROWSER_QA_FAILED";
    await expect(
      harness.publisher.publish({ directory: harness.directory, dryRun: false }),
    ).rejects.toBeDefined();
    expect(harness.events).not.toContain("mongo-read");
    expect(harness.events).not.toContain("mongo-write");
  });

  it("QA failure causes zero Redis invalidation", async () => {
    harness.qa.failureCode = "TEMPLATE_BROWSER_QA_FAILED";
    await expect(
      harness.publisher.publish({ directory: harness.directory, dryRun: false }),
    ).rejects.toBeDefined();
    expect(harness.cache.calls).toBe(0);
  });

  it("screenshot failure causes zero publication mutations", async () => {
    harness.qa.failureCode = "TEMPLATE_PREVIEW_CAPTURE_FAILED";
    await expect(
      harness.publisher.publish({ directory: harness.directory, dryRun: false }),
    ).rejects.toMatchObject({ code: "TEMPLATE_PREVIEW_CAPTURE_FAILED" });
    expect(harness.storage.writes).toHaveLength(0);
    expect(harness.templates.created).toBeUndefined();
    expect(harness.cache.calls).toBe(0);
  });

  it("dry-run generates all preview metadata", async () => {
    const result = await harness.publisher.publish({ directory: harness.directory, dryRun: true });
    expect(result.browserQA).toBe("PASS");
    expect(result.previewByteSizes.desktop).toBeGreaterThan(12);
    expect(result.previewByteSizes.tablet).toBeGreaterThan(12);
    expect(result.previewByteSizes.mobile).toBeGreaterThan(12);
  });

  it("dry-run performs no GCS access", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: true });
    expect(harness.events.some((event) => event.startsWith("gcs-"))).toBe(false);
  });

  it("dry-run performs no Mongo version read or write", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: true });
    expect(harness.events).not.toContain("mongo-read");
    expect(harness.events).not.toContain("mongo-write");
  });

  it("dry-run performs no Redis mutation", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: true });
    expect(harness.cache.calls).toBe(0);
  });

  it("removes temporary generated screenshots after dry-run", async () => {
    await harness.publisher.publish({ directory: harness.directory, dryRun: true });
    await expect(access(harness.qa.input!.previewDirectory)).rejects.toBeDefined();
  });

  it("preserves T2A upload rollback after generated preview integration", async () => {
    harness.storage.failObject = "sites/templates/publisher-fixture/v1/previews/desktop.webp";
    await expect(
      harness.publisher.publish({ directory: harness.directory, dryRun: false }),
    ).rejects.toMatchObject({ code: "GCS_UPLOAD_FAILED" });
    expect(harness.storage.deletes).toEqual([
      "sites/templates/publisher-fixture/v1/source/template.zip",
    ]);
  });

  it("keeps frozen T1 public serialization free of source artifacts", () => {
    const now = new Date();
    const serialized = toPublicSiteTemplate(
      {
        id: "id",
        templateKey: "publisher-fixture",
        version: 1,
        name: "Fixture",
        description: "Fixture",
        categoryId: "saas",
        tags: [],
        status: "draft",
        routes: [{ path: "/", label: "Home" }],
        sourceObject: "sites/templates/x/v1/source/template.zip",
        sourceSha256: "a".repeat(64),
        previews: {},
        createdAt: now,
        updatedAt: now,
      },
      "bucket-chatbot-ni",
    );
    expect(serialized).not.toHaveProperty("sourceObject");
    expect(serialized).not.toHaveProperty("sourceSha256");
  });

  it("keeps source packaging deterministic after preview automation", async () => {
    const source = await validateTemplateSource(harness.directory);
    const first = await packageTemplateSource(source);
    const second = await packageTemplateSource(source);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toEqual(first.bytes);
  });
});
