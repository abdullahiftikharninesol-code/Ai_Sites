import ts from "typescript";
import { posix } from "node:path";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import { ineffectiveHandler } from "../../cli/runtime/reference-interaction-validator.js";
import { recoverFunctionalSemantics } from "./functional-semantics.js";

function binds(name: ts.BindingName, identifier: string): boolean {
  return ts.isIdentifier(name) ? name.text === identifier : name.elements.some(element => ts.isBindingElement(element) && binds(element.name, identifier));
}

/** No label guessing: opt-in + exact managed import + local controller + rendered panel are required. */
export function recoverFunctionalPlaceholders(bundle: SiteCoderFileBundle, requestText = ""): { bundle: SiteCoderFileBundle; fixes: readonly string[] } {
  const semantic = recoverFunctionalSemantics(bundle, requestText);
  bundle = semantic.bundle;
  let changed = false;
  const files = bundle.files.map(file => {
    if (!/\.[jt]sx$/.test(file.path)) return file;
    const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Map<string, string>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (posix.normalize(posix.join(posix.dirname(file.path), statement.moduleSpecifier.text)).replace(/\.tsx$/, "") !== "src/sites-ui/functional") continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
        imports.set((binding.propertyName ?? binding.name).text, binding.name.text);
    }
    const hook = imports.get("useCart"), panel = imports.get("CartPanel");
    if (!hook || !panel) return file;
    const replacements: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === "button") {
        const attrs = node.attributes.properties;
        const action = attrs.find((attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText(ast) === "data-sites-action");
        const click = attrs.find((attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText(ast) === "onClick");
        if (action?.initializer && ts.isStringLiteral(action.initializer) && action.initializer.text === "cart.open" &&
          !attrs.some(ts.isJsxSpreadAttribute) && (!click || ineffectiveHandler(click))) {
          let parent: ts.Node | undefined = node.parent;
          while (parent && !(ts.isFunctionDeclaration(parent) || ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))) parent = parent.parent;
          const fn = parent && (ts.isFunctionDeclaration(parent) || ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) ? parent : undefined;
          const body = fn?.body;
          if (fn && body && ts.isBlock(body) && !fn.parameters.some(param => binds(param.name, hook) || binds(param.name, panel))) {
            const bindings = body.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
            const controller = bindings.find(binding => ts.isIdentifier(binding.name) && (binding.parent.flags & ts.NodeFlags.Const) !== 0 && binding.initializer && ts.isCallExpression(binding.initializer) &&
              binding.initializer.expression.getText(ast) === hook && binding.initializer.arguments.length === 0);
            let hasPanel = false;
            let alteredController = false;
            const scan = (child: ts.Node): void => {
              if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.tagName.getText(ast) === panel) hasPanel = true;
              if (controller && ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
                child.left.getText(ast).startsWith(controller.name.getText(ast) + ".")) alteredController = true;
              if (controller && ts.isCallExpression(child) && child.arguments.some(argument => argument.getText(ast) === controller.name.getText(ast))) alteredController = true;
              ts.forEachChild(child, scan);
            };
            scan(body);
            if (controller && hasPanel && !alteredController && !bindings.some(binding => binds(binding.name, hook) || binds(binding.name, panel))) {
              const handler = `{() => ${controller.name.getText(ast)}.openCart()}`;
              replacements.push(click?.initializer ? { start: click.initializer.getStart(ast), end: click.initializer.end, text: handler }
                : { start: node.tagName.end, end: node.tagName.end, text: ` onClick=${handler}` });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!replacements.length) return file;
    changed = true;
    let content = file.content;
    for (const replacement of replacements.sort((a, b) => b.start - a.start))
      content = content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
    return { ...file, content };
  });
  return { bundle: changed ? { ...bundle, files } : bundle, fixes: [...semantic.fixes, ...(changed ? ["VERIFIED_CART_TRIGGER_WIRING"] : [])] };
}
