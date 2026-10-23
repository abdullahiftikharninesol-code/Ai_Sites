import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, type Page } from "playwright";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import type { AgentRequest, AgentResponse } from "../src/agents/agent-types.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { InMemorySiteProjectRepository } from "../src/persistence/in-memory-repositories.js";
import type { SiteVersionRepository } from "../src/persistence/repositories.js";
import type { UnnumberedSiteVersion } from "../src/persistence/version-committer.js";
import type { SiteProject, SiteVersion } from "../src/sites/domain/entities.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import { TemplateInstantiationService } from "../src/templates/application/template-instantiation-service.js";
import { extractTemplateZip } from "../src/templates/application/safe-template-zip.js";
import { loadTemplateManifest } from "../src/templates/publishing/template-manifest.js";
import { packageTemplateSource } from "../src/templates/publishing/template-package.js";
import { validateTemplateSource } from "../src/templates/publishing/template-source.js";
import type { SiteTemplate } from "../src/templates/domain/site-template.js";
import { SiteSourceSnapshotService, type SiteSourceSnapshot } from "../src/sites/generation/source-snapshot.js";
import { BROWSER_QA_VIEWPORTS, type BrowserQAReport } from "../src/browser-qa/browser-qa-domain.js";
import { BrowserQARunner } from "../src/browser-qa/browser-qa-runner.js";
import { browserQACoreCheckExecutors } from "../src/browser-qa/browser-qa-core-checks.js";
import { browserQAResponsiveAndInteractionChecks } from "../src/browser-qa/browser-qa-interaction-checks.js";
import { verifyRepairedTemplateControls } from "./fixtures/repaired-template-controls.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { applyDeterministicAutofix } from "../src/sites/generation/deterministic-autofix.js";
import type { GenerationDevelopmentEvent } from "../src/sites/generation/generation-development-telemetry.js";

