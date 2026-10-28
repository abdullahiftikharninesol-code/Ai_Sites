import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { applySiteEditPatchBundle, type SiteEditPatch } from "../src/cli/runtime/site-coder-file-bundle.js";
import { parseEditRequirements, validateEditRequirements } from "../src/cli/runtime/edit-requirements.js";
import { independentScopedPatches, protectedEditValues, targetedEditScopeGuidance, validateEditScopeCompletion } from "../src/cli/runtime/edit-scope.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { createLocalSitesProduct } from "../src/sites/generation/create-local-sites-product.js";
import { SiteSourceSnapshotService } from "../src/sites/generation/source-snapshot.js";
import type { SiteCreditBillingService } from "../src/billing/credit-billing.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";

const path = "src/App.jsx";
const instruction = 'Replace "OldBrand" with "NewBrand" throughout the website. Change the homepage headline to "New heading". Update the hero description to "New description". Change the primary accent to #292929. Rename the featured collection heading to "New collection". Preserve navigation, quantity controls and shopping interactions.';
const original = 'function Home(){return <><section className="hero"><h1>Old heading</h1><p>Old description</p></section><section className="featured"><h2>Old collection</h2></section><footer>OldBrand</footer><a href="mailto:hello@oldbrand.com">hello@oldbrand.com</a></>}';
const patch = (find: string, replace: string, mode: SiteEditPatch['mode'] = 'unique', file = path): SiteEditPatch => ({ path: file, find, replace, mode });
const required = [patch('OldBrand', 'NewBrand'), patch('Old heading', 'New heading'), patch('Old description', 'New description'), patch('Old collection', 'New collection'), patch('--accent:blue', '--accent:#292929', 'unique', 'src/styles.css')];
const email = patch('hello@oldbrand.com', 'hello@newbrand.com');
const files = () => new Map([[path, original], ['src/styles.css', ':root{--accent:blue;--cream:#f6f0e5}']]);
async function setup(source = files()) {
  const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
  for (const [file, content] of source) await execution.writeFile(environment.id, file, content);
  return { execution, id: environment.id };
}
const context = (text = instruction, before = files()) => ({ instruction: text, relevantPaths: [...before.keys()], rename: parseEditRequirements(text).rename, requirementSource: before });
async function cleanupTemporaryScopeRoot(root: string): Promise<void> {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('sites-scope-rollback-')) throw new Error('Unsafe test cleanup path');
  await rm(target, { recursive: true, force: true });
}

