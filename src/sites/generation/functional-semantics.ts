import ts from "typescript";
import { createHash } from "node:crypto";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";

/** Recover only behavior proven by existing, unshadowed React state.
 * Never invent handlers, destinations or product photos; explicit placeholder
 * requests may use distinct, honestly labelled SVG placeholder views. */
export function recoverFunctionalSemantics(bundle: SiteCoderFileBundle, requestText = ""): { bundle: SiteCoderFileBundle; fixes: readonly string[] } {
  let changed = false;
  let galleryChanged = false;
  let dismissChanged = false;
  const placeholderRequested = /\bgallery placeholders?\b/i.test(requestText) && !/\b(?:no|without|do not|don't)\s+(?:\w+\s+){0,2}gallery placeholders?\b/i.test(requestText) && !/\b(?:real|actual|uploaded|provided)\s+(?:product\s+)?(?:photos|images)\b/i.test(requestText);
  const files = bundle.files.map(file => {
    if (!/\.[jt]sx$/.test(file.path)) return file;
    const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hooks = new Set<string>();
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "react") continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
        if ((binding.propertyName ?? binding.name).text === "useState") hooks.add(binding.name.text);
    }
    type State = { setter: string; boolean: boolean; hook: string; index?: number };
    const scopeOf = (node: ts.Node | undefined): ts.Node | undefined => {
      while (node && !ts.isSourceFile(node) && !ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isMethodDeclaration(node) && !ts.isConstructorDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) node = node.parent;
      return node;
    };
    const declarations = new Map<ts.Node, Map<string, number>>();
    const states = new Map<ts.Node, Map<string, State>>();
    const bind = (name: ts.BindingName, scope: ts.Node): void => {
      const names = declarations.get(scope) ?? new Map<string, number>(); declarations.set(scope, names);
      if (ts.isIdentifier(name)) names.set(name.text, (names.get(name.text) ?? 0) + 1);
      else for (const item of name.elements) if (ts.isBindingElement(item)) bind(item.name, scope);
    };
    const collect = (node: ts.Node): void => {
      const scope = scopeOf(node.parent) ?? ast;
      // A callback type's parameter names do not bind runtime variables in the
      // enclosing component (e.g. add: (size: string) => void).
      if (ts.isVariableDeclaration(node) || (ts.isParameter(node) && scope === node.parent)) bind(node.name, scope);
      if (ts.isFunctionDeclaration(node) && node.name) bind(node.name, scope);
      if (ts.isVariableDeclaration(node) && (node.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isArrayBindingPattern(node.name) && node.name.elements.length === 2 &&
        node.initializer && ts.isCallExpression(node.initializer) && hooks.has(node.initializer.expression.getText(ast))) {
        const [value, setter] = node.name.elements;
        if (value && setter && ts.isBindingElement(value) && ts.isBindingElement(setter) && ts.isIdentifier(value.name) && ts.isIdentifier(setter.name)) {
          const local = states.get(scope) ?? new Map<string, State>(); states.set(scope, local);
          const initial = node.initializer.arguments[0];
          local.set(value.name.text, { setter: setter.name.text, hook: node.initializer.expression.getText(ast), boolean: initial?.kind === ts.SyntaxKind.FalseKeyword || initial?.kind === ts.SyntaxKind.TrueKeyword,
            ...(initial && ts.isNumericLiteral(initial) ? { index: Number(initial.text) } : {}) });
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(ast);
    const edits: { position: number; end?: number; text: string }[] = [];
    const attribute = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) => node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
    const expression = (attr: ts.JsxAttribute | undefined) => attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
    const visit = (node: ts.Node): void => {
      const knownState = (name: string): State | undefined => {
        const inner = new Set<string>();
        for (let scope = scopeOf(node.parent); scope; scope = scopeOf(scope.parent)) {
          const names = declarations.get(scope);
          if (names?.has(name)) {
            const state = states.get(scope)?.get(name);
            if (!state || names.get(name) !== 1 || names.get(state.setter) !== 1 || inner.has(state.setter)) return undefined;
            for (let outer: ts.Node | undefined = scope; outer; outer = scopeOf(outer.parent)) if (declarations.get(outer)?.has(state.hook)) return undefined;
            if (inner.has(state.hook)) return undefined;
            return state;
          }
          for (const key of names?.keys() ?? []) inner.add(key);
        }
        return undefined;
      };
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (!node.attributes.properties.some(ts.isJsxSpreadAttribute) && node.tagName.getText(ast) === "input" && !attribute(node, "type")) {
          const label = attribute(node, "aria-label")?.initializer;
          if (label && ts.isStringLiteral(label) && /^search\b/i.test(label.text)) edits.push({ position: node.tagName.end, text: ' type="search"' });
        }
        if (node.tagName.getText(ast) === "button" && !node.attributes.properties.some(ts.isJsxSpreadAttribute)) {
          const click = expression(attribute(node, "onClick"));
          const call = click && ts.isArrowFunction(click) && ts.isCallExpression(click.body) ? click.body : undefined;
          const style = expression(attribute(node, "className"));
          const hidden = expression(attribute(node, "hidden"));
          const label = attribute(node, "aria-label")?.initializer;
          // Exact malformed dismissal: an exclusive boolean controls only the
          // X button inside an explicitly named notice. Move that existing
          // visibility state to the whole notice; never guess an arbitrary parent.
          if (call && call.arguments.length === 1 && call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
            hidden && ts.isPrefixUnaryExpression(hidden) && hidden.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isIdentifier(hidden.operand) && knownState(hidden.operand.text)?.boolean &&
            call.expression.getText(ast) === knownState(hidden.operand.text)!.setter &&
            label && ts.isStringLiteral(label) && /^dismiss (?:suggestion|notice|notification|banner|alert|message)$/i.test(label.text)) {
            const button = node.parent;
            const region = button.parent;
            const owner = scopeOf(node.parent);
            const regionClass = ts.isJsxElement(region) ? attribute(region.openingElement, "className")?.initializer : undefined;
            const kinds: Record<string, RegExp> = { suggestion: /^(?:suggestion|ai-note)$/, notice: /^notice$/, notification: /^notification$/, banner: /^banner$/, alert: /^alert$/, message: /^message$/ };
            const kind = label.text.toLowerCase().split(" ")[1]!;
            if (ts.isJsxOpeningElement(node) && ts.isJsxElement(button) && button.openingElement === node && ts.isJsxElement(region) && (ts.isJsxElement(region.parent) || ts.isJsxFragment(region.parent)) &&
              ["div", "aside", "section"].includes(region.openingElement.tagName.getText(ast)) &&
              !region.openingElement.attributes.properties.some(ts.isJsxSpreadAttribute) && !attribute(region.openingElement, "hidden") &&
              regionClass && ts.isStringLiteral(regionClass) && regionClass.text.split(/\s+/).some(token => kinds[kind]!.test(token))) {
              let stateUses = 0, setterUses = 0, buttons = 0;
              const scanUses = (child: ts.Node): void => {
                if (ts.isIdentifier(child) && child.text === hidden.operand.getText(ast)) stateUses++;
                if (ts.isIdentifier(child) && child.text === call.expression.getText(ast)) setterUses++;
                ts.forEachChild(child, scanUses);
              };
              const scanButtons = (child: ts.Node): void => {
                if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.tagName.getText(ast) === "button") buttons++;
                ts.forEachChild(child, scanButtons);
              };
              if (owner) scanUses(owner);
              scanButtons(region);
              if (stateUses === 2 && setterUses === 2 && buttons === 1 &&
                region.children.some(child => ts.isJsxElement(child) && child !== button)) {
                const attr = attribute(node, "hidden")!;
                edits.push({ position: attr.getStart(ast), end: attr.end, text: "" });
                edits.push({ position: region.getStart(ast), text: `{${hidden.operand.getText(ast)} && (` });
                edits.push({ position: region.end, text: ")}" });
                if (!attribute(region.openingElement, "data-sites-dismissible")) edits.push({ position: region.openingElement.tagName.end, text: " data-sites-dismissible" });
                dismissChanged = true;
              }
            }
          }
          const clamp = call?.arguments[0];
          if (call && clamp && ts.isCallExpression(clamp) && clamp.expression.getText(ast) === "Math.max" && clamp.arguments.length === 2 &&
            clamp.arguments[0]?.getText(ast) === "1" && !attribute(node, "disabled")) {
            const decrease = clamp.arguments[1];
            if (decrease && ts.isBinaryExpression(decrease) && decrease.operatorToken.kind === ts.SyntaxKind.MinusToken &&
              ts.isIdentifier(decrease.left) && knownState(decrease.left.text) && decrease.right.getText(ast) === "1" &&
              call.expression.getText(ast) === knownState(decrease.left.text)!.setter)
              edits.push({ position: node.tagName.end, text: ` disabled={${decrease.left.getText(ast)} <= 1}` });
          }
          if (call && style && ts.isConditionalExpression(style) && ts.isBinaryExpression(style.condition) &&
            [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(style.condition.operatorToken.kind) &&
            ts.isIdentifier(style.condition.left) && knownState(style.condition.left.text) && ts.isStringLiteral(style.whenTrue) &&
            /\b(?:selected|active)\b/.test(style.whenTrue.text) &&
            call.expression.getText(ast) === knownState(style.condition.left.text)!.setter && call.arguments.length === 1 &&
            call.arguments[0]!.getText(ast) === style.condition.right.getText(ast)) {
            if (!attribute(node, "aria-pressed")) edits.push({ position: node.tagName.end, text: ` aria-pressed={${style.condition.getText(ast)}}` });
            // Explicit mock-gallery request + a proven [0,1,...].map selector.
            // Repeated identical media contains no real alternative views. Use
            // honest deterministic placeholders, never invent product photos.
            const mapper = scopeOf(node.parent);
            const mapCall = mapper?.parent;
            if (placeholderRequested && mapper && ts.isArrowFunction(mapper) && mapCall && ts.isCallExpression(mapCall) &&
              ts.isPropertyAccessExpression(mapCall.expression) && mapCall.expression.name.text === "map" &&
              ts.isArrayLiteralExpression(mapCall.expression.expression)) {
              const indexes = mapCall.expression.expression.elements;
              const parameter = mapper.parameters[0]?.name;
              const initialIndex = knownState(style.condition.left.text)!.index;
              if (mapper.parameters.length === 1 && initialIndex !== undefined && Number.isInteger(initialIndex) && initialIndex >= 0 && initialIndex < indexes.length &&
                indexes.length >= 2 && indexes.length <= 8 && indexes.every((item, index) => ts.isNumericLiteral(item) && Number(item.text) === index) &&
                parameter && ts.isIdentifier(parameter) && style.condition.right.getText(ast) === parameter.text) {
                let gallery: ts.Node | undefined = node.parent;
                while (gallery && !(ts.isJsxElement(gallery) && attribute(gallery.openingElement, "className")?.initializer &&
                  ts.isStringLiteral(attribute(gallery.openingElement, "className")!.initializer!) &&
                  /\bgallery\b/.test((attribute(gallery.openingElement, "className")!.initializer as ts.StringLiteral).text))) gallery = gallery.parent;
                if (gallery) {
                  const images: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
                  const findImages = (child: ts.Node): void => {
                    if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.tagName.getText(ast) === "img") images.push(child);
                    ts.forEachChild(child, findImages);
                  };
                  findImages(gallery);
                  const thumbnailImages = images.filter(image => { let parent: ts.Node | undefined = image.parent; while (parent && parent !== mapper && parent !== gallery) parent = parent.parent; return parent === mapper; });
                  const activeImages = images.filter(image => !thumbnailImages.includes(image));
                  const src = images[0] && expression(attribute(images[0], "src"));
                  if (images.length === 2 && thumbnailImages.length === 1 && activeImages.length === 1 && src && ts.isIdentifier(src) &&
                    images.every(image => expression(attribute(image, "src"))?.getText(ast) === src.getText(ast) && !image.attributes.properties.some(ts.isJsxSpreadAttribute))) {
                    if (!attribute(node, "aria-label")) edits.push({ position: node.tagName.end, text: ` aria-label={"View image " + (${parameter.text} + 1)}` });
                    for (const image of images) {
                      const index = thumbnailImages.includes(image) ? parameter.text : style.condition.left.getText(ast);
                      const initializer = attribute(image, "src")!.initializer!;
                      const svg = "'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"800\"><rect width=\"640\" height=\"800\" fill=\"#eee7dc\"/><text x=\"320\" y=\"400\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"28\">Product view ' + (" + index + " + 1) + ' placeholder</text></svg>'";
                      edits.push({ position: initializer.getStart(ast), end: initializer.end, text: `{"data:image/svg+xml," + encodeURIComponent(${svg})}` });
                      const alt = attribute(image, "alt")?.initializer;
                      const description = `{"Product view " + (${index} + 1) + " placeholder"}`;
                      if (alt) edits.push({ position: alt.getStart(ast), end: alt.end, text: description });
                      else edits.push({ position: image.tagName.end, text: ` alt=${description}` });
                      if (activeImages.includes(image) && !attribute(image, "data-sites-gallery-active")) edits.push({ position: image.tagName.end, text: " data-sites-gallery-active" });
                    }
                    galleryChanged = true;
                  }
                }
              }
            }
          }
          const toggle = call?.arguments[0];
          if (call && toggle && ts.isPrefixUnaryExpression(toggle) && toggle.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isIdentifier(toggle.operand) && knownState(toggle.operand.text)?.boolean &&
            call.expression.getText(ast) === knownState(toggle.operand.text)!.setter && call.arguments.length === 1 &&
            !attribute(node, "aria-expanded") && !attribute(node, "aria-controls")) {
            let owner: ts.Node | undefined = node.parent;
            while (owner && !ts.isFunctionDeclaration(owner) && !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) owner = owner.parent;
            const navs: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
            const find = (child: ts.Node): void => {
              if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.tagName.getText(ast) === "nav") {
                const style = expression(attribute(child, "className"));
                let controlled = false;
                const condition = (part: ts.Node): void => {
                  if (ts.isConditionalExpression(part) && part.condition.getText(ast) === toggle.operand.getText(ast) && ts.isStringLiteral(part.whenTrue) && /\b(?:nav-open|menu-open)\b/.test(part.whenTrue.text)) controlled = true;
                  ts.forEachChild(part, condition);
                };
                if (style) condition(style);
                if (controlled && !child.attributes.properties.some(ts.isJsxSpreadAttribute)) navs.push(child);
              }
              ts.forEachChild(child, find);
            };
            if (owner) find(owner);
            if (navs.length === 1) {
              const nav = navs[0]!, existing = attribute(nav, "id")?.initializer;
              const id = existing && ts.isStringLiteral(existing) ? existing.text : !existing ? `sites-nav-${createHash("sha256").update(`${file.path}:${nav.pos}`).digest("hex").slice(0, 12)}` : undefined;
              if (id) {
                edits.push({ position: node.tagName.end, text: ` aria-expanded={${toggle.operand.getText(ast)}} aria-controls=${JSON.stringify(id)}` });
                if (!existing) edits.push({ position: nav.tagName.end, text: ` id=${JSON.stringify(id)}` });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!edits.length) return file;
    changed = true;
    let content = file.content;
    for (const edit of edits.sort((a, b) => b.position - a.position)) content = content.slice(0, edit.position) + edit.text + content.slice(edit.end ?? edit.position);
    return { ...file, content };
  });
  return { bundle: changed ? { ...bundle, files } : bundle, fixes: [...(changed ? ["VERIFIED_REACT_CONTROL_SEMANTICS"] : []), ...(galleryChanged ? ["VERIFIED_PLACEHOLDER_GALLERY"] : []), ...(dismissChanged ? ["VERIFIED_DISMISSIBLE_REGION"] : [])] };
}
