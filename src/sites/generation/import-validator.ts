import ts from "typescript";
import { posix } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { ResolvedDependencyManifest } from "./resolved-dependency-manifest.js";

export type ImportDiagnosticCode =
  | "UNAPPROVED_DEPENDENCY_IMPORT"
  | "UNKNOWN_PACKAGE_IMPORT"
  | "NODE_BUILTIN_NOT_ALLOWED"
  | "DYNAMIC_IMPORT_NOT_ALLOWED"
  | "PACKAGE_SUBPATH_NOT_ALLOWED";

export interface ImportDiagnostic {
  readonly code: ImportDiagnosticCode;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
  readonly packageRoot?: string;
  readonly message: string;
}

export interface GeneratedImportValidatorOptions {
  readonly allowedAliases?: Readonly<Record<string, readonly string[]>>;
  readonly allowedPackageSubpaths?: Readonly<Record<string, readonly string[]>>;
  readonly allowNodeBuiltins?: boolean;
  /**
   * Approved optional packages the generated site may import. They are installed
   * only when actually imported, so they are absent from the resolved manifest
   * until then. Anything outside this set still fails exactly as before.
   */
  readonly approvedPackages?: Readonly<Record<string, string>>;
}

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const nodeBuiltins = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

export class GeneratedImportValidator {
  constructor(
    private readonly manifest: ResolvedDependencyManifest,
    private readonly options: GeneratedImportValidatorOptions = {},
  ) {}

  async validate(execution: ExecutionProvider, environmentId: string): Promise<void> {
    const diagnostics = await this.scan(execution, environmentId);
    const first = diagnostics[0];
    if (first)
      throw new ApplicationError(first.code, first.message, {
        metadata: {
          path: first.path,
          line: first.line,
          column: first.column,
          specifier: first.specifier,
          ...(first.packageRoot ? { packageRoot: first.packageRoot } : {}),
        },
      });
  }

  async scan(
    execution: ExecutionProvider,
    environmentId: string,
  ): Promise<readonly ImportDiagnostic[]> {
    const entries = (await execution.listFiles(environmentId)).filter(
      (entry) => entry.type === "FILE",
    );
    const files = new Set(entries.map((entry) => entry.path.replaceAll("\\", "/")));
    const diagnostics: ImportDiagnostic[] = [];
    for (const path of files) {
      if (!path.startsWith("src/") || !sourceExtensions.has(posix.extname(path))) continue;
      const source = await execution.readFile(environmentId, path);
      const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const add = (node: ts.Node, specifier: string): void => {
        const diagnostic = this.validateSpecifier(path, sourceFile, node, specifier, files);
        if (diagnostic) diagnostics.push(diagnostic);
      };
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          add(node.moduleSpecifier, node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) add(argument, argument.text);
          else if (argument) diagnostics.push(this.dynamicDiagnostic(path, sourceFile, argument));
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) add(argument, argument.text);
          else if (argument) diagnostics.push(this.dynamicDiagnostic(path, sourceFile, argument));
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return diagnostics;
  }

