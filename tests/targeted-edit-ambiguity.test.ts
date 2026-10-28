import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationError } from "../src/app/errors/application-error.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { applySiteEditPatchBundle, validateSiteEditPatchBundle, type SiteEditPatch } from "../src/cli/runtime/site-coder-file-bundle.js";
import { editTextDigest, type SiteEditPatchContext } from "../src/cli/runtime/site-edit-patch-resolver.js";
import { parseEditRequirements } from "../src/cli/runtime/edit-requirements.js";
import { LocalFailedCandidateEvidence, createDevelopmentFailedCandidateEvidence } from "../src/sites/generation/failed-candidate-evidence.js";
import { AgentProviderRegistry } from "../src/agents/registry/agent-provider-registry.js";
import { MockAgentProvider } from "../src/agents/mock-agent-provider.js";
import { LocalCliAgentRuntime } from "../src/cli/runtime/local-cli-agent-runtime.js";
import { InProcessAgentGateway } from "../src/agents/gateway/in-process-agent-gateway.js";
import { DevJobManager } from "../src/dev-server/dev-job-manager.js";
import { InMemoryProgressBus } from "../src/sites/application/progress.js";

const path = "src/App.jsx";
const patch = (find: string, replace: string, file = path, mode: SiteEditPatch["mode"] = "unique"): SiteEditPatch => ({ path: file, find, replace, mode });
async function workspace(files: Record<string, string>) {
  const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
  for (const [file, content] of Object.entries(files)) await execution.writeFile(environment.id, file, content);
  return { execution, id: environment.id };
}
function scope(instruction: string, relevantPaths = [path]): SiteEditPatchContext {
  return { instruction, relevantPaths, rename: parseEditRequirements(instruction).rename };
}
async function rejection(work: ReturnType<typeof applySiteEditPatchBundle>): Promise<ApplicationError> {
  try { await work; } catch (error) { if (error instanceof ApplicationError) return error; throw error; }
  throw new Error("Expected a rejected patch");
}
async function cleanupTemporaryRoot(root: string): Promise<void> {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('sites-patch-')) throw new Error('Unsafe test cleanup path');
  await rm(target, { recursive: true, force: true });
}