const keys = ['modern-saas','creative-agency','personal-portfolio','corporate-business','ecommerce-store','restaurant','real-estate','healthcare-clinic'];
const parent = resolve('.sites-runtime/exact-workflow-tests'), roots: string[] = [];
const artifacts = new Map<string, Uint8Array>();
const nexoraInstruction = 'Rename ApexBridge Group to Nexora Technologies. Change the homepage headline and hero description. Change the primary accent color to #2563EB. Preserve the existing layout and all functionality.';
const nexoraPatches = [
  { path: 'src/App.jsx', find: 'ApexBridge Group', replace: 'Nexora Technologies', mode: 'all' },
  { path: 'src/App.jsx', find: 'APEXBRIDGE<small>GROUP</small>', replace: 'NEXORA<small>TECHNOLOGIES</small>', mode: 'all' },
  { path: 'src/App.jsx', find: 'ApexBridge', replace: 'Nexora Technologies', mode: 'all' },
  { path: 'src/App.jsx', find: 'apexbridge.com', replace: 'nexora.example', mode: 'all' },
  { path: 'index.html', find: 'ApexBridge Advisory', replace: 'Nexora Technologies', mode: 'all' },
  { path: 'src/App.jsx', find: 'See the whole.<br/><em>Shape what’s next.</em>', replace: 'Technology for tomorrow.<br/><em>Built with Nexora.</em>', mode: 'unique' },
  { path: 'src/App.jsx', find: 'We help leaders make consequential decisions, move through complexity and build businesses that endure.', replace: 'Nexora Technologies builds practical technology for ambitious businesses.', mode: 'unique' },
  { path: 'src/styles.css', find: '--brass:#bc9660', replace: '--brass:#2563EB', mode: 'unique' },
];
let catalog: SiteTemplate[];
beforeAll(async () => {
  if (process.env.SITES_EXACT_TEMPLATE_FIXTURE_ROOT) {
    const directory = resolve(process.env.SITES_EXACT_TEMPLATE_FIXTURE_ROOT);
    catalog = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')) as SiteTemplate[];
    for (const key of keys) artifacts.set(key, await readFile(join(directory, key + '.zip')));
  } else {
    catalog = await Promise.all(keys.map(async key => {
      const directory = resolve('templates', key), manifest = await loadTemplateManifest(directory);
      const archive = await packageTemplateSource(await validateTemplateSource(directory)); artifacts.set(key, archive.bytes);
      return { ...manifest, id: `${key}:${manifest.version}`, categoryId: manifest.categoryKey, status: 'active' as const, sourceObject: `${key}.zip`, sourceSha256: archive.sha256, previews: {}, createdAt: new Date(0), updatedAt: new Date(0) };
    }));
  }
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(parent + sep)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

// Isolated current-only repository double. Production Mongo CAS/reload behavior
// is tested separately by mongodb-persistence.test.ts, never against shared data.
class CurrentVersions implements SiteVersionRepository {
  readonly current = new Map<SiteId, SiteVersion>();
  async getById(id: VersionId) { return [...this.current.values()].find(version => version.id === id); }
  async save(version: SiteVersion) { this.current.set(version.siteId, version); }
  async listBySite(id: SiteId) { const value = this.current.get(id); return { items: value ? [value] : [] }; }
}
async function harness(record: SiteTemplate) {
  vi.stubEnv('npm_config_offline', 'true');
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'case-')); roots.push(root);
  let failEdit = false;
  let responseOverride: Pick<AgentResponse, 'message' | 'finishReason'> | undefined;
  const requests: AgentRequest[] = [];
  const provider = new MockAgentProvider({ customResponse: request => {
    requests.push(request);
    return { id: 'offline-exact-edit', model: request.model, message: { role: 'assistant', content: JSON.stringify({ patches: failEdit
      ? [{ path: 'src/App.jsx', find: 'THIS TEXT DOES NOT EXIST', replace: 'invalid' }]
      : record.templateKey === 'corporate-business' ? nexoraPatches : [
        { path: 'src/App.jsx', find: 'Atelier Row', replace: 'North & Loom', mode: 'all' },
        { path: 'src/App.jsx', find: 'ATELIER <i>ROW</i>', replace: 'NORTH &amp; <i>LOOM</i>' },
        { path: 'src/App.jsx', find: 'ATELIER /', replace: 'NORTH &amp; LOOM /', mode: 'all' },
        { path: 'src/App.jsx', find: 'Atelier collection', replace: 'North & Loom collection', mode: 'all' },
        { path: 'index.html', find: 'Atelier Row', replace: 'North & Loom', mode: 'all' },
        { path: 'src/App.jsx', find: 'A thoughtful edit of furniture and objects—made to be used, lived with, and kept close.', replace: 'Considered clothing for everyday life, crafted with care by North & Loom.' },
        { path: 'src/styles.css', find: '--green:#25372d', replace: '--green:#262626' },
        { path: 'src/styles.css', find: '--cream:#f6f0e5', replace: '--cream:#f4efe7' },
      ] }) }, toolCalls: [], usage: { inputTokens: 100, outputTokens: 100 }, latencyMs: 0, finishReason: 'stop', ...responseOverride };
  } });
  Object.defineProperty(provider, 'id', { value: 'offline-exact-template' });
  const registry = new AgentProviderRegistry(); registry.register(provider);
  const projects = new InMemorySiteProjectRepository(), versions = new CurrentVersions();
  const committer = { commit: async (project: SiteProject, draft: UnnumberedSiteVersion) => {
    const previous = versions.current.get(project.id);
    if (draft.buildStatus !== 'SUCCEEDED' || draft.browserQAStatus === 'FAILED' || previous?.id !== project.latestVersionId) throw new Error('Invalid/stale candidate');
    const version = { ...draft, versionNumber: (previous?.versionNumber ?? 0) + 1 };
    await versions.save(version); await projects.save({ ...project, latestVersionId: version.id, status: 'ACTIVE', updatedAt: new Date() }); return version;
  } };
  const billing = { preflight: vi.fn(async () => ({})), finalizeSuccessfulJob: vi.fn(async (job: unknown) => job) };
  const developmentTelemetry = { record: vi.fn<(event: GenerationDevelopmentEvent) => void>() };
  const api = createLocalSitesProduct({ executionRoot: join(root, 'execution'), artifactRoot: join(root, 'artifacts'), projects, versions, versionCommitter: committer,
    agentRegistry: registry, orchestrationAgent: provider, developmentTelemetry, billing: billing as unknown as SiteCreditBillingService });
  const source = { readObject: vi.fn(async () => artifacts.get(record.templateKey)) };
  const templates = { findLatestActiveTemplate: vi.fn(async () => record), findTemplateVersion: vi.fn(async () => ({ ...record, version: 1, status: 'archived' as const })), listActiveTemplates: vi.fn(), findById: async () => record };
  const qa = vi.spyOn(api.browserQA, 'run');
  const service = new TemplateInstantiationService({ templates, source, execution: api.execution, artifacts: api.artifacts, projects, versions: committer, browserQA: api.browserQA, cleanupSite: async () => undefined });
  return { root, api, service, templates, source, qa, provider, requests, billing, developmentTelemetry, failEdit: () => { failEdit = true; },
    setEditResponse: (content: string, finishReason: AgentResponse['finishReason'] = 'stop') => { responseOverride = { message: { role: 'assistant', content }, finishReason }; } };
}
async function snapshot(h: Awaited<ReturnType<typeof harness>>, versionId: VersionId) {
  const version = (await h.api.versions.getById(versionId))!;
  return JSON.parse(Buffer.from((await h.api.artifacts.get(version.sourceArtifactRef))!).toString()) as SiteSourceSnapshot;
}
async function exerciseStore(page: Page, url: string) {
  await page.goto(url + '/product', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Increase quantity', exact: true }).click();
  await page.getByRole('button', { name: /Add to bag/ }).click();
  expect(await page.getByRole('link', { name: 'Shopping bag with 2 items' }).count()).toBe(1);
  await page.getByRole('button', { name: 'Details & dimensions' }).click();
  expect(await page.getByText('Hand-blown soda-lime glass.', { exact: false }).isVisible()).toBe(true);
  await page.goto(url + '/shop', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  expect(await page.locator('.product-card').count()).toBe(2);
}

describe('Original exact-template workflow, no live AI', () => {
  it.runIf(process.env.SITES_VERIFY_PUBLISHED_HEALTHCARE_V1 === '1')('rejects the actual active Healthcare v1 at Browser QA before persistence', async () => {
    const record = catalog.find(item => item.templateKey === 'healthcare-clinic')!;
    expect(record.version).toBe(1);
    const h = await harness(record);
    const saveProject = vi.spyOn(h.api.projects, 'save');
    await expect(h.service.instantiate({ ownerId: 'exact-owner' as UserId, templateKey: record.templateKey })).rejects.toMatchObject({ code: 'TEMPLATE_INSTANTIATION_QA_FAILED' });
    const report = await h.qa.mock.results[0]?.value as BrowserQAReport;
    const blockers = report.checks.filter(check => check.status === 'FAIL' && check.severity === 'ERROR');
    expect(blockers).toHaveLength(6);
    expect(new Set(blockers.map(check => check.checkId))).toEqual(new Set(['internal-links']));
    expect(new Set(blockers.map(check => check.route))).toEqual(new Set(['/services', '/team']));
    expect(new Set(blockers.map(check => check.viewport?.id))).toEqual(new Set(['DESKTOP', 'TABLET', 'MOBILE']));
    expect(saveProject).not.toHaveBeenCalled();
    expect((await h.api.projects.listByOwner('exact-owner')).items).toEqual([]);
    expect(h.provider.callCount).toBe(0);
    expect(h.billing.preflight).not.toHaveBeenCalled();
    expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
    const proof = resolve(process.env.SITES_EXACT_TEMPLATE_PROOF_ROOT ?? '.sites-runtime/exact-template-proof'); await mkdir(proof, { recursive: true });
    await writeFile(join(proof, 'active-healthcare-v1-rejection.json'), JSON.stringify(report));
  }, 180_000);
  it.each(keys)('loads the active %s ZIP byte-for-byte and passes all declared routes on three viewports', async key => {
    const record = catalog.find(item => item.templateKey === key)!;
    if (['corporate-business','restaurant'].includes(key)) expect(record.version).toBe(2);
    expect(createHash('sha256').update(artifacts.get(key)!).digest('hex')).toBe(record.sourceSha256);
    const h = await harness(record);
    const created = await h.service.instantiate({ ownerId: 'exact-owner' as UserId, templateKey: key }).catch(async error => {
      const failed = await h.qa.mock.results.at(-1)?.value as BrowserQAReport | undefined;
      const proof = resolve(process.env.SITES_EXACT_TEMPLATE_PROOF_ROOT ?? '.sites-runtime/exact-template-proof'); await mkdir(proof, { recursive: true });
      await writeFile(join(proof, `${key}-qa.json`), JSON.stringify(failed));
      console.info('[exact-template] failure evidence', JSON.stringify(failed?.checks.filter(check => check.status === 'FAIL' && check.severity === 'ERROR').slice(0, 3).map(check => ({ check: check.checkId, route: check.route, viewport: check.viewport?.id, message: check.message, evidence: check.evidence }))));
      throw error;
    });
    try {
      expect(h.templates.findLatestActiveTemplate).toHaveBeenCalledWith(key);
      expect(h.templates.findTemplateVersion).not.toHaveBeenCalled();
      expect(h.provider.callCount).toBe(0); expect(h.billing.preflight).not.toHaveBeenCalled(); expect(h.billing.finalizeSuccessfulJob).not.toHaveBeenCalled();
      const report = await h.qa.mock.results[0]?.value as BrowserQAReport | undefined;
      const proof = resolve(process.env.SITES_EXACT_TEMPLATE_PROOF_ROOT ?? '.sites-runtime/exact-template-proof'); await mkdir(proof, { recursive: true });
      await writeFile(join(proof, `${key}-qa.json`), JSON.stringify(report));
      expect(report?.status).not.toBe('FAIL'); expect(new Set(report?.routes)).toEqual(new Set(record.routes.map(route => route.path)));
      // Established policy permits advisory findings; never downgrade gates.
      expect(report?.checks.filter(check => check.status === 'FAIL' && check.severity === 'ERROR')).toEqual([]);
      expect(report?.checks.filter(check => check.checkId === 'runtime.page-error' && check.status !== 'PASS')).toEqual([]);
      expect(new Set(report?.checks.map(check => check.viewport?.id))).toEqual(new Set(['DESKTOP','TABLET','MOBILE']));
      const original = join(h.root, 'original'); await mkdir(original); await extractTemplateZip(artifacts.get(key)!, original);
      const source = await validateTemplateSource(original);
      expect((await loadTemplateManifest(original)).version).toBe(record.version);
      for (const file of source.packageFiles) expect(await h.api.execution.readFileBytes(created.environmentId, file)).toEqual(await readFile(join(original, file)));
      const saved = await snapshot(h, created.versionId);
      for (const file of source.packageFiles.filter(path => path.startsWith('src/') || path === 'index.html')) expect(saved.files[file]).toBe(await readFile(join(original, file), 'utf8'));
      expect((await h.api.projects.getById(created.projectId))?.ownerId).toBe('exact-owner');
      expect((await h.api.versions.listBySite(created.projectId)).items).toHaveLength(1);
      if (key === 'ecommerce-store') await verifyStore(h, created, record);
      if (key === 'corporate-business') await verifyCorporate(h, created, record);
      if (['creative-agency','real-estate','healthcare-clinic'].includes(key)) await verifyRepairedTemplateControls(key, created.preview.url, proof);
    } finally { await h.api.execution.destroyEnvironment(created.environmentId); }
  }, 420_000);
  it.each(['corporate-business','restaurant'])('rejects archived %s v1 rather than loading it', async key => {
    const h = await harness(catalog.find(item => item.templateKey === key)!);
    await expect(h.service.instantiate({ ownerId: 'exact-owner' as UserId, templateKey: key, version: 1 })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(h.source.readObject).not.toHaveBeenCalled(); expect(h.provider.callCount).toBe(0);
  });
});

async function verifyCorporate(h: Awaited<ReturnType<typeof harness>>, created: Awaited<ReturnType<TemplateInstantiationService['instantiate']>>, record: SiteTemplate) {
  expect(record.version).toBe(2);
  expect(h.provider.callCount).toBe(0); expect(h.billing.preflight).not.toHaveBeenCalled();
  const original = await snapshot(h, created.versionId);
  const edited = await h.api.pipeline.edit({ userId: 'exact-owner' as UserId, siteId: created.projectId, instruction: nexoraInstruction, agentProvider: h.provider.id, browserQAEnabled: true, retainPreview: true });
  try {
    expect(edited.build.success).toBe(true); expect(edited.browserQA?.status).not.toBe('FAIL');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.responseContract).toMatchObject({ name: 'SiteEditPatchBundle', strict: true });
    expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
    const current = await snapshot(h, edited.newVersionId);
    // Exact equality apart from the requested replacements and existing Sites
    // postprocessing: no layout/handler/content rewrites by the edit response.
    const expected = { ...original.files };
    for (const patch of nexoraPatches) expected[patch.path] = patch.mode === 'all'
      ? expected[patch.path]!.split(patch.find).join(patch.replace)
      : expected[patch.path]!.replace(patch.find, patch.replace);
    const normalizer = new MockExecutionProvider(), normalizationEnvironment = await normalizer.createEnvironment({});
    try {
      for (const [path, content] of Object.entries(expected)) await normalizer.writeFile(normalizationEnvironment.id, path, content);
      const normalized = await applyDeterministicAutofix(normalizer, normalizationEnvironment.id);
      expect(normalized.fixes.every(fix => ['RESPONSIVE_LAYOUT_SAFETY_GUARD', 'INTRINSIC_GRID_SIZING_GUARD'].includes(fix.id))).toBe(true);
      for (const path of Object.keys(expected)) expected[path] = await normalizer.readFile(normalizationEnvironment.id, path);
    } finally { await normalizer.destroyEnvironment(normalizationEnvironment.id); }
    expect(current.files).toEqual(expected);
    expect(current.files['src/App.jsx']).not.toMatch(/apexbridge/i);
    expect(current.files['index.html']).toContain('Nexora Technologies');
    const qa = await new BrowserQARunner().run({ runId: 'nexora-all-routes', target: { baseUrl: edited.preview.url! }, routes: record.routes.map(route => route.path), checks: [...browserQACoreCheckExecutors, ...browserQAResponsiveAndInteractionChecks], policy: { captureScreenshots: false } });
    for (const viewport of BROWSER_QA_VIEWPORTS) {
      const checks = qa.checks.filter(check => check.viewport?.id === viewport.id);
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.filter(check => check.status === 'FAIL' && check.severity === 'ERROR')).toEqual([]);
      expect(new Set(checks.map(check => check.route))).toEqual(new Set(record.routes.map(route => route.path)));
    }
    expect(qa.checks.filter(check => check.checkId === 'page-errors' && check.status === 'FAIL')).toEqual([]);
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of BROWSER_QA_VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
        const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(edited.preview.url!, { waitUntil: 'networkidle' });
        expect(await page.locator('h1').innerText()).toContain('Technology for tomorrow.');
        expect(await page.locator('.hero-copy p').innerText()).toContain('Nexora Technologies');
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brass').trim())).toBe('#2563EB');
        await page.goto(edited.preview.url! + '/contact', { waitUntil: 'networkidle' });
        await page.locator('input[name="firstName"]').fill('Offline'); await page.locator('input[name="lastName"]').fill('Fixture');
        await page.locator('input[name="email"]').fill('fixture@example.test'); await page.locator('textarea').fill('Offline form verification');
        await page.getByRole('button', { name: 'Submit inquiry' }).click();
        expect(await page.getByRole('status').innerText()).toContain('Thank you.');
        expect(pageErrors).toEqual([]); await page.close();
      }
    } finally { await browser.close(); }
    expect((await h.api.versions.listBySite(created.projectId)).items).toHaveLength(1);
    expect(await h.api.versions.getById(created.versionId)).toBeUndefined();
    const reloadedEnvironment = await h.api.execution.createEnvironment({});
    try {
      const version = (await h.api.versions.getById(edited.newVersionId))!;
      const reloaded = await new SiteSourceSnapshotService(h.api.artifacts).restore(h.api.execution, reloadedEnvironment.id, version.sourceArtifactRef);
      expect(reloaded.files).toEqual(current.files);
    } finally { await h.api.execution.destroyEnvironment(reloadedEnvironment.id); }
    // Every rejection is a new isolated mock test, never a live user retry.
    for (const [content, finish, code] of [
      ['{"patches":[{"path":"src/App.jsx"}]}', 'stop', 'STRUCTURED_RESPONSE_SCHEMA_INVALID'],
      ['{"files":[]}', 'stop', 'STRUCTURED_RESPONSE_SCHEMA_INVALID'],
      ['{"patches":', 'stop', 'STRUCTURED_RESPONSE_PARSE_FAILED'],
      ['{"patches":', 'length', 'MODEL_OUTPUT_TRUNCATED'],
      [JSON.stringify({ patches: [{ path: 'src/App.jsx', find: 'ANCHOR DOES NOT EXIST', replace: 'unsafe', mode: 'unique' }] }), 'stop', 'VALIDATION_FAILED'],
    ] as const) {
      h.setEditResponse(content, finish);
      const calls = h.requests.length;
      await expect(h.api.pipeline.edit({ userId: 'exact-owner' as UserId, siteId: created.projectId, instruction: 'Change the current hero headline', agentProvider: h.provider.id, browserQAEnabled: true })).rejects.toMatchObject({ code });
      expect(h.requests).toHaveLength(calls + 1);
      expect((await h.api.projects.getById(created.projectId))?.latestVersionId).toBe(edited.newVersionId);
      expect((await snapshot(h, edited.newVersionId)).files).toEqual(current.files);
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce();
      if (code !== 'VALIDATION_FAILED') {
        const diagnostic = h.developmentTelemetry.record.mock.calls.at(-1)?.[0];
        expect(diagnostic).toMatchObject({ role: 'sites.targeted-edit', provider: h.provider.id,
          responseSchema: 'SiteEditPatchBundle',
          finishReason: finish, truncated: finish === 'length', billingStatus: 'NOT_CHARGED', creditsCharged: 0,
          inputTokens: 100, outputTokens: 100 });
        expect(diagnostic?.responseSchemaVersion).toMatch(/^[a-f0-9]{16}$/);
        expect(JSON.stringify(diagnostic)).not.toContain(content);
      }
    }
    expect(h.source.readObject).toHaveBeenCalledOnce();
  } finally { await h.api.execution.destroyEnvironment(edited.preview.environmentId); }
}

