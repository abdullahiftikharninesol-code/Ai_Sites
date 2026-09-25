import * as ts from "typescript";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteCoderFileBundle } from "./site-coder-file-bundle.js";

type Element = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

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

function ineffectiveHandler(value: ts.JsxAttribute | undefined): boolean {
  const initializer = value?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) return false;
  const expression = initializer.expression;
  if (!expression) return true;
  if (ts.isIdentifier(expression) && ["undefined", "null"].includes(expression.text)) return true;
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const body = expression.body;
  if (ts.isBlock(body)) {
    if (body.statements.length === 0) return true;
    if (body.statements.length !== 1 || !ts.isExpressionStatement(body.statements[0]!)) return false;
    return ineffectiveCall(body.statements[0]!.expression);
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

/** Rejects obvious screenshot-only controls before a reference-based site is saved. */
export function validateReferenceInteractions(bundle: SiteCoderFileBundle): void {
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
    );
}