describe("Scoped deterministic patch recovery, no AI", () => {
  it.each([
    'Rename "Atelier Row" to "North & Loom" globally.',
    'Replace Atelier Row with North & Loom throughout the website.',
    'Rename Atelier Row to North & Loom across the entire site.',
  ])("A/H: recovers an explicit global rename across only the supplied files: %s", async instruction => {
    expect(parseEditRequirements(instruction).rename).toEqual({ oldLiteral: "Atelier Row", newLiteral: "North & Loom" });
    const source = '<header>Atelier Row</header><footer>Atelier Row</footer>';
    const files = { [path]: source, "src/footer.jsx": source, "src/unrelated.jsx": source };
    const w = await workspace(files);
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Atelier Row', 'North & Loom'), patch('Atelier Row', 'North & Loom', 'src/footer.jsx')] }, scope(instruction, [path, 'src/footer.jsx']));
    for (const file of [path, 'src/footer.jsx']) expect(await w.execution.readFile(w.id, file)).toBe(source.replaceAll('Atelier Row', 'North & Loom'));
    expect(await w.execution.readFile(w.id, 'src/unrelated.jsx')).toBe(source);
  });
  it.each([
    'Rename "Atelier Row" to "North & Loom" in the footer only.',
    'Rename "Atelier Row" to "North & Loom". Update colors globally.',
    'Do not rename "Atelier Row" to "North & Loom" globally.',
    'Rename "Atelier Row" to "North & Loom" globally except the footer.',
    'Rename "Atelier Row" to "North & Loom" globally. Except the footer.',
    'Rename "Atelier Row" to "North & Loom" globally. Keep the old branding in the footer.',
  ])("never promotes an ambiguous patch using unrelated/global-negative intent: %s", async instruction => {
    const source = '<header>Atelier Row</header><footer>Atelier Row</footer>', w = await workspace({ [path]: source });
    const error = await rejection(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Atelier Row', 'North & Loom')] }, scope(instruction)));
    expect(error.metadata?.matches).toBe(2); expect(await w.execution.readFile(w.id, path)).toBe(source);
  });
  it("will not recover a global rename in a file absent from the supplied context", async () => {
    const w = await workspace({ [path]: 'Brand Brand' });
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Brand', 'NewBrand')] }, scope('Rename Brand to NewBrand globally.', []))).rejects.toBeInstanceOf(ApplicationError);
    expect(await w.execution.readFile(w.id, path)).toBe('Brand Brand');
  });
  it("B: changes only the homepage hero heading, even when another page has the same heading", async () => {
    const source = 'function Home(){return <section className="store-hero"><h1>Shared headline</h1></section>}\nfunction About(){return <section className="hero"><h1>Shared headline</h1></section>}', w = await workspace({ [path]: source });
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Shared headline', 'A new direction')] }, scope('Change the homepage hero heading to "A new direction".'));
    expect(await w.execution.readFile(w.id, path)).toBe(source.replace('<h1>Shared headline</h1>', '<h1>A new direction</h1>'));
  });
  it("B: a hero description can be isolated without changing repeated footer copy", async () => {
    const source = 'function Home(){return <><section className="hero"><p>Repeated copy</p></section><footer><p>Repeated copy</p></footer></>}', w = await workspace({ [path]: source });
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Repeated copy', 'Thoughtfully made')] }, scope('Update the homepage hero description to "Thoughtfully made".'));
    expect(await w.execution.readFile(w.id, path)).toBe(source.replace('<p>Repeated copy</p>', '<p>Thoughtfully made</p>'));
  });
  it("does not mistake another named component in HomePage.jsx for the homepage", async () => {
    const file = 'src/HomePage.jsx', source = 'function About(){return <section className="hero"><h1>Same</h1></section>} function Footer(){return <h1>Same</h1>}', w = await workspace({ [file]: source });
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Same', 'New title', file)] }, scope('Change the homepage hero heading to "New title".', [file]))).rejects.toBeInstanceOf(ApplicationError);
    expect(await w.execution.readFile(w.id, file)).toBe(source);
  });
  it.each([
    'Change the hero heading to "New title".', // Both heroes satisfy the same constraint.
    'Change the homepage hero heading.', // No requested replacement to bind the clause.
    'Change the homepage hero heading to "Something else".',
  ])("refuses insufficient contextual proof: %s", async instruction => {
    const source = 'function Home(){return <section className="hero"><h1>Same</h1><h1>Same</h1></section>}', w = await workspace({ [path]: source });
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Same', 'New title')] }, scope(instruction))).rejects.toBeInstanceOf(ApplicationError);
    expect(await w.execution.readFile(w.id, path)).toBe(source);
  });
  it("C: identical CSS values change only the explicitly named selector and property", async () => {
    const file = 'src/styles.css', source = '.hero{color:#ffffff;border-color:#ffffff}.footer{color:#ffffff}', w = await workspace({ [file]: source });
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('#ffffff', '#292929', file)] }, scope('Change .hero color to #292929.', [file]));
    expect(await w.execution.readFile(w.id, file)).toBe('.hero{color:#292929;border-color:#ffffff}.footer{color:#ffffff}');
  });
  it("C: an unspecified accent does not authorize every duplicate CSS value", async () => {
    const file = 'src/styles.css', source = ':root{--accent:#ffffff;--paper:#ffffff}', w = await workspace({ [file]: source });
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('#ffffff', '#292929', file)] }, scope('Change the primary accent to #292929.', [file]))).rejects.toBeInstanceOf(ApplicationError);
    expect(await w.execution.readFile(w.id, file)).toBe(source);
  });
  it("D: identical product labels require a real product-specific anchor", async () => {
    const source = 'const products=[{id:"one",name:"Classic"},{id:"two",name:"Classic"}]', w = await workspace({ [path]: source });
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Classic', 'Premium')] }, scope('Change one product title to "Premium".'))).rejects.toBeInstanceOf(ApplicationError);
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('{id:"two",name:"Classic"}', '{id:"two",name:"Premium"}')] });
    expect(await w.execution.readFile(w.id, path)).toBe('const products=[{id:"one",name:"Classic"},{id:"two",name:"Premium"}]');
  });
  it("E/I: a later unsafe patch leaves every file unchanged, not partly applied", async () => {
    const source = '<h1>Same</h1><h2>Same</h2>', w = await workspace({ [path]: source, 'index.html': '<title>Before</title>' });
    const error = await rejection(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Before', 'After', 'index.html'), patch('Same', 'Changed')] }));
    expect(await w.execution.readFile(w.id, 'index.html')).toBe('<title>Before</title>');
    expect(await w.execution.readFile(w.id, path)).toBe(source);
    const metadata = JSON.stringify(error.metadata);
    expect(metadata).not.toContain('Same'); expect(metadata).not.toContain('Changed');
    expect(metadata).toContain(editTextDigest('Same'));
    expect(error.metadata?.patchDiagnostics).toMatchObject([
      { resolution: 'EXACT_UNIQUE' }, { resolution: 'REJECTED_AMBIGUITY', matchCount: 2, requestedMode: 'unique', locations: [{ line: 1, column: 5 }, { line: 1, column: 18 }] },
    ]);
  });
  it.each(['unique', 'all'] as const)("F: does not cascade into text introduced by earlier patches (%s)", async mode => {
    const source = '<h2>Alpha</h2><h2>Beta</h2>', w = await workspace({ [path]: source });
    const error = await rejection(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Beta', 'Alpha', path, 'all'), patch('Alpha', 'Gamma', path, mode)] }));
    expect(error.metadata?.patchDiagnostics).toMatchObject([{ resolution: 'REQUESTED_ALL' }, { resolution: 'REJECTED_CASCADE' }]);
    expect(await w.execution.readFile(w.id, path)).toBe(source);
  });
  it("F: rebasing a uniquely anchored hero after a recovered global rename remains supported", async () => {
    const hero = '<h1>Brand welcomes you</h1>', source = hero + '<footer>Brand</footer>', w = await workspace({ [path]: source });
    await applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Brand', 'Nova'), patch(hero, '<h1>Nova, thoughtfully built</h1>')] }, scope('Rename "Brand" to "Nova" globally.'));
    expect(await w.execution.readFile(w.id, path)).toBe('<h1>Nova, thoughtfully built</h1><footer>Nova</footer>');
  });
  it("G: a correct exact anchor does not need speculative recovery", async () => {
    const source = '<h1>Same</h1><h2>Same</h2>', w = await workspace({ [path]: source });
    await applySiteEditPatchBundle(w.execution, w.id, validateSiteEditPatchBundle({ patches: [patch('<h2>Same</h2>', '<h2>Changed</h2>')] }));
    expect(await w.execution.readFile(w.id, path)).toBe('<h1>Same</h1><h2>Changed</h2>');
  });
  it("F: deleting characters must not manufacture a target for the next patch", async () => {
    const source = 'AlXpha Alpha', w = await workspace({ [path]: source });
    await expect(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('X', ''), patch('Alpha', 'Gamma', path, 'all')] })).rejects.toBeInstanceOf(ApplicationError);
    expect(await w.execution.readFile(w.id, path)).toBe(source);
  });
});

