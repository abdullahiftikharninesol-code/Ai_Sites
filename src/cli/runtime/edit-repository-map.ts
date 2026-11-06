import { createHash } from "node:crypto";
import ts from "typescript";
import postcss from "postcss";
import { resolveLocalImportPath } from "../../sites/generation/import-validator.js";
import type { EditContextFile } from "./edit-context-selection.js";

export interface EditSourceRegion {
  readonly name: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly owner?: string;
  readonly declares: readonly string[];
  readonly references: readonly string[];
}
export interface EditSourceImport {
  readonly specifier: string;
  readonly bindings: readonly string[];
  readonly target?: string;
}
export interface EditMappedFile extends EditContextFile {
  readonly digest: string;
  readonly regions: readonly EditSourceRegion[];
  readonly imports: readonly EditSourceImport[];
  readonly exports: readonly string[];
  readonly routes: readonly string[];
  readonly signatures: Readonly<Record<string, string>>;
  readonly parseErrors: boolean;
}
export interface EditRepositoryMap {
  readonly files: readonly EditMappedFile[];
  readonly parseHits: number;
  readonly parseMisses: number;
}
type Structure = Omit<EditMappedFile, "path" | "content" | "digest">;
// Store structure/offsets only, not ASTs or duplicate private source. Hashes
// invalidate changed files; a bounded LRU also handles current-only reloads.
const cache = new Map<string, { structure: Structure; bytes: number }>();
let cachedBytes = 0;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_FILES = 128;
export const editSourceDigest = (value: string) => createHash("sha256").update(value).digest("hex");

function bindingNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
}
function declarations(node: ts.Node): string[] {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.flatMap(item => bindingNames(item.name));
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) return [node.name.text];
  if (ts.isImportDeclaration(node) && node.importClause) {
    const c = node.importClause, b = c.namedBindings;
    return [...(c.name ? [c.name.text] : []), ...(b ? ts.isNamespaceImport(b) ? [b.name.text] : b.elements.map(item => item.name.text) : [])];
  }
  return [];
}
function identifiers(node: ts.Node): string[] {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => { if (ts.isIdentifier(n)) names.add(n.text); ts.forEachChild(n, visit); };
  visit(node); return [...names];
}
function parseStructure(path: string, content: string): Structure {
  if (path.endsWith(".css")) {
    try {
      const css = postcss.parse(content);
      return { regions: css.nodes.map(node => ({ name: node.type === "rule" ? node.selector : node.type === "atrule" ? `@${node.name} ${node.params}` : node.type,
        kind: "css", start: node.source!.start!.offset!, end: node.source!.end!.offset! + 1, declares: [], references: [] })), imports: [], exports: [], routes: [], signatures: {}, parseErrors: false };
    } catch { return { regions: [], imports: [], exports: [], routes: [], signatures: {}, parseErrors: true }; }
  }
  if (!/\.[jt]sx?$/.test(path)) return { regions: [], imports: [], exports: [], routes: [], signatures: {}, parseErrors: false };
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const regions: EditSourceRegion[] = [], imports: EditSourceImport[] = [], exports: string[] = [], routes = new Set<string>();
  const signatures: Record<string, string> = {};
  const add = (node: ts.Node, owner?: string): void => {
    const names = declarations(node);
    regions.push({ name: names.join(",") || (ts.isExportAssignment(node) ? "default" : ts.SyntaxKind[node.kind]),
      kind: ts.SyntaxKind[node.kind], start: node.getStart(source), end: node.end,
      ...(owner ? { owner } : {}), declares: names, references: identifiers(node) });
  };
  const nested = (node: ts.Node, owner: string): void => {
    if (ts.isBlock(node)) for (const child of node.statements) {
      if (ts.isVariableStatement(child) || ts.isFunctionDeclaration(child) || ts.isReturnStatement(child)) add(child, owner);
    }
    if (ts.isJsxElement(node) && ["section", "main", "header", "footer", "nav", "article", "aside", "form"].includes(node.openingElement.tagName.getText(source))) {
      regions.push({ name: node.openingElement.getText(source).slice(0, 160), kind: "JSX", start: node.getStart(source), end: node.end,
        owner, declares: [], references: identifiers(node) });
    }
    ts.forEachChild(node, child => nested(child, owner));
  };
  for (const statement of source.statements) {
    add(statement);
    if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.push(...declarations(statement));
    if (ts.isExportAssignment(statement)) exports.push("default");
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier))
      imports.push({ specifier: statement.moduleSpecifier.text, bindings: declarations(statement) });
    if (!ts.isImportDeclaration(statement)) nested(statement, declarations(statement)[0] ?? "default");
    const functionNode = ts.isFunctionDeclaration(statement) ? statement : ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(item => item.initializer).find(item => item && (ts.isArrowFunction(item) || ts.isFunctionExpression(item))) : undefined;
    if (functionNode && (ts.isFunctionDeclaration(functionNode) || ts.isArrowFunction(functionNode) || ts.isFunctionExpression(functionNode)) && functionNode.body)
      signatures[declarations(statement)[0] ?? "default"] = content.slice(statement.getStart(source), functionNode.body.getStart(source));
  }
  const detectRoutes = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      imports.push({ specifier: node.arguments[0].text, bindings: [] });
    if (ts.isJsxAttribute(node) && /^(path|href|to)$/.test(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && node.initializer.text.startsWith("/")) routes.add(node.initializer.text);
    if (ts.isPropertyAssignment(node) && /^(path|route)$/.test(node.name.getText(source)) && ts.isStringLiteral(node.initializer) && node.initializer.text.startsWith("/")) routes.add(node.initializer.text);
    ts.forEachChild(node, detectRoutes);
  };
  detectRoutes(source);
  return { regions, imports, exports, routes: [...routes], signatures, parseErrors: (source as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length > 0 };
}

