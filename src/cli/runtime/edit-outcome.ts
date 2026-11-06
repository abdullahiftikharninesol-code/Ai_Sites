import ts from "typescript";
import postcss from "postcss";
import { ApplicationError } from "../../app/errors/application-error.js";
import { parseEditRequirements } from "./edit-requirements.js";
import { validateEditScopeCompletion } from "./edit-scope.js";
import { mapEditRepository } from "./edit-repository-map.js";

export type EditOutcome = "APPLIED" | "NO_CHANGES_REQUIRED";
function meaningfulSource(path: string, content: string): string {
  if (/\.[jt]sx?$/.test(path)) {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    return ts.createPrinter({ removeComments: true }).printFile(source);
  }
  if (path.endsWith(".css")) {
    try { const root = postcss.parse(content); root.walkComments(comment => { comment.remove(); });
      root.walk(node => { node.raws = {}; }); return root.toString(); } catch { return content; }
  }
  return content;
}
const moduleSource = (path: string) => /\.(?:[jt]sx?|css)$/.test(path) && !/\.d\.ts$|\.(?:test|spec)\.[jt]sx?$/.test(path);
// Globs and computed dynamic imports make reachability unknowable statically;
// in that case no module is reported as unwired rather than risk a false failure.
const DYNAMIC_MODULE_LOADING = /import\.meta\.glob|require\.context|\bimport\(\s*[^'"\s)]/;

/** New modules unreachable from any pre-existing module. Entry-agnostic: the
 * existing project is the root set, so managed entry files need not be visible. */
function unwiredNewModules(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const created = [...after.keys()].filter(path => !before.has(path) && moduleSource(path));
  if (!created.length || [...after.values()].some(content => DYNAMIC_MODULE_LOADING.test(content))) return [];
  const map = mapEditRepository([...after].filter(([path]) => /\.[jt]sx?$/.test(path)).map(([path, content]) => ({ path, content })), [...after.keys()]);
  const edges = new Map(map.files.map(file => [file.path, file.imports.flatMap(item => item.target ? [item.target] : [])]));
  const html = [...after].filter(([path]) => path.endsWith(".html")).map(([, content]) => content).join("\n");
  const reached = new Set([...after.keys()].filter(path => before.has(path) || html.includes(`/${path}`)));
  const queue = [...reached];
  for (let i = 0; i < queue.length; i++) for (const target of edges.get(queue[i]!) ?? [])
    if (!reached.has(target)) { reached.add(target); queue.push(target); }
  return created.filter(path => !reached.has(path));
}

const CONTEXT_SEPARATOR = "\u0000";
function ruleDeclarations(content: string): Map<string, string> | undefined {
  try {
    const rules = new Map<string, string>();
    postcss.parse(content).walkRules(rule => {
      let context = "", parent = rule.parent;
      while (parent && parent.type === "atrule") { context = `@${(parent as postcss.AtRule).name} ${(parent as postcss.AtRule).params}${CONTEXT_SEPARATOR}${context}`; parent = parent.parent; }
      const body = rule.nodes.filter((node): node is postcss.Declaration => node.type === "decl").map(node => `${node.prop}:${node.value}`).join(";");
      const key = context + rule.selector;
      rules.set(key, (rules.has(key) ? rules.get(key) + ";" : "") + body);
    });
    return rules;
  } catch { return undefined; }
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function selectorTokenUsed(token: string, markup: string): boolean {
  if (new RegExp(`(?<![\\w-])${escapeRegExp(token)}(?![\\w-])`).test(markup)) return true;
  // Composed class names such as `card-${variant}` keep only a literal prefix.
  const dash = token.lastIndexOf("-");
  return dash > 0 && new RegExp(`${escapeRegExp(token.slice(0, dash + 1))}(?:\\$\\{|["'\`]\\s*\\+)`).test(markup);
}
function selectorCanMatch(selector: string, markup: string): boolean {
  return selector.split(",").some(complex => {
    const tokens = [...complex.replace(/\[[^\]]*\]|\([^)]*\)/g, "").matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]!);
    return tokens.every(token => selectorTokenUsed(token, markup));
  });
}
/** False only when every changed rule targets classes/ids absent from all markup
 * before and after the edit. Unknown structure is treated as possibly visible. */
