import * as ts from "typescript";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteCoderFileBundle } from "./site-coder-file-bundle.js";

type Element = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

export const GENERATION_NAVIGATION_RULES = "NAVIGATION: every href must reach a real route or rendered section on that page. A Size guide link needs visible sizing content at its destination, not an empty ID. ACTIONS: use working React buttons/forms for cart, search, account, filters and newsletter. Cart drawer: <button onClick={openCart}>Cart</button>; page: <a href=\"/cart\">Cart</a> only if /cart exists. Never use <a href=\"#cart\">Cart</a> without a rendered #cart destination. Before returning, check every href against rendered destinations; no placeholders or fake/empty targets.";

function attribute(element: Element, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find((item): item is ts.JsxAttribute =>
    ts.isJsxAttribute(item) && item.name.getText() === name,
  );
}

function hasSpread(element: Element): boolean {
  return element.attributes.properties.some(ts.isJsxSpreadAttribute);
}

function literalAttribute(element: Element, name: string): string | undefined {
  const value = attribute(element, name)?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

export function ineffectiveHandler(value: ts.JsxAttribute | undefined): boolean {
  const initializer = value?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) return false;
  const expression = initializer.expression;
  if (!expression) return true;
  if (expression.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expression) && expression.text === "undefined")) return true;
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const body = expression.body;
  if (ts.isBlock(body)) {
    if (body.statements.length === 0) return true;
    if (body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!) && !body.statements[0].expression) return true;
    if (body.statements.length !== 1 || !ts.isExpressionStatement(body.statements[0]!)) return false;
    return ineffectiveCall(body.statements[0].expression);
  }
  return ineffectiveCall(body);
}

function ineffectiveCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  return /^(?:window\.)?alert$|^console\.(?:log|warn|info|error)$|\.preventDefault$/.test(expression.expression.getText());
}

function handledFormAncestor(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText() === "form") {
      const opening = parent.openingElement;
      const submit = attribute(opening, "onSubmit");
      return Boolean((submit && !ineffectiveHandler(submit)) || attribute(opening, "action") || hasSpread(opening));
    }
    parent = parent.parent;
  }
  return false;
}

/** Only reject decidable native fragment links. Runtime QA owns dynamic/router behavior. */
export function validateStaticFragmentNavigation(bundle: SiteCoderFileBundle): void {
  const targets = new Set<string>();
  const links: Array<{ target: string; location: string }> = [];
  const components = new Set<string>();
  let dynamicTargets = false;
  const sources = bundle.files.filter((file) => /\.(?:tsx?|jsx?)$/i.test(file.path)).map((file) => ({
    file, ast: ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true,
      /x$/i.test(file.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  }));
  for (const { ast } of sources) {
    const declarations = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) components.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) components.add(node.name.text);
      ts.forEachChild(node, declarations);
    };
    declarations(ast);
  }
  for (const { file, ast } of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast);
        // Unavailable component implementations/spreads may supply valid targets.
        if (hasSpread(node) || attribute(node, "dangerouslySetInnerHTML") ||
          (/^[A-Z]/.test(tag) && !components.has(tag))) dynamicTargets = true;
        const id = attribute(node, "id");
        if (id) {
          const initializer = id.initializer;
          const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
          if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) targets.add(expression.text);
          else dynamicTargets = true;
        }
        if (tag === "a") {
          const href = literalAttribute(node, "href");
          const click = attribute(node, "onClick");
          if (href?.startsWith("#") && href.length > 1 && !hasSpread(node) && (!click || ineffectiveHandler(click))) {
            let target = href.slice(1);
            try { target = decodeURIComponent(target); } catch { /* Invalid encodings remain unmatched. */ }
            links.push({ target, location: `${file.path}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}` });
          }
        }
      }
      if (ts.isCallExpression(node) && /(?:createElement|setAttribute|insertAdjacentHTML)$/.test(node.expression.getText(ast))) dynamicTargets = true;
      if (ts.isBinaryExpression(node) && /(?:innerHTML|outerHTML|\.id)$/.test(node.left.getText(ast))) dynamicTargets = true;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "hash") dynamicTargets = true;
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  if (dynamicTargets) return;
  const missing = links.filter(({ target }) => !targets.has(target));
  if (missing.length) throw new ApplicationError("GENERATION_INCOMPLETE",
    `Navigation has missing fragment destinations: ${missing.slice(0, 5).map(({ target, location }) => `${location} -> #${target}`).join("; ")}`,
    { metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "navigation.fragments" } });
}

/** Rejects obvious screenshot-only controls before a reference-based site is saved. */
export function validateReferenceInteractions(bundle: SiteCoderFileBundle): void {
  validateStaticFragmentNavigation(bundle);
  const issues: string[] = [];
  for (const file of bundle.files) {
    if (!/\.(?:tsx|jsx)$/i.test(file.path)) continue;
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source).toLowerCase();
        const location = `${file.path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        if (tag === "button" && !hasSpread(node)) {
          const click = attribute(node, "onClick");
          const otherHandler = ["onPointerUp", "onMouseUp", "onKeyDown"].some((name) => Boolean(attribute(node, name)));
          const type = literalAttribute(node, "type");
          const formSubmit = (type === undefined || type === "submit" || type === "reset") && handledFormAncestor(node);
          if (click && ineffectiveHandler(click)) issues.push(`${location} has an alert-only or empty button action`);
          else if (!click && !otherHandler && !formSubmit) issues.push(`${location} has a button without an action`);
        }
        if (tag === "a" && !hasSpread(node)) {
          const href = literalAttribute(node, "href");
          if (href !== undefined && /^(?:\s*|#|javascript:.*)$/i.test(href))
            issues.push(`${location} has a placeholder link`);
          else if (!attribute(node, "href") && !attribute(node, "onClick"))
            issues.push(`${location} has a link without a destination`);
          else if (attribute(node, "onClick") && ineffectiveHandler(attribute(node, "onClick")))
            issues.push(`${location} has an alert-only or empty link action`);
        }
        if (tag === "form" && !hasSpread(node)) {
          const submit = attribute(node, "onSubmit");
          if (submit && ineffectiveHandler(submit)) issues.push(`${location} has an alert-only or empty form submission`);
          else if (!submit && !attribute(node, "action")) issues.push(`${location} has a form without a submit action`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (issues.length)
    throw new ApplicationError(
      "GENERATION_INCOMPLETE",
      `Reference-based site has non-functional controls: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; and ${issues.length - 5} more` : ""}`,
      { metadata: { failureStage: "STATIC_VALIDATION", validationCheck: "interaction.controls", findings: issues.slice(0, 25) } },
    );
}
