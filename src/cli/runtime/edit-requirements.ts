import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { isEditableSiteEditPath } from "./site-coder-file-bundle.js";
import { analyzeEditScope, maskProtectedEditValues, type DeterministicEditScope } from "./edit-scope.js";

export interface EditRequirements {
  readonly rename?: { readonly oldLiteral: string; readonly newLiteral: string };
  readonly style: boolean;
  readonly scope?: DeterministicEditScope;
}

export interface EditRequirementContext {
  readonly renamePaths: readonly string[];
  readonly stylePaths: readonly string[];
}

export type EditRequirementName = "rename" | "style";

export interface EditRequirementDiagnostic {
  readonly requirement: EditRequirementName;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Deliberately small grammar: explicit rename clauses, or quoted/single-name replacements. */
export function parseEditRequirements(instruction: string): EditRequirements {
  const clause = /\b(rename|change|replace)\s+(?:"([^"\n]+)"|'([^'\n]+)'|\u201c([^\u201d\n]+)\u201d|([^\n.,;!?]+?))\s+(to|with)\s+(?:"([^"\n]+)"|'([^'\n]+)'|\u201c([^\u201d\n]+)\u201d|([^\n.,;!?]+?))(?:\s+(?:globally|everywhere|throughout (?:the )?(?:website|site|project)|across (?:the )?(?:(?:whole|entire) )?(?:website|site|project)))?(?=\s*(?:[.,;!?\n]|$|\band\b))/gi;
  const pairs: NonNullable<EditRequirements["rename"]>[] = [];
  for (const match of instruction.matchAll(clause)) {
    const verb = match[1]!.toLowerCase();
    if ((verb === "replace") !== (match[6]!.toLowerCase() === "with")) continue;
    const oldLiteral = (match[2] ?? match[3] ?? match[4] ?? match[5]!).trim();
    const newLiteral = (match[7] ?? match[8] ?? match[9] ?? match[10]!).trim();
    const quoted = Boolean(match[2] ?? match[3] ?? match[4]);
    // Avoid interpreting "change the hero button text to ..." or colour instructions as names.
    const plainName = (text: string) => /^[A-Z][\p{L}\p{N}'& -]{0,79}$/u.test(text) &&
      !/\b(the|company|brand|restaurant|color|colour|accent|palette|theme|heading|headline|text|button|from|and)\b/i.test(text);
    const global = /\b(?:globally|everywhere|throughout (?:the )?(?:website|site|project)|across (?:the )?(?:(?:whole|entire) )?(?:website|site|project))\s*$/i.test(match[0]);
    const confident = quoted || (verb === "rename" || global
      ? plainName(oldLiteral) && plainName(newLiteral)
      : /^[A-Z][\p{L}\p{N}]*$/u.test(oldLiteral) && /^[A-Z][\p{L}\p{N}]*$/u.test(newLiteral));
    if (confident && oldLiteral.length <= 80 && newLiteral.length <= 80 &&
        oldLiteral !== newLiteral && !newLiteral.includes(oldLiteral))
      pairs.push({ oldLiteral, newLiteral });
  }
  // Several distinct rename pairs are outside this small grammar.
  const uniquePairs = [...new Map(pairs.map((pair) => [JSON.stringify(pair), pair])).values()];
  const actionable = instruction.replace(/\b(?:keep|preserve|retain|without changing)\b[^.!?;\n]*/gi, "");
  return {
    ...(uniquePairs.length === 1 ? { rename: uniquePairs[0]! } : {}),
    scope: analyzeEditScope(instruction, uniquePairs.length === 1 ? uniquePairs[0]! : undefined),
    style: /\b(?:colou?rs?|accent|palette|theme|visual\s+styl(?:e|ing))\b/i.test(actionable) ||
      /\b(?:change|update|adjust)\s+(?:the\s+)?styl(?:e|es|ing)\b/i.test(actionable),
  };
}

export function isEditableRequirementPath(path: string): boolean {
  return isEditableSiteEditPath(path) && /\.(?:tsx?|jsx?|css|svg|json|html)$/i.test(path);
}

/** Explicit brand discovery/completion only; patch anchors remain byte-for-byte exact. */
export function containsRenameLiteral(source: string, oldLiteral: string): boolean {
  return source.toLowerCase().includes(oldLiteral.toLowerCase());
}

export async function readEditRequirementFiles(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile">,
  environmentId: string,
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await execution.listFiles(environmentId)) {
    const path = entry.path.replaceAll("\\", "/");
    if (entry.type === "FILE" && isEditableRequirementPath(path))
      files.set(path, await execution.readFile(environmentId, entry.path));
  }
  return files;
}