describe("Private bounded ambiguity diagnostics", () => {
  it("passes the server-generated outer job ID to the existing edit executor", async () => {
    const jobs = new DevJobManager(new InMemoryProgressBus());
    let receivedId: string | undefined;
    let expectedId: string | undefined;
    const completed = new Promise<void>(resolve => {
      const job = jobs.start('EDIT', async (_intelligence, outerRequestId) => {
        receivedId = outerRequestId;
        return { projectId: 'offline-project', versionId: 'offline-version' };
      });
      jobs.subscribe(job.id, event => { if (event.type === 'JOB_COMPLETED') resolve(); });
      expectedId = job.id;
    });
    await completed;
    expect(receivedId).toBe(expectedId);
    expect(receivedId).toMatch(/^[a-f0-9-]{36}$/);
    expect(jobs.get(receivedId!)?.status).toBe('SUCCEEDED');
  });
  it("whitelists metadata instead of serializing arbitrary patch or prompt fields", async () => {
    const root = await mkdtemp(join(tmpdir(), 'sites-patch-whitelist-'));
    try {
      const w = await workspace({ [path]: 'private source' }), evidence = new LocalFailedCandidateEvidence(root);
      await evidence.preserve({ execution: w.execution, environmentId: w.id, jobId: 'whitelist', siteId: 'offline',
        outerRequestId: 'private prompt must not become an ID', editAttempt: 99, repairRequirements: ['rename', 'private prompt'],
        validationFailure: { failureStage: 'PATCH_APPLICATION', check: 'edit.patch-resolution', code: 'VALIDATION_FAILED', message: 'Rejected duplicate patch', buildPassed: false },
        patchDiagnostics: [{ path, findDigest: editTextDigest('example'), requestedMode: 'unique', resolution: 'REJECTED_AMBIGUITY',
          find: 'private find', replace: 'private replace', prompt: 'private prompt', locations: [{ line: 1, column: 1, offset: 0, source: 'private location' }] }],
      });
      const serialized = await readFile(join(root, (await readdir(root))[0]!), 'utf8');
      expect(serialized).not.toContain('private'); expect(serialized).toContain('REJECTED_AMBIGUITY');
      expect(serialized).not.toContain('outerRequestId'); expect(serialized).not.toContain('editAttempt');
    } finally { await cleanupTemporaryRoot(root); }
  });
  it("retains runtime match metadata without source/patch text or a second model request", async () => {
    const root = await mkdtemp(join(tmpdir(), 'sites-patch-evidence-'));
    try {
      const w = await workspace({ [path]: 'export default function App(){return <><h1>Private repeated text</h1><h2>Private repeated text</h2></>}' });
      const provider = new MockAgentProvider({ customResponse: request => ({ id: 'offline', model: request.model, message: { role: 'assistant', content: JSON.stringify({ patches: [patch('Private repeated text', 'Private replacement')] }) }, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 0, finishReason: 'stop' }) });
      const registry = new AgentProviderRegistry(); registry.register(provider);
      const evidence = new LocalFailedCandidateEvidence(root);
      const runtime = new LocalCliAgentRuntime(new InProcessAgentGateway(registry), registry, w.execution as never, undefined, { evidence });
      await expect(runtime.run(w.id, { jobId: 'offline-patch-evidence', siteId: 'isolated', operation: 'EDIT_SITE', runtime: 'LOCAL_CLI', agentProvider: provider.id, userRequest: 'Change a heading.' })).rejects.toBeInstanceOf(ApplicationError);
      expect(provider.callCount).toBe(1);
      const names = await readdir(root); expect(names).toHaveLength(1);
      const serialized = await readFile(join(root, names[0]!), 'utf8');
      expect(serialized).toContain('offline-patch-evidence'); expect(serialized).toContain('REJECTED_AMBIGUITY');
      expect(serialized).toContain(editTextDigest('Private repeated text'));
      expect(serialized).not.toContain('Private repeated text'); expect(serialized).not.toContain('Private replacement');
      const parsed = JSON.parse(serialized) as { source: { files: Record<string, string> } };
      expect(parsed.source.files).toEqual({});
      expect(createDevelopmentFailedCandidateEvidence(root, 'production')).toBeUndefined();
    } finally { await cleanupTemporaryRoot(root); }
  });
  it("reproduces real Ecommerce duplicate locations without claiming an original retained patch", async () => {
    const source = await readFile('templates/ecommerce-store/src/App.jsx', 'utf8'), w = await workspace({ [path]: source });
    expect(source.match(/Atelier Row/g)).toHaveLength(2);
    const error = await rejection(applySiteEditPatchBundle(w.execution, w.id, { patches: [patch('Atelier Row', 'North & Loom')] }));
    expect(error.metadata?.matches).toBe(2);
    expect(await w.execution.readFile(w.id, path)).toBe(source);
  });
});
