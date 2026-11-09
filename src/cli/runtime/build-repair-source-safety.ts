import ts from "typescript";

function parse(path: string, content: string) {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$|\.js$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] };
}

/** Only a redundant, consecutive closing tag is eligible. Never infer an
 * opening wrapper, rename a tag, rewrite text, or choose between valid outputs. */
export function redundantJsxClosingRepair(path: string, content: string): { readonly content: string; readonly line: number; readonly column: number } | undefined {
  if (!/\.[jt]sx$|\.js$/.test(path) || Buffer.byteLength(content) > 256 * 1024) return;
  const source = parse(path, content);
  if (!source.parseDiagnostics.some(diagnostic => diagnostic.code === 17002)) return;
  const closes: ts.JsxClosingElement[] = [], mismatched: ts.JsxClosingElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxClosingElement(node)) closes.push(node);
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) !== node.closingElement.tagName.getText(source)) mismatched.push(node.closingElement);
    ts.forEachChild(node, visit);
  };
  visit(source); closes.sort((a, b) => a.end - b.end);
  if (mismatched.length > 8) return;
  const candidates = new Map<string, number>();
  for (const close of mismatched) {
    const start = close.getStart(source), previous = closes.filter(item => item.end <= start).at(-1);
    if (!previous || previous.tagName.getText(source) !== close.tagName.getText(source) || content.slice(previous.end, start).trim()) continue;
    const next = content.slice(0, start) + content.slice(close.end);
    if (!parse(path, next).parseDiagnostics.length) candidates.set(next, start);
  }
  if (candidates.size !== 1) return;
  const [next, offset] = [...candidates][0]!;
  if (compilerRepairSourceIssue(path, content, next)) return;
  const position = source.getLineAndCharacterOfPosition(offset);
  return { content: next, line: position.line + 1, column: position.character + 1 };
}

/** Parser-located evidence for build repair. Compiler output can name only a
 * secondary symptom (e.g. TS1003 at `</>`) or be truncated; the TypeScript parser
 * on the current source gives the exact positions of the first syntax errors and
 * of each JSX element whose closing tag does not match its opening tag. */
export function compilerSourceDiagnostics(files: readonly { readonly path: string; readonly content: string }[], maxBytes = 1_500): string {
  const findings: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    const bytes = Buffer.byteLength(line) + 1;
    if (used + bytes > maxBytes) return false;
    findings.push(line); used += bytes; return true;
  };
  for (const file of files) {
    if (!/\.[jt]sx?$/.test(file.path) || Buffer.byteLength(file.content) > 256 * 1024) continue;
    const source = parse(file.path, file.content);
    if (!source.parseDiagnostics.length) continue;
    const at = (offset: number) => { const p = source.getLineAndCharacterOfPosition(offset); return `${file.path}:${p.line + 1}:${p.character + 1}`; };
    const excerpt = (start: number, end: number) => JSON.stringify(file.content.slice(Math.max(0, start - 40), Math.min(file.content.length, end + 40)).replace(/\s+/g, " "));
    for (const diagnostic of source.parseDiagnostics.slice(0, 2))
      if (!push(`${at(diagnostic.start ?? 0)} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)) return findings.join("\n");
    const mismatched: ts.JsxElement[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) !== node.closingElement.tagName.getText(source)) mismatched.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Innermost (earliest-closing) mismatch first: outer mismatches are usually recovery cascades.
    mismatched.sort((a, b) => a.closingElement.getStart(source) - b.closingElement.getStart(source));
    for (const element of mismatched.slice(0, 3)) {
      const tag = element.openingElement.tagName.getText(source), opening = element.openingElement.getStart(source);
      const close = element.closingElement, closeStart = close.getStart(source), closeTag = close.tagName.getText(source);
      const line = close.end > closeStart
        ? `JSX <${tag}> opened at ${at(opening)} is closed by </${closeTag}> at ${at(closeStart)}; opening context ${excerpt(opening, element.openingElement.end)}; closing context ${excerpt(closeStart, close.end)}`
        : `JSX <${tag}> opened at ${at(opening)} has no closing tag before ${at(closeStart)}; opening context ${excerpt(opening, element.openingElement.end)}`;
      if (!push(line)) return findings.join("\n");
    }
  }
  return findings.join("\n");
}

interface Control { readonly key: string; readonly required: boolean; readonly disabled: boolean; readonly readOnly: boolean; readonly hidden: boolean; readonly handlers: readonly string[]; readonly bindings: readonly string[] }
function formControls(source: ts.SourceFile): Control[] {
  const controls: Control[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (["form", "input", "select", "textarea"].includes(tag)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const attr = (name: string) => attributes.find(item => item.name.getText(source) === name);
        const value = (name: string) => { const init = attr(name)?.initializer; return !init ? "" : ts.isStringLiteral(init) ? init.text : init.getText(source); };
        const enabled = (name: string) => { const attribute = attr(name), init = attribute?.initializer; return !!attribute && !(init && ts.isJsxExpression(init) && init.expression?.kind === ts.SyntaxKind.FalseKeyword); };
        let owner = "module";
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (ts.isFunctionDeclaration(parent) && parent.name) { owner = parent.name.text; break; }
          if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) { owner = parent.parent.name.text; break; }
        }
        controls.push({ key: JSON.stringify([owner, tag, value("name") || value("id") || value("aria-label"), tag === "input" ? value("type") || "text" : ""]),
          required: enabled("required"), disabled: enabled("disabled"), readOnly: enabled("readOnly"), hidden: enabled("hidden") || value("aria-hidden") === "true",
          handlers: ["onChange", "onInput", "onSubmit"].filter(name => !!attr(name)), bindings: ["value", "checked"].filter(name => !!attr(name)) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return controls;
}

/** Compiler repair cannot simplify away existing controls. Compare a multiset
 * scoped to the owning component; an unrelated form cannot stand in for it. */
export function compilerRepairSourceIssue(path: string, before: string, after: string): { readonly reason: string; readonly message: string } | undefined {
  if (!/\.[jt]sx?$/.test(path)) return;
  const source = parse(path, after);
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0]!, position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return { reason: "REPAIR_SOURCE_SYNTAX_INVALID", message: `Build repair leaves invalid syntax in ${path}:${position.line + 1}:${position.character + 1} (TS${diagnostic.code})` };
  }
  const next = formControls(source), original = formControls(parse(path, before));
  const assigned = new Map<number, number>();
  const match = (index: number, visited: Set<number>): boolean => {
    const control = original[index]!;
    for (const [candidate, afterControl] of next.entries()) {
      if (visited.has(candidate) || afterControl.key !== control.key || control.required && !afterControl.required ||
        !control.disabled && afterControl.disabled || !control.readOnly && afterControl.readOnly || !control.hidden && afterControl.hidden ||
        !control.handlers.every(handler => afterControl.handlers.includes(handler)) || !control.bindings.every(binding => afterControl.bindings.includes(binding))) continue;
      visited.add(candidate);
      const previous = assigned.get(candidate);
      if (previous === undefined || match(previous, visited)) { assigned.set(candidate, index); return true; }
    }
    return false;
  };
  for (const index of original.keys()) if (!match(index, new Set()))
    return { reason: "REPAIR_FORM_CONTROL_REMOVED", message: `Build repair removes or weakens an existing form control, validation or handler in ${path}` };
}