function styleContent(path: string, source: string): string {
  if (path.endsWith(".css")) return source;
  // Compare style-bearing expressions, not arbitrary copy elsewhere in a JSX/theme file.
  return source.split("\n").flatMap((line) => [
    ...line.matchAll(/(?:className|style)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})|(?:["']?(?:--[\w-]+|colou?r|background(?:Color)?|accent|primary|secondary|palette|theme|font\w*|border\w*|shadow)["']?\s*:\s*[^,;}]+)|#[\da-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi),
  ].map((match) => match[0])).join("\n");
}

/** Only source actually supplied to the request, including exact patchable excerpts. */
export function suppliedEditRequirementContext(
  requirements: EditRequirements,
  files: readonly { readonly path: string; readonly content: string }[],
): EditRequirementContext {
  const editable = files.filter(({ path }) => isEditableRequirementPath(path));
  return {
    renamePaths: [...new Set(editable.filter(({ content }) =>
      requirements.rename && containsRenameLiteral(content, requirements.rename.oldLiteral),
    ).map(({ path }) => path))],
    stylePaths: [...new Set(editable.filter(({ path, content }) =>
      path.endsWith(".css") || styleContent(path, content).length > 0,
    ).map(({ path }) => path))],
  };
}

/** Compact variable guidance: no source, user-request duplication, or model completion flags. */
export function mandatoryEditRequirements(
  requirements: EditRequirements,
  context: EditRequirementContext,
): string {
  if (!requirements.rename && !requirements.style) return "";
  const lines = ["MANDATORY EDIT REQUIREMENTS: cover ALL in returned plan operations; omit none."];
  if (requirements.rename)
    lines.push(`RENAME ${JSON.stringify(requirements.rename.oldLiteral)} -> ${JSON.stringify(requirements.rename.newLiteral)}: cover supplied editable old-literal occurrences, including casing variants; use exact source anchors.`);
  if (requirements.style) {
    const css = context.stylePaths.filter((path) => path.endsWith(".css"));
    const hints = (css.length ? css : context.stylePaths).slice(0, 3);
    lines.push(`STYLE: include at least one valid edit to a supplied relevant style-bearing source.${hints.length ? ` Targets: ${hints.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

/** Structural coverage only; actual source changes are checked again after application. */
export function validateEditPlanCoverage(
  requirements: EditRequirements,
  context: EditRequirementContext,
  operations: readonly { readonly path: string; readonly find?: string; readonly replace?: string; readonly content?: string }[],
): void {
  const [missing] = editPlanCoverageDiagnostics(requirements, context, operations);
  if (missing)
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", missing.message, {
      metadata: missing.metadata,
    });
}

export function editPlanCoverageDiagnostics(
  requirements: EditRequirements,
  context: EditRequirementContext,
  operations: readonly { readonly path: string; readonly find?: string; readonly replace?: string; readonly content?: string }[],
): readonly EditRequirementDiagnostic[] {
  const missing: EditRequirementDiagnostic[] = [];
  for (const [requirement, required, paths] of [
    ["rename", Boolean(requirements.rename), context.renamePaths],
    ["style", requirements.style, context.stylePaths],
  ] as const) {
    if (required && !operations.some((operation) => paths.includes(operation.path) &&
      (requirement !== "style" || operation.path.endsWith(".css") ||
        (operation.content !== undefined
          ? styleContent(operation.path, operation.content).length > 0
          : styleContent(operation.path, operation.find ?? "") !== styleContent(operation.path, operation.replace ?? ""))),
    ))
      missing.push({
        requirement,
        message: `The edit plan omitted the required ${requirement} operation`,
        metadata: { requirement, phase: "plan", suppliedPaths: paths },
      });
  }
  return Object.freeze(missing);
}

/** Runs on the candidate workspace only. It never rewrites source or calls a model. */
export function validateEditRequirements(
  requirements: EditRequirements,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): void {
  const [missing] = editRequirementDiagnostics(requirements, before, after);
  if (missing)
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", missing.message, {
      metadata: missing.metadata,
    });
}

export function editRequirementDiagnostics(
  requirements: EditRequirements,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly EditRequirementDiagnostic[] {
  const missing: EditRequirementDiagnostic[] = [];
  if (requirements.rename) {
    const { oldLiteral } = requirements.rename;
    const remainingFiles = [...after]
      .filter(([path, content]) => isEditableRequirementPath(path) && containsRenameLiteral(maskProtectedEditValues(content), oldLiteral))
      .map(([path]) => path).sort();
    if (remainingFiles.length)
      missing.push({
        requirement: "rename",
        message: "The requested rename is incomplete",
        metadata: { requirement: "rename", oldLiteral, matchMode: "case-insensitive", remainingFiles },
      });
  }
  if (requirements.style && ![...after].some(([path, content]) =>
    isEditableRequirementPath(path) && content !== before.get(path) &&
    styleContent(path, content) !== styleContent(path, before.get(path) ?? ""),
  ))
    missing.push({
      requirement: "style",
      message: "The requested style change is incomplete",
      metadata: { requirement: "style" },
    });
  return Object.freeze(missing);
}
