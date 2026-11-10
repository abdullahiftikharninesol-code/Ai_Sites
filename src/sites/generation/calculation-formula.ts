/**
 * Explicit calculation rules stated by the user, e.g. "Total = price × quantity"
 * or "the estimate equals area times rate plus 50". Only an explicit
 * assignment with arithmetic operators is accepted; anything else yields no
 * formula, so QA never invents an expected value.
 */
export interface CalculationFormula {
  /** Label of the observable result, as the user named it. */
  readonly result: string;
  /** Normalized expression: numbers, + - * / ( ), and variable names in braces. */
  readonly expression: string;
  readonly variables: readonly string[];
}

type Token = { kind: "num"; value: number } | { kind: "var"; name: string } | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };
const WORD_OPERATORS: readonly [RegExp, string][] = [
  [/\bmultiplied\s+by\b|\btimes\b|×|\*/gi, " * "], [/\bdivided\s+by\b|÷|\//gi, " / "], [/\bplus\b|\+/gi, " + "], [/\bminus\b|−|(?<=\s)-(?=\s)/gi, " - "],
];
const STOP = /^(?:the|a|an|of|per|each)$/i;

function tokenize(text: string): Token[] | undefined {
  let normalized = ` ${text} `;
  for (const [pattern, replacement] of WORD_OPERATORS) normalized = normalized.replace(pattern, replacement);
  const tokens: Token[] = [];
  let words: string[] = [];
  const flush = () => { const name = words.filter(word => !STOP.test(word)).join(" ").trim(); if (name) tokens.push({ kind: "var", name: name.toLowerCase() }); words = []; };
  for (const raw of normalized.replace(/([()])/g, " $1 ").split(/\s+/).filter(Boolean)) {
    if (["+", "-", "*", "/", "(", ")"].includes(raw)) { flush(); tokens.push({ kind: "op", value: raw as "+" }); continue; }
    const number = /^(\d+(?:\.\d+)?)(%)?$/.exec(raw.replace(/,/g, ""));
    if (number) { flush(); tokens.push({ kind: "num", value: Number(number[1]) / (number[2] ? 100 : 1) }); continue; }
    if (!/^[a-z][a-z'-]*$/i.test(raw)) return undefined;
    words.push(raw);
  }
  flush();
  return tokens;
}

type Node = { kind: "num"; value: number } | { kind: "var"; name: string } | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node };
function parse(tokens: readonly Token[]): Node | undefined {
  let at = 0;
  const peek = () => tokens[at];
  const primary = (): Node | undefined => {
    const token = tokens[at++];
    if (!token) return undefined;
    if (token.kind === "num") return token;
    if (token.kind === "var") return token;
    if (token.value === "(") { const inner = sum(); if (peek()?.kind !== "op" || (peek() as { value: string }).value !== ")") return undefined; at++; return inner; }
    return undefined;
  };
  const product = (): Node | undefined => {
    let left = primary();
    while (left && peek()?.kind === "op" && ["*", "/"].includes((peek() as { value: string }).value)) {
      const op = (tokens[at++] as { value: "*" | "/" }).value, right = primary();
      if (!right) return undefined;
      left = { kind: "bin", op, left, right };
    }
    return left;
  };
  const sum = (): Node | undefined => {
    let left = product();
    while (left && peek()?.kind === "op" && ["+", "-"].includes((peek() as { value: string }).value)) {
      const op = (tokens[at++] as { value: "+" | "-" }).value, right = product();
      if (!right) return undefined;
      left = { kind: "bin", op, left, right };
    }
    return left;
  };
  const tree = sum();
  return tree && at === tokens.length ? tree : undefined;
}
const variablesOf = (node: Node): string[] => node.kind === "var" ? [node.name] : node.kind === "bin" ? [...variablesOf(node.left), ...variablesOf(node.right)] : [];
const render = (node: Node): string => node.kind === "num" ? String(node.value) : node.kind === "var" ? `{${node.name}}` : `(${render(node.left)} ${node.op} ${render(node.right)})`;

/** The first explicit assignment-style formula in the request, if any. */
export function extractCalculationFormula(text: string): CalculationFormula | undefined {
  const assignment = /\b([a-z][a-z ]{1,40}?)\s*(?:=|\bequals\b|\bis\s+(?:calculated|computed)\s+as\b|\bshould\s+be\s+(?:calculated|computed)\s+as\b)\s*([^.;\n]{3,160})/gi;
  for (const match of text.matchAll(assignment)) {
    const result = match[1]!.trim().split(/\s+/).filter(word => !STOP.test(word)).slice(-3).join(" ").toLowerCase();
    const tokens = tokenize(match[2]!.replace(/\s+(?:and|where|with|so|which|that)\b.*$/i, ""));
    const tree = tokens && parse(tokens);
    if (!tree || tree.kind !== "bin") continue;
    const variables = [...new Set(variablesOf(tree))];
    if (!result || !variables.length || variables.includes(result)) continue;
    return { result, expression: render(tree), variables };
  }
  return undefined;
}

/** Evaluates a formula with every variable bound; undefined if a binding is missing or the result is not finite. */
export function evaluateCalculationFormula(formula: CalculationFormula, values: Readonly<Record<string, number>>): number | undefined {
  const tokens = tokenize(formula.expression.replace(/[{}]/g, " ").replace(/\(/g, " ( ").replace(/\)/g, " ) "));
  // Re-tokenizing the rendered form keeps evaluation independent of the original prose.
  const tree = tokens && parse(tokens);
  if (!tree) return undefined;
  const run = (node: Node): number | undefined => {
    if (node.kind === "num") return node.value;
    if (node.kind === "var") return values[node.name];
    const left = run(node.left), right = run(node.right);
    if (left === undefined || right === undefined) return undefined;
    return node.op === "+" ? left + right : node.op === "-" ? left - right : node.op === "*" ? left * right : left / right;
  };
  const value = run(tree);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}
