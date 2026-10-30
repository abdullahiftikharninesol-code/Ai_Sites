import { describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../src/app/errors/application-error.js";
import { MockExecutionProvider } from "../src/execution/mock-execution-provider.js";
import { applyBuildRepairPatchBundle, validateBuildRepairPatchBundle } from "../src/cli/runtime/site-coder-file-bundle.js";
import { createBuildRepairSourceSnapshot } from "../src/cli/runtime/build-repair-source.js";
import { validateReferenceInteractions } from "../src/cli/runtime/reference-interaction-validator.js";
import { siteFailureStage } from "../src/sites/generation/site-token-usage-log.js";
import { retainedPattern } from "./fixtures/build-repair-sites.js";
import { compilerRepairSourceIssue, redundantJsxClosingRepair } from "../src/cli/runtime/build-repair-source-safety.js";
import { retainedVertexBundle, rejectedVertexRepair, retainedVertexSourceDigest } from "./fixtures/vertex-jsx-failure.js";
import { repairDigest } from "../src/cli/runtime/build-repair-source.js";

const path = "src/App.tsx";
const digest: unknown = expect.stringMatching(/^[a-f0-9]{64}$/);
const patch = (find: string, replace: string, file = path) => ({ path: file, find, replace });
async function workspace(content: string, other: Record<string, string> = {}) {
  const execution = new MockExecutionProvider(), environment = await execution.createEnvironment({});
  for (const [file, text] of Object.entries({ [path]: content, ...other })) await execution.writeFile(environment.id, file, text);
  const files = Object.entries({ [path]: content, ...other }).map(([path, content]) => ({ path, content }));
  const snapshot = createBuildRepairSourceSnapshot(files, `${path}:2 compiler error`);
  const apply = (patches: ReturnType<typeof patch>[]) => applyBuildRepairPatchBundle(execution, environment.id, { patches }, snapshot);
  return { execution, environmentId: environment.id, snapshot, apply, read: () => execution.readFile(environment.id, path) };
}

describe("Actual Vertex JSX failure and compiler-repair preservation", () => {
  const original = retainedVertexBundle.files.find(file => file.path === path)!.content;
  it("reproduces the exact retained source identity and repairs only its redundant closing token", () => {
    expect(repairDigest(original)).toBe(retainedVertexSourceDigest);
    const repaired = redundantJsxClosingRepair(path, original)!;
    expect(repaired).toBeDefined();
    expect(repaired.line).toBe(96);
    expect(repaired.content).toBe(original.replace('</form>}</div></div></section></main>', '</form>}</div></section></main>'));
    expect(compilerRepairSourceIssue(path, original, repaired.content)).toBeUndefined();
    for (const name of ["name", "email", "company", "service", "budget", "message"]) expect(repaired.content).toContain(`name="${name}"`);
    expect(redundantJsxClosingRepair(path, repaired.content)).toBeUndefined();
  });
  it.each(["div", "article", "aside"])("handles another container and CRLF without rewriting unrelated bytes: %s", tag => {
    const source = `export function App(){\r\nreturn <main><section><${tag}><p>Keep this text.</p></${tag}></${tag}></section></main>;\r\n}`;
    expect(redundantJsxClosingRepair(path, source)?.content).toBe(source.replace(`</${tag}></${tag}>`, `</${tag}>`));
  });
  it.each([
    'export function App(){return <main><div><div>Valid nesting</div></div></main>}',
    'export function App(){return <main><section>Wrong tag</div></main>}',
    'export function App(){return <main><section><div>A</div></div></section><article><span>B</span></span></article></main>}',
    'const text="</div></div>"; /* </div></div> */ export function App(){return <p>{text}</p>}',
    'const broken = ; export function App(){return <main><section><div>A</div></div></section></main>}',
  ])("leaves valid, ambiguous or unrelated syntax untouched: %s", source => {
    expect(redundantJsxClosingRepair(path, source)).toBeUndefined();
  });
  it("rejects the exact invalid model repair atomically instead of calling it applied", async () => {
    const h = await workspace(original, { "src/other.ts": "export const n=1;" });
    const snapshot = createBuildRepairSourceSnapshot([{ path, content: original }, { path: "src/other.ts", content: "export const n=1;" }], "", Number.MAX_SAFE_INTEGER);
    await expect(applyBuildRepairPatchBundle(h.execution, h.environmentId, { patches: [patch("n=1", "n=2", "src/other.ts"), ...rejectedVertexRepair.patches] }, snapshot, undefined, { compilerSafety: true }))
      .rejects.toMatchObject({ metadata: { reason: "REPAIR_SOURCE_SYNTAX_INVALID", failureStage: "PATCH_APPLICATION" } });
    expect(await h.read()).toBe(original); expect(await h.execution.readFile(h.environmentId, "src/other.ts")).toBe("export const n=1;");
  });
  it("rejects the same form simplification even if its JSX is corrected", async () => {
    const modelPatch = rejectedVertexRepair.patches[0]!;
    const after = original.replace(modelPatch.find, modelPatch.replace);
    const corrected = redundantJsxClosingRepair(path, after)!.content;
    expect(compilerRepairSourceIssue(path, original, corrected)?.reason).toBe("REPAIR_FORM_CONTROL_REMOVED");
    const h = await workspace(original), snapshot = createBuildRepairSourceSnapshot([{ path, content: original }], "", Number.MAX_SAFE_INTEGER);
    await expect(applyBuildRepairPatchBundle(h.execution, h.environmentId, { patches: [patch(original, corrected)] }, snapshot, undefined, { compilerSafety: true }))
      .rejects.toMatchObject({ metadata: { reason: "REPAIR_FORM_CONTROL_REMOVED" } });
    expect(await h.read()).toBe(original);
  });
  it.each([
    ['required onChange={()=>{}}', 'onChange={()=>{}}'],
    ['required onChange={()=>{}}', 'required'],
    ['name="email" required', 'name="other" required'],
    ['name="email"', 'name="email" disabled'],
    ['name="email"', 'name="email" readOnly'],
    ['name="email"', 'name="email" hidden'],
    ['name="email"', 'name="email" aria-hidden="true"'],
    ['name="email" value={"demo"}', 'name="email"'],
  ])("rejects removal of validation, handlers or field identity", (before, after) => {
    const source = `export function Contact(){return <form><input ${before}/></form>}`;
    expect(compilerRepairSourceIssue(path, source, source.replace(before, after))?.reason).toBe("REPAIR_FORM_CONTROL_REMOVED");
  });
  it("handles repeated field names by a constraint-preserving multiset, independent of order", () => {
    const before = 'function Contact(){return <form><input name="email" required/><input name="email" onChange={()=>{}}/></form>}';
    const after = 'function Contact(){return <form><input name="email" required onChange={()=>{}}/><input name="email" required/></form>}';
    expect(compilerRepairSourceIssue(path, before, after)).toBeUndefined();
  });
  it("does not treat explicitly false boolean attributes as lost validation or disabled fields", () => {
    const before = 'function Contact(){return <form><input name="company" required={ false }/></form>}';
    const after = 'function Contact(){return <form><input name="company" disabled={false}/></form>}';
    expect(compilerRepairSourceIssue(path, before, after)).toBeUndefined();
  });
});

describe("Snapshot-bound atomic Build Repair", () => {
  it("applies an exact unique compiler correction and preserves the rest", async () => {
    const source = 'const n: number = "4";\nexport const label = "Vertex";';
    const h = await workspace(source);
    await h.apply([patch('const n: number = "4";', 'const n: number = 4;')]);
    expect(await h.read()).toBe(source.replace('"4"', "4"));
  });
  it("requires unique surrounding context when a value repeats", async () => {
    const h = await workspace('const first = "old";\nconst second = "old";');
    await h.apply([patch('const second = "old";', 'const second = "new";')]);
    expect(await h.read()).toBe('const first = "old";\nconst second = "new";');
  });
  it("maps LF anchors to CRLF source without rewriting unrelated line endings", async () => {
    const h = await workspace('const a = 1;\r\nconst b = 2;\r\nconst untouched = 3;\r\n');
    await h.apply([patch('const a = 1;\nconst b = 2;', 'const a = 4;\nconst b = 2;')]);
    expect(await h.read()).toBe('const a = 4;\nconst b = 2;\r\nconst untouched = 3;\r\n');
  });
  it("permits only proved indentation differences between code tokens", async () => {
    const h = await workspace('function f(){\n    const a = 1;\n    return a;\n}\n');
    await h.apply([patch('function f(){\n  const a = 1;\n  return a;\n}', 'function f(){\n  const a = 2;\n  return a;\n}')]);
    expect(await h.read()).toContain("const a = 2");
  });
  it.each([
    ['const text = `a\n    b`;', 'const text = `a\n  b`;'],
    ['const view = <div>\n    visible text\n</div>;', 'const view = <div>\n  visible text\n</div>;'],
    ['/* note\n    content */\nconst n = 1;', '/* note\n  content */\nconst n = 1;'],
  ])("rejects indentation changes in significant text or comments", async (source, find) => {
    const h = await workspace(source);
    await expect(h.apply([patch(find, "unrelated")])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await h.read()).toBe(source);
  });
  it("rejects a changed revision without overwriting the newer source", async () => {
    const h = await workspace("const value = 1;");
    await h.execution.writeFile(h.environmentId, path, "const value = 3;");
    await expect(h.apply([patch("const value = 1;", "const value = 2;")])).rejects.toMatchObject({ metadata: { reason: "SOURCE_REVISION_CHANGED", failureStage: "PATCH_APPLICATION", currentSourceRevision: digest } });
    expect(await h.read()).toBe("const value = 3;");
  });
  it("rejects absent text with file/digest/match diagnostics, not a fuzzy replacement", async () => {
    const h = await workspace("const value = 1;");
    await expect(h.apply([patch("const invented = 1;", "const value = 2;")])).rejects.toMatchObject({ metadata: {
      path, reason: "MISSING_FIND_TEXT", patchDiagnostics: [{ matchCount: 0, findDigest: digest, locations: [] }],
    } });
    expect(await h.read()).toBe("const value = 1;");
  });
  it("rechecks the source before writing and preserves a concurrent change during preflight", async () => {
    const h = await workspace("const value = 1;");
    const original = h.execution.readFile.bind(h.execution);
    let reads = 0;
    vi.spyOn(h.execution, "readFile").mockImplementation(async (env, file) => {
      if (++reads === 2) await h.execution.writeFile(env, file, "const value = 99;");
      return original(env, file);
    });
    await expect(h.apply([patch("const value = 1;", "const value = 2;")])).rejects.toMatchObject({ metadata: { reason: "SOURCE_REVISION_CHANGED" } });
    expect(await h.read()).toBe("const value = 99;");
  });
  it("does not apply a real but unsupplied anchor from an omitted source window", async () => {
    const source = Array.from({ length: 100 }, (_, index) => `export const value${index} = ${index};`).join("\n");
    const h = await workspace(source);
    const snapshot = createBuildRepairSourceSnapshot([{ path, content: source }], `${path}:1`, 500);
    await expect(applyBuildRepairPatchBundle(h.execution, h.environmentId, { patches: [patch("export const value99 = 99;", "export const value99 = 100;")] }, snapshot))
      .rejects.toMatchObject({ metadata: { reason: "ANCHOR_NOT_SUPPLIED" } });
    expect(await h.read()).toBe(source);
  });
  it("never picks an arbitrary duplicate", async () => {
    const h = await workspace('const a="same";\nconst b="same";');
    await expect(h.apply([patch('"same"', '"new"')])).rejects.toMatchObject({ metadata: { reason: "AMBIGUOUS_FIND_TEXT", patchDiagnostics: [{ matchCount: 2, locations: [{ line: 1 }, { line: 2 }] }] } });
    expect(await h.read()).toContain('const a="same";');
  });
  it("normalizes an explicit relative Windows path, but never guesses an extension", async () => {
    const h = await workspace("const value = 1;");
    await h.apply([patch("const value = 1;", "const value = 2;", ".\\src\\App.tsx")]);
    const next = await workspace("const value = 1;");
    await expect(next.apply([patch("const value = 1;", "x", "src/App.jsx")])).rejects.toMatchObject({ metadata: { reason: "PATH_NOT_SUPPLIED" } });
    expect(await next.read()).toBe("const value = 1;");
  });
  it("preflights all files before writing: a later bad patch leaves every source intact", async () => {
    const h = await workspace("const first = 1;", { "src/other.ts": "export const other = 2;" });
    await expect(h.apply([patch("const first = 1;", "const first = 3;"), patch("absent", "x", "src/other.ts")])).rejects.toBeInstanceOf(ApplicationError);
    expect(await h.read()).toBe("const first = 1;");
    expect(await h.execution.readFile(h.environmentId, "src/other.ts")).toBe("export const other = 2;");
  });
  it("rejects cascading or overlapping operations instead of silently reordering", async () => {
    const h = await workspace("const first = 1;");
    await expect(h.apply([patch("const first = 1;", "const second = 2;"), patch("const second = 2;", "const third = 3;")])).rejects.toMatchObject({ metadata: { reason: "MISSING_FIND_TEXT" } });
    await expect(h.apply([patch("first", "second"), patch("const first = 1;", "const final = 3;")])).rejects.toMatchObject({ metadata: { reason: "OVERLAPPING_OPERATIONS" } });
    expect(await h.read()).toBe("const first = 1;");
  });
  it("applies independent snapshot anchors on the same file even if earlier replacement shifts offsets", async () => {
    const h = await workspace("const first = 1;\nconst last = 2;");
    await h.apply([patch("const first = 1;", "const muchLongerName = 12345;"), patch("const last = 2;", "const last = 3;")]);
    expect(await h.read()).toBe("const muchLongerName = 12345;\nconst last = 3;");
  });
  it("restores completed writes when the execution adapter fails mid-bundle", async () => {
    const h = await workspace("const first = 1;", { "src/other.ts": "export const other = 2;" });
    const original = h.execution.writeFile.bind(h.execution);
    vi.spyOn(h.execution, "writeFile").mockImplementation(async (env, path, content) => {
      if (path === "src/other.ts") throw new Error("disk error");
      await original(env, path, content);
    });
    await expect(h.apply([patch("const first = 1;", "const first = 3;"), patch("other = 2", "other = 4", "src/other.ts")])).rejects.toThrow("disk error");
    expect(await h.read()).toBe("const first = 1;");
  });
  it.each([null, [], { patches: "bad" }, { patches: [{}] }, { patches: [{ path, find: "", replace: "x" }] }, { patches: [], extra: true }, { patches: [{ path: "../App.tsx", find: "x", replace: "y" }] }, { patches: [{ path: "package.json", find: "x", replace: "y" }] }])("rejects malformed/managed repair responses: %j", value => {
    expect(() => validateBuildRepairPatchBundle(value)).toThrow();
  });
});

describe("Bounded verbatim repair context and retained failure pattern", () => {
  it("retains exact source slices, deduplicates repeated diagnostic lines and never prefixes code with line labels", () => {
    const files = [{ path, content: retainedPattern }], diagnostics = Array(4).fill(`${path}:44`).join("\n") + `\n${path}:50\n${path}:52\n${path}:56`;
    const snapshot = createBuildRepairSourceSnapshot(files, diagnostics, 1800);
    expect(Buffer.byteLength(snapshot.context)).toBeLessThanOrEqual(1800);
    expect(snapshot.context).not.toMatch(/^\d+: /m);
    for (const range of snapshot.files[0]!.excerpts) expect(snapshot.context).toContain(retainedPattern.slice(range.start, range.end));
    expect(snapshot.files[0]!.excerpts.some(range => retainedPattern.slice(range.start, range.end).includes("Local control 56"))).toBe(true);
    expect(createBuildRepairSourceSnapshot(files, diagnostics).revision).toBe(snapshot.revision);
    expect(createBuildRepairSourceSnapshot([{ path, content: retainedPattern + "\n// changed" }], diagnostics).revision).not.toBe(snapshot.revision);
  });
  it("does not cut a long minified line or a multibyte character to fit the budget", () => {
    const source = 'const text = "' + "界".repeat(3000) + '";\nexport const n = 1;';
    const snapshot = createBuildRepairSourceSnapshot([{ path, content: source }], `${path}:1`, 1000);
    expect(snapshot.context).not.toContain("�");
    expect(snapshot.files[0]!.excerpts.every(range => source.slice(range.start, range.end) === "export const n = 1;")).toBe(true);
  });
  it("reproduces the retained seven-inert-control trigger, while safely rejecting a synthetic invented anchor", async () => {
    expect(() => validateReferenceInteractions({ files: [{ path, content: retainedPattern }] })).toThrow(/and 2 more/);
    const h = await workspace(retainedPattern);
    await expect(h.apply([patch('<button onClick={inventedHandler}>Local control</button>', "x")])).rejects.toMatchObject({ metadata: { reason: "MISSING_FIND_TEXT" } });
    expect(await h.read()).toBe(retainedPattern);
    expect(siteFailureStage(new ApplicationError("VALIDATION_FAILED", "missing anchor", { metadata: { failureStage: "PATCH_APPLICATION" } }))).toBe("PATCH_APPLICATION");
  });
});