function styleChangeCanApply(path: string, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean {
  const old = ruleDeclarations(before.get(path) ?? ""), next = ruleDeclarations(after.get(path) ?? "");
  if (!old || !next) return true;
  const changed = [...new Set([...old.keys(), ...next.keys()])].filter(key => old.get(key) !== next.get(key));
  if (!changed.length) return true;
  const markup = [before, after].flatMap(files => [...files].filter(([file]) => !file.endsWith(".css")).map(([, content]) => content)).join("\n");
  return changed.some(key => selectorCanMatch(key.slice(key.lastIndexOf(CONTEXT_SEPARATOR) + 1), markup));
}

export function assessEditOutcome(instruction: string, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): {
  readonly outcome: EditOutcome;
  readonly changedPaths: readonly string[];
} {
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(path =>
    meaningfulSource(path, before.get(path) ?? "") !== meaningfulSource(path, after.get(path) ?? ""));
  const requirements = parseEditRequirements(instruction), scope = requirements.scope;
  if (!changedPaths.length) {
    const review = /^(?:please\s+)?(?:review|audit|inspect|verify|check|perform\b[^.!?\n]{0,60}\breview)\b/i.test(instruction.trim()) &&
      !/\b(?:add|create|redesign|replace|rename|increase|decrease|implement|change)\b/i.test(instruction.replace(/\b(?:do not|don't|without)\b[^.!?\n]*/gi, ""));
    let alreadySatisfied = false;
    if (scope?.canProveCompletion && scope.copyTargets.length && !scope.colors.length && !requirements.rename) {
      try { validateEditScopeCompletion(scope, before, before); alreadySatisfied = true; } catch { /* The requested copy is not already present. */ }
    }
    if (review || alreadySatisfied) return { outcome: "NO_CHANGES_REQUIRED", changedPaths };
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The requested edit produced no meaningful website changes. Your saved website is unchanged.", {
      metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "edit.outcome", reason: "UNCHANGED_EDIT_RESULT", editOutcome: "NOT_APPLIED" },
    });
  }
  const unwired = unwiredNewModules(before, after);
  if (unwired.length)
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The edit created source that the website never imports, so it cannot appear. Your saved website is unchanged.", {
      metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "edit.outcome", reason: "UNWIRED_NEW_MODULE", editOutcome: "NOT_APPLIED", paths: unwired, changedPaths },
    });
  const effectivePaths = changedPaths.filter(path => !path.endsWith(".css") || styleChangeCanApply(path, before, after));
  if (!effectivePaths.length)
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The edit only changed styles for selectors that match nothing in the website, so it has no visible effect. Your saved website is unchanged.", {
      metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "edit.outcome", reason: "NO_VISIBLE_EFFECT", editOutcome: "NOT_APPLIED", changedPaths },
    });
  const requiresLogic = /\b(?:calculat\w*|pric(?:e|es|ing)|discount\w*|shared\s+state|(?:add|implement|create)\b[^.!?\n]{0,80}\b(?:compar\w*|routes?|components?|modules?))\b/i.test(instruction);
  if (requiresLogic && !effectivePaths.some(path => /\.[jt]sx?$|\.json$|\.html$/.test(path)))
    throw new ApplicationError("EDIT_REQUIREMENT_INCOMPLETE", "The requested logic change was not applied to application source; styling changes alone do not complete this edit.", {
      metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "edit.outcome", reason: "REQUIRED_APPLICATION_CHANGE_MISSING", editOutcome: "PARTIAL", changedPaths },
    });
  // A meaningful diff is necessary, not proof of arbitrary semantic correctness.
  // Existing explicit requirements, build, import/security and runtime gates
  // remain responsible for the properties they can actually verify.
  return { outcome: "APPLIED", changedPaths };
}