async function verifyStore(h: Awaited<ReturnType<typeof harness>>, created: Awaited<ReturnType<TemplateInstantiationService['instantiate']>>, record: SiteTemplate) {
  const browser = await chromium.launch({ headless: true });
  const proof = resolve(process.env.SITES_EXACT_TEMPLATE_PROOF_ROOT ?? '.sites-runtime/exact-template-proof'); await mkdir(proof, { recursive: true });
  const original = await snapshot(h, created.versionId);
  try {
    for (const viewport of BROWSER_QA_VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
      await page.goto(created.preview.url, { waitUntil: 'networkidle' });
      expect(await page.locator('body').innerText()).toContain('Objects for the');
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(proof, `original-${viewport.id.toLowerCase()}.png`), animations: 'disabled' });
      const fixtureRoot = process.env.SITES_EXACT_TEMPLATE_FIXTURE_ROOT;
      if (fixtureRoot) {
        const cdp = await page.context().newCDPSession(page);
        const image = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 85, fromSurface: true, captureBeyondViewport: false }); await cdp.detach();
        const published = await readFile(join(fixtureRoot, `ecommerce-${viewport.id.toLowerCase()}.webp`));
        const difference = await page.evaluate(async ({ a, b }) => {
          const pixels = async (data: string) => { const img = new Image(); img.src = 'data:image/webp;base64,' + data; await img.decode(); const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0); return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data }; };
          const x = await pixels(a), y = await pixels(b); if (x.width !== y.width || x.height !== y.height) return { mean: 255, changed: 1 };
          let sum = 0, changed = 0; for (let i = 0; i < x.data.length; i += 4) { let maximum = 0; for (let c = 0; c < 3; c++) { const delta = Math.abs(x.data[i+c]! - y.data[i+c]!); sum += delta; maximum = Math.max(maximum, delta); } if (maximum > 24) changed++; }
          return { mean: sum / (x.width*x.height*3), changed: changed / (x.width*x.height) };
        }, { a: published.toString('base64'), b: image.data });
        console.info(`[exact-template] published preview ${viewport.id}: mean=${difference.mean.toFixed(4)} changed=${difference.changed.toFixed(4)}`);
        expect(difference.mean).toBeLessThan(1.5); expect(difference.changed).toBeLessThan(0.02);
      }
      await exerciseStore(page, created.preview.url); await page.close();
    }
    const edited = await h.api.pipeline.edit({ userId: 'exact-owner' as UserId, siteId: created.projectId, instruction: 'Rename Atelier Row to North & Loom. Update the homepage hero copy and use charcoal and cream colors. Keep the layout and all product interactions.', agentProvider: h.provider.id, browserQAEnabled: true, retainPreview: true });
    try {
      expect(edited.build.success).toBe(true); expect(edited.browserQA?.status).not.toBe('FAIL');
      expect(h.requests.every(request => request.responseContract?.type === 'JSON_SCHEMA' && request.responseContract.name === 'SiteEditPatchBundle')).toBe(true);
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce(); expect(h.source.readObject).toHaveBeenCalledOnce();
      const current = await snapshot(h, edited.newVersionId);
      expect(current.files['src/App.jsx']).toContain('North & Loom'); expect(current.files['src/App.jsx']).not.toContain('Atelier Row');
      expect(current.files['src/main.jsx']).toBe(original.files['src/main.jsx']); expect(current.files['src/components.css']).toBe(original.files['src/components.css']);
      expect(current.files['src/App.jsx']).toContain('Contour Carafe'); expect(current.files['src/styles.css']).toContain('--green:#262626');
      expect((await h.api.versions.listBySite(created.projectId)).items).toHaveLength(1);
      expect(await h.api.versions.getById(created.versionId)).toBeUndefined();
      const qa = await new BrowserQARunner().run({ runId: 'edited-template-all-routes', target: { baseUrl: edited.preview.url! }, routes: record.routes.map(route => route.path), checks: [...browserQACoreCheckExecutors, ...browserQAResponsiveAndInteractionChecks], policy: { captureScreenshots: false } });
      expect(qa.status).not.toBe('FAIL'); expect(qa.checks.filter(check => check.status === 'FAIL' && check.severity === 'ERROR')).toEqual([]);
      const page = await browser.newPage(); await page.goto(edited.preview.url!, { waitUntil: 'networkidle' });
      expect(await page.locator('body').innerText()).toContain('NORTH & LOOM');
      await page.screenshot({ path: join(proof, 'customized-desktop.png') });
      await exerciseStore(page, edited.preview.url!);
      const restore = await h.api.execution.createEnvironment({});
      try { const version = (await h.api.versions.getById(edited.newVersionId))!; const reloaded = await new SiteSourceSnapshotService(h.api.artifacts).restore(h.api.execution, restore.id, version.sourceArtifactRef); expect(reloaded.files['src/App.jsx']).toBe(current.files['src/App.jsx']); }
      finally { await h.api.execution.destroyEnvironment(restore.id); }
      h.failEdit();
      await expect(h.api.pipeline.edit({ userId: 'exact-owner' as UserId, siteId: created.projectId, instruction: 'Change the current hero again', agentProvider: h.provider.id, browserQAEnabled: true })).rejects.toBeDefined();
      expect((await h.api.projects.getById(created.projectId))?.latestVersionId).toBe(edited.newVersionId);
      expect((await snapshot(h, edited.newVersionId)).files).toEqual(current.files);
      expect(h.billing.finalizeSuccessfulJob).toHaveBeenCalledOnce(); expect(h.source.readObject).toHaveBeenCalledOnce();
      await page.goto(edited.preview.url!, { waitUntil: 'networkidle' }); expect(await page.locator('body').innerText()).toContain('NORTH & LOOM'); await page.close();
      expect(createHash('sha256').update(artifacts.get('ecommerce-store')!).digest('hex')).toBe(record.sourceSha256);
    } finally { await h.api.execution.destroyEnvironment(edited.preview.environmentId); }
  } finally { await browser.close(); }
}