describe('Deterministic targeted-edit scope, no provider calls', () => {
  it('distinguishes authorized categories from preserved functionality and does not infer contact consent from branding', () => {
    const scope = parseEditRequirements(instruction).scope!;
    expect(scope).toMatchObject({ brand: true, content: true, styling: true, navigation: false, contact: false, functional: false, canProveCompletion: true });
    expect(scope.copyTargets).toHaveLength(3);
    expect(scope.colors).toEqual(['#292929']);
    expect(parseEditRequirements('Add working cart interactions and update navigation links.').scope).toMatchObject({ functional: true, navigation: true });
    const guidance = targetedEditScopeGuidance(scope);
    expect(guidance).toContain('not inferred email addresses'); expect(guidance).toContain('never invent');
  });
  it('excludes an independently proved static email operation before ambiguity resolution, atomically applying all five requirements', async () => {
    const source = files(), c = context(), w = await setup(source);
    const selected = independentScopedPatches([...required, email], source, parseEditRequirements(instruction).scope!);
    expect(selected.excluded).toEqual([5]); expect(selected.patches).toEqual(required);
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, email] }, c);
    const after = new Map(await Promise.all([...source.keys()].map(async file => [file, await w.execution.readFile(w.id, file)] as const)));
    expect(() => validateEditRequirements(parseEditRequirements(instruction), source, after)).not.toThrow();
    expect(() => validateEditScopeCompletion(parseEditRequirements(instruction).scope!, source, after)).not.toThrow();
    expect(after.get(path)).toContain('mailto:hello@oldbrand.com'); expect(after.get(path)).not.toContain('hello@newbrand.com');
    expect(after.get(path)).toContain('New collection'); expect(after.get('src/styles.css')).toContain('--cream:#f6f0e5');
  });
  it.each(['unique', 'all'] as const)('permits an explicitly requested email with correct matching (%s)', async mode => {
    const text = 'Change the contact email to hello@newbrand.com.';
    const w = await setup();
    const op = mode === 'all' ? { ...email, mode } : patch('<a href="mailto:hello@oldbrand.com">hello@oldbrand.com</a>', '<a href="mailto:hello@newbrand.com">hello@newbrand.com</a>');
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [op] }, context(text));
    expect(await w.execution.readFile(w.id, path)).toContain('<a href="mailto:hello@newbrand.com">hello@newbrand.com</a>');
  });
  it('an explicitly required but ambiguous email operation still rejects without any writes', async () => {
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [email] }, context('Change the contact email to hello@newbrand.com.'))).rejects.toMatchObject({ metadata: { matches: 2, validationCheck: 'edit.patch-resolution' } });
    expect(await w.execution.readFile(w.id, path)).toBe(original);
  });
  it('permits an explicit old/new email replacement throughout the site, without confusing it with a display-brand rename', async () => {
    const text = 'Replace "hello@oldbrand.com" with "hello@newbrand.com" throughout the website.';
    const w = await setup();
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [email] }, context(text));
    const source = await w.execution.readFile(w.id, path);
    expect(source).toContain('<a href="mailto:hello@newbrand.com">hello@newbrand.com</a>');
    expect(() => validateEditScopeCompletion(parseEditRequirements(text).scope!, files(), new Map([[path, source]]))).not.toThrow();
  });
  it('does not silently accept a missing explicitly requested email change or a value supplied only in a comment', () => {
    const scope = parseEditRequirements('Change the contact email to hello@newbrand.com.').scope!;
    expect(() => validateEditScopeCompletion(scope, files(), files())).toThrow('contact change is incomplete');
    expect(() => validateEditScopeCompletion(scope, files(), new Map([[path, original + '/* hello@newbrand.com */']]))).toThrow('contact change is incomplete');
    expect(() => validateEditScopeCompletion(scope, files(), new Map([[path, original.replaceAll('hello@oldbrand.com', 'hello@newbrand.com')]]))).not.toThrow();
  });
  it.each([
    patch('<footer>OldBrand</footer><a href="mailto:hello@oldbrand.com">hello@oldbrand.com</a>', '<footer>NewBrand</footer><a href="mailto:hello@newbrand.com">hello@newbrand.com</a>'),
    patch('<a href="mailto:hello@oldbrand.com">hello@oldbrand.com</a>', '<a href="mailto:hello@newbrand.com">hello@newbrand.com</a> '),
  ])('never splits a mixed required/unrelated operation or ignores accompanying source changes', async mixed => {
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, mixed] }, context())).rejects.toMatchObject({ metadata: { reason: 'MIXED_OR_UNCERTAIN_UNAUTHORIZED_OPERATION' } });
    expect(await w.execution.readFile(w.id, path)).toBe(original); expect(await w.execution.readFile(w.id, 'src/styles.css')).toBe(files().get('src/styles.css'));
  });
  it('rejects overlapping required anchors instead of dropping an order dependency', async () => {
    const anchor = '<a href="mailto:hello@oldbrand.com">hello@oldbrand.com</a>';
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, patch(anchor, anchor.replace('</a>', ' Help</a>')), email] }, context())).rejects.toMatchObject({ metadata: { reason: 'OVERLAPPING_OR_ORDER_DEPENDENT_OPERATION' } });
    expect(await w.execution.readFile(w.id, path)).toBe(original);
  });
  it('rejects cross-operation cascading references and never reorders them', async () => {
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, email, patch('hello@newbrand.com', 'New heading')] }, context())).rejects.toMatchObject({ metadata: { reason: 'OVERLAPPING_OR_ORDER_DEPENDENT_OPERATION' } });
    expect(await w.execution.readFile(w.id, path)).toBe(original);
  });
  it('does not treat a shared constant as independent static display/contact source', async () => {
    const before = new Map([[path, 'const address="hello@oldbrand.com";function Home(){return <><h1>OldBrand</h1><a href={address}>Help</a></>}']]);
    const w = await setup(before);
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('OldBrand','NewBrand'), email] }, context('Rename OldBrand to NewBrand globally.', before))).rejects.toMatchObject({ metadata: { reason: 'NON_STATIC_CONTACT_DEPENDENCY' } });
    expect(await w.execution.readFile(w.id, path)).toBe(before.get(path));
  });
  it('recognizes uncommon domain suffixes without classifying JS member access or local imports as domains', () => {
    expect(protectedEditValues('oldbrand.fashion')).toMatchObject([{ kind: 'domain', value: 'oldbrand.fashion' }]);
    expect(protectedEditValues('import App from "./App.jsx"; document.title = "Updated";')).toEqual([]);
    expect(protectedEditValues('.product.card{color:red}', 'src/styles.css')).toEqual([]);
    expect(protectedEditValues('background:url(//cdn.oldbrand.fashion/photo)', 'src/styles.css')).toMatchObject([{ kind: 'url', value: '//cdn.oldbrand.fashion/photo)' }]);
  });
  it.each([0, 1, 2, 3, 4])('does not accept missing requested operation %s just because the email was excluded', async missing => {
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required.filter((_item, index) => index !== missing), email] }, context())).rejects.toMatchObject({ code: 'EDIT_REQUIREMENT_INCOMPLETE' });
    expect(await w.execution.readFile(w.id, path)).toBe(original); expect(await w.execution.readFile(w.id, 'src/styles.css')).toBe(files().get('src/styles.css'));
  });
  it('does not accept copy placed in a comment or the wrong section', async () => {
    const scope = parseEditRequirements('Change the homepage headline to "Requested headline".').scope!;
    const after = new Map([[path, 'function About(){return <h1>Requested headline</h1>} /* Requested headline */']]);
    expect(() => validateEditScopeCompletion(scope, new Map(), after)).toThrow('copy change is incomplete');
  });
  it('does not exclude an operation when another requested requirement cannot be proved complete', async () => {
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, email] }, context(instruction + ' Add working checkout.'))).rejects.toMatchObject({ metadata: { reason: 'MIXED_OR_UNCERTAIN_UNAUTHORIZED_OPERATION' } });
  });
  it('will not launder an unrelated retained copy change through an otherwise safe email exclusion', async () => {
    const before = files(); before.set(path, original.replace('</footer>', '</footer><p>Unrelated policy</p>'));
    const w = await setup(before);
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, patch('Unrelated policy', 'Invented policy'), email] }, context(instruction, before))).rejects.toMatchObject({ metadata: { reason: 'RETAINED_OPERATION_AUTHORIZATION_UNCERTAIN' } });
    expect(await w.execution.readFile(w.id, path)).toBe(before.get(path));
  });
  it('rejects a cross-file reference to an excluded replacement', async () => {
    const before = files(); before.set('src/Other.jsx', '<p>Other</p>');
    const w = await setup(before);
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [...required, email, patch('Other', 'hello@newbrand.com', 'unique', 'src/Other.jsx')] }, context(instruction, before))).rejects.toMatchObject({ metadata: { reason: 'OVERLAPPING_OR_ORDER_DEPENDENT_OPERATION' } });
  });
  it('does not interpret a negative contact instruction as permission', async () => {
    const w = await setup();
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [email] }, context('Please do not change the email to hello@newbrand.com.'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('a global display rename preserves matching substrings inside email/domain/mailto values', async () => {
    const source = '<h1>OldBrand</h1><a href="https://OldBrand.com">OldBrand</a><a href="mailto:hello@OldBrand.com">hello@OldBrand.com</a>', before = new Map([[path, source]]);
    const w = await setup(before), text = 'Rename OldBrand to NewBrand globally.';
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('OldBrand', 'NewBrand')] }, context(text, before));
    const after = await w.execution.readFile(w.id, path);
    expect(after).toContain('<h1>NewBrand</h1>'); expect(after).toContain('https://OldBrand.com'); expect(after).toContain('mailto:hello@OldBrand.com'); expect(after).toContain('>hello@OldBrand.com</a>');
    expect(() => validateEditRequirements(parseEditRequirements(text), before, new Map([[path, after]]))).not.toThrow();
  });
  it('rejects an exact local operation that changes a protected value using only a partial brand anchor', async () => {
    const before = new Map([[path, '<a href="mailto:hello@OldBrand.com">Email us</a>']]), w = await setup(before);
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('OldBrand', 'NewBrand')] }, context('Rename OldBrand to NewBrand.', before))).rejects.toMatchObject({ metadata: { reason: 'PROTECTED_VALUE_CHANGE_NOT_AUTHORIZED' } });
  });
  it.each([
    ['https://old.example', 'https://new.example'],
    ['+1 212-555-0190', '+1 212-555-0191'],
    ['oldbrand.com', 'newbrand.com'],
    ['oldbrand.fashion', 'newbrand.fashion'],
  ])('applies the same independent scope proof to protected %s', async (old, next) => {
    const before = new Map([[path, `function App(){return <><h1>OldBrand</h1><p>${old}</p></>}`]]), w = await setup(before);
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('OldBrand', 'NewBrand'), patch(old, next)] }, context('Rename OldBrand to NewBrand globally.', before));
    expect(await w.execution.readFile(w.id, path)).toBe(`function App(){return <><h1>NewBrand</h1><p>${old}</p></>}`);
  });
  it('preserves current source and never finalizes billing when a mixed unauthorized operation fails the actual offline pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sites-scope-rollback-'));
    const mixed = patch('<footer>OldBrand</footer><a href="mailto:hello@oldbrand.com">hello@oldbrand.com</a>', '<footer>NewBrand</footer><a href="mailto:hello@newbrand.com">hello@newbrand.com</a>');
    const mock = new MockAgentProvider({ customResponse: request => ({ id: 'offline-scope', model: request.model, message: { role: 'assistant', content: JSON.stringify({ patches: [mixed] }) }, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, finishReason: 'stop' }) });
    const provider = { id: 'offline-scope', getCapabilities: () => mock.getCapabilities(), createResponse: mock.createResponse.bind(mock) };
    const registry = new AgentProviderRegistry(); registry.register(provider);
    const finalize = vi.fn(), preflight = vi.fn(async () => ({}));
    const product = createLocalSitesProduct({ executionRoot: join(root, 'execution'), artifactRoot: join(root, 'artifacts'), agentRegistry: registry, orchestrationAgent: provider,
      billing: { preflight, finalizeSuccessfulJob: finalize } as unknown as SiteCreditBillingService });
    const siteId = 'offline-scope-project' as SiteId, owner = 'offline-scope-owner' as UserId, versionId = 'offline-current' as VersionId;
    try {
      const environment = await product.execution.createEnvironment({});
      await product.execution.writeFile(environment.id, path, original);
      await product.execution.writeFile(environment.id, 'package.json', JSON.stringify({ scripts: { build: 'vite build', dev: 'vite' }, dependencies: { react: '18.3.1', 'react-dom': '18.3.1' }, devDependencies: { vite: '6.4.1' } }));
      const sourceRef = 'sites/offline-scope-project/versions/v1/source/source.json';
      await new SiteSourceSnapshotService(product.artifacts).capture(product.execution, environment.id, sourceRef, { technicalProfileId: 'react-vite-v1', templateId: 'react-vite-v1', templateVersion: 1 });
      const bytes = await product.artifacts.get(sourceRef); await product.execution.destroyEnvironment(environment.id);
      const now = new Date();
      await product.projects.save({ id: siteId, ownerId: owner, name: 'Existing', slug: 'existing', status: 'ACTIVE', latestVersionId: versionId, createdAt: now, updatedAt: now });
      await product.versions.save({ id: versionId, siteId, versionNumber: 1, sourceArtifactRef: sourceRef, buildStatus: 'SUCCEEDED', createdAt: now });
      const commands = vi.spyOn(product.execution, 'executeCommand').mockResolvedValue({ exitCode: 0, stdout: 'offline', stderr: '', timedOut: false, durationMs: 0, startedAt: now, finishedAt: now });
      const commit = vi.spyOn(product.versions, 'save'), update = vi.spyOn(product.projects, 'save');
      await expect(product.orchestrator.editWebsite({ userId: owner, siteId, agentProvider: provider.id, instruction: 'Rename OldBrand to NewBrand globally.', browserQAEnabled: false })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', metadata: { validationCheck: 'edit.scope', reason: 'MIXED_OR_UNCERTAIN_UNAUTHORIZED_OPERATION' } });
      expect(mock.callCount).toBe(1); expect(preflight).toHaveBeenCalledOnce(); expect(finalize).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
      expect(commands.mock.calls.every(([, command]) => command.args?.[0] === 'ci')).toBe(true);
      expect((await product.projects.getById(siteId))?.latestVersionId).toBe(versionId);
      expect(await product.artifacts.get(sourceRef)).toEqual(bytes);
      expect((await product.versions.listBySite(siteId)).items).toHaveLength(1);
      expect((await product.jobs.listBySite(siteId)).items[0]).toMatchObject({ status: 'FAILED', billingStatus: 'NOT_CHARGED', creditsCharged: 0, physicalRequests: 1 });
    } finally {
      vi.restoreAllMocks();
      await cleanupTemporaryScopeRoot(root);
    }
  });
});