  private validateSpecifier(
    path: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    specifier: string,
    files: ReadonlySet<string>,
  ): ImportDiagnostic | undefined {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const position = { line: location.line + 1, column: location.character + 1 };
    if (specifier.startsWith(".")) {
      const target = resolveLocalImportPath(path, specifier, files);
      if (!target)
        return this.diagnostic(
          "UNAPPROVED_DEPENDENCY_IMPORT",
          path,
          position,
          specifier,
          `Relative import '${specifier}' does not resolve to a project file`,
        );
      return undefined;
    }
    const alias = Object.entries(this.options.allowedAliases ?? {}).find(
      ([prefix]) => specifier === prefix || specifier.startsWith(`${prefix}/`),
    );
    if (alias) return undefined;
    const builtin = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (nodeBuiltins.has(builtin) && !this.options.allowNodeBuiltins)
      return this.diagnostic(
        "NODE_BUILTIN_NOT_ALLOWED",
        path,
        position,
        specifier,
        `Node builtin '${specifier}' is not allowed in browser source`,
      );
    if (nodeBuiltins.has(builtin)) return undefined;

    const packageRoot = packageRootOf(specifier);
    if (
      !Object.prototype.hasOwnProperty.call(this.manifest.dependencies, packageRoot) &&
      !Object.prototype.hasOwnProperty.call(this.manifest.devDependencies, packageRoot) &&
      !Object.prototype.hasOwnProperty.call(this.options.approvedPackages ?? {}, packageRoot)
    )
      return this.diagnostic(
        "UNKNOWN_PACKAGE_IMPORT",
        path,
        position,
        specifier,
        `Package '${packageRoot}' is not present in the resolved dependency manifest`,
        packageRoot,
      );
    const subpath = specifier.slice(packageRoot.length).replace(/^\//, "");
    const allowedSubpaths = this.options.allowedPackageSubpaths ?? {
      react: ["jsx-runtime", "jsx-dev-runtime"],
      "react-dom": ["client"],
      vite: ["client"],
    };
    if (subpath && !(allowedSubpaths[packageRoot] ?? []).includes(subpath))
      return this.diagnostic(
        "PACKAGE_SUBPATH_NOT_ALLOWED",
        path,
        position,
        specifier,
        `Package subpath '${specifier}' is not allow-listed`,
        packageRoot,
      );
    return undefined;
  }

  private dynamicDiagnostic(
    path: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
  ): ImportDiagnostic {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return this.diagnostic(
      "DYNAMIC_IMPORT_NOT_ALLOWED",
      path,
      { line: location.line + 1, column: location.character + 1 },
      "<dynamic>",
      "Dynamic import or require expressions must use a statically analyzable string",
    );
  }

  private diagnostic(
    code: ImportDiagnosticCode,
    path: string,
    position: { line: number; column: number },
    specifier: string,
    message: string,
    packageRoot?: string,
  ): ImportDiagnostic {
    return {
      code,
      path,
      ...position,
      specifier,
      ...(packageRoot ? { packageRoot } : {}),
      message,
    };
  }
}

/** Resolve the subset of Vite/TypeScript source resolution that is safe to
 * enforce without executing the generated project. Exact files win; a .js
 * specifier may refer to one unambiguous TS/JSX source equivalent. */
export function resolveLocalImportPath(
  importer: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (files.has(target)) return target;
  const extension = posix.extname(target);
  const candidates = extension === ".js"
    ? [".ts", ".tsx", ".jsx"]
    : extension
      ? []
      : [".ts", ".tsx", ".js", ".jsx"];
  const matches = candidates
    .map((candidate) => `${target.slice(0, extension ? -extension.length : undefined)}${candidate}`)
    .filter((candidate) => files.has(candidate));
  if (matches.length === 1) return matches[0];
  if (!extension) {
    const indexes = ["index.ts", "index.tsx", "index.js", "index.jsx"]
      .map((index) => `${target}/${index}`)
      .filter((candidate) => files.has(candidate));
    if (indexes.length === 1) return indexes[0];
  }
  return undefined;
}

/**
 * Every bare package root imported by generated source. Shares the validator's
 * traversal so detection and validation can never disagree about what an import is.
 */
export async function collectImportedPackageRoots(
  execution: ExecutionProvider,
  environmentId: string,
): Promise<ReadonlySet<string>> {
  const roots = new Set<string>();
  const entries = (await execution.listFiles(environmentId)).filter((entry) => entry.type === "FILE");
  for (const entry of entries) {
    const path = entry.path.replaceAll("\\", "/");
    if (!path.startsWith("src/") || !sourceExtensions.has(posix.extname(path))) continue;
    const sourceFile = ts.createSourceFile(
      path,
      await execution.readFile(environmentId, entry.path),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        roots.add(packageRootOf(node.moduleSpecifier.text));
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) roots.add(packageRootOf(argument.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return roots;
}

export function packageRootOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}