export function mapEditRepository(files: readonly EditContextFile[], existingPaths: readonly string[] = files.map(f => f.path)): EditRepositoryMap {
  const paths = new Set(existingPaths);
  let parseHits = 0, parseMisses = 0;
  const mapped = [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => {
    const digest = editSourceDigest(file.content), key = `${file.path}:${digest}`;
    let value = cache.get(key);
    if (value) { parseHits++; cache.delete(key); cache.set(key, value); }
    else {
      parseMisses++; value = { structure: parseStructure(file.path, file.content), bytes: Buffer.byteLength(file.content) };
      if (value.bytes <= MAX_CACHE_BYTES) {
        cache.set(key, value); cachedBytes += value.bytes;
        while (cache.size > MAX_CACHE_FILES || cachedBytes > MAX_CACHE_BYTES) {
          const oldest = cache.entries().next().value!; cache.delete(oldest[0]); cachedBytes -= oldest[1].bytes;
        }
      }
    }
    return { ...file, digest, ...value.structure, imports: value.structure.imports.map(item => {
      const target = item.specifier.startsWith(".") ? resolveLocalImportPath(file.path, item.specifier, paths) : undefined;
      return { ...item, ...(target ? { target } : {}) };
    }) };
  });
  return { files: mapped, parseHits, parseMisses };
}

export function renderEditRepositoryMap(map: EditRepositoryMap, maxBytes = 6_000, priority: readonly string[] = []): string {
  const ordered = [...map.files].sort((a, b) => (priority.includes(a.path) ? 0 : 1) - (priority.includes(b.path) ? 0 : 1) || a.path.localeCompare(b.path));
  const lines = ["REPOSITORY MAP (structure only; source anchors below are authoritative)"];
  for (const file of ordered) {
    const names = [...new Set(file.regions.filter(r => !r.owner).flatMap(r => r.declares))].slice(0, 18);
    const text = `${file.path}: ${names.join(", ") || "source"}; exports=${file.exports.slice(0, 8).join(",")}; imports=${file.imports.slice(0, 8).map(i => i.target ?? i.specifier).join(",")}; routes=${file.routes.slice(0, 10).join(",")}`;
    if (Buffer.byteLength([...lines, text].join("\n")) > maxBytes - 100) { lines.push(`Map abbreviated; ${map.files.length} project files in total.`); break; }
    lines.push(text);
  }
  return lines.join("\n");
}
