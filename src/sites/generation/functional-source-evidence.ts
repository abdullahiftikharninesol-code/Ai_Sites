import ts from "typescript";
import type { FunctionalCapability } from "./functional-capabilities.js";

export type FunctionalSourceState = "RECOGNIZED" | "PROVEN_MISSING" | "UNCERTAIN";
export interface FunctionalSourceAssessment {
  readonly state: FunctionalSourceState;
  readonly reason: "STRUCTURAL_MATCH_REQUIRES_BEHAVIOR" | "NO_POSSIBLE_RENDERED_CONTROL" | "DYNAMIC_OR_CUSTOM_IMPLEMENTATION";
}
export interface FunctionalSourcePart { readonly file: ts.SourceFile; readonly node: ts.Node }
const capabilities: readonly FunctionalCapability[] = ["cart", "quantity", "size", "gallery", "category-filter", "product-navigation", "mobile-nav", "tabs", "accordion", "dialog", "search", "form", "newsletter"];
const managed: Readonly<Record<string, readonly FunctionalCapability[]>> = {
  Accordion: ["accordion"], Tabs: ["tabs"], DemoDialog: ["dialog"], DemoForm: ["form"], ContactSection: ["form"], MobileNav: ["mobile-nav"],
  CategoryFilter: ["category-filter"], ProductSearch: ["search"], NewsletterSignup: ["newsletter"], ProductGallery: ["gallery"],
  SizeSelector: ["size"], QuantityControl: ["quantity"], CartPanel: ["cart"], CartTrigger: ["cart"], AddToCartButton: ["cart"],
};

/** Syntax is evidence of a candidate, never proof that its interaction works.
 * Missing is provable only for a closed render graph with no possible control.
 * Comments, copy, function names and unrendered imports are not feature evidence. */
export function assessFunctionalSource(
  parts: readonly FunctionalSourcePart[], omitted: readonly ts.Node[], graphComplete: boolean,
  component: (file: ts.SourceFile, name: string) => { readonly kind: "LOCAL" | "MANAGED" | "OPAQUE"; readonly exportName?: string },
): Readonly<Record<FunctionalCapability, FunctionalSourceAssessment>> {
  const recognized = new Set<FunctionalCapability>(), possible = new Set<FunctionalCapability>();
  let opaque = !graphComplete;
  let activeOmitted: readonly ts.Node[] = [];
  const contained = (outer: ts.Node, inner: ts.Node) => outer.getSourceFile() === inner.getSourceFile() && inner.pos >= outer.pos && inner.end <= outer.end;
  const visit = (node: ts.Node, file: ts.SourceFile): void => {
    if (activeOmitted.some(other => other === node || contained(other, node))) return;
    if (ts.isCallExpression(node) && /(?:^|\.)(?:createElement|cloneElement|createPortal|insertAdjacentHTML|appendChild|replaceChildren|render)$/.test(node.expression.getText(file))) opaque = true;
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && ["innerHTML", "outerHTML"].includes(node.left.name.text)) opaque = true;
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const value = node.expression;
      const primitive = ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind);
      const routed = activeOmitted.some(other => contained(value, other));
      if (!primitive && !routed && !ts.isJsxElement(value) && !ts.isJsxSelfClosingElement(value) && !ts.isJsxFragment(value)) opaque = true;
    }
    if (ts.isReturnStatement(node) && node.expression && !ts.isJsxElement(node.expression) && !ts.isJsxSelfClosingElement(node.expression) && !ts.isJsxFragment(node.expression) &&
      !ts.isStringLiteralLike(node.expression) && !ts.isNumericLiteral(node.expression) && node.expression.kind !== ts.SyntaxKind.NullKeyword) opaque = true;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      const attributes = node.attributes.properties;
      const attribute = (name: string) => attributes.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(file) === name);
      const literal = (name: string) => {
        const value = attribute(name)?.initializer;
        return value && ts.isStringLiteral(value) ? value.text : value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression) ? value.expression.text : undefined;
      };
      if (/^[A-Z]/.test(tag)) {
        const resolved = component(file, tag);
        if (resolved.kind === "MANAGED") for (const capability of managed[resolved.exportName ?? ""] ?? []) recognized.add(capability);
        else if (resolved.kind === "OPAQUE") opaque = true;
      } else {
        if (attributes.some(ts.isJsxSpreadAttribute)) opaque = true;
        if (tag === "form") { recognized.add("form"); possible.add("newsletter"); }
        if (tag === "details") recognized.add("accordion");
        if (tag === "dialog" || literal("role") === "dialog") recognized.add("dialog");
        if (["tab", "tablist"].includes(literal("role") ?? "")) recognized.add("tabs");
        if (tag === "input" && literal("type") === "search") recognized.add("search");
        const interactive = ["button", "input", "select", "textarea", "summary"].includes(tag) || ["button", "tab", "radio", "combobox"].includes(literal("role") ?? "") || !!attribute("onClick") || !!attribute("onKeyDown");
        if (interactive) for (const capability of capabilities) possible.add(capability);
        if (tag === "a") possible.add("product-navigation");
        if (tag === "nav") possible.add("mobile-nav");
        if (tag === "img") possible.add("gallery");
      }
    }
    ts.forEachChild(node, child => visit(child, file));
  };
  for (const part of parts) {
    activeOmitted = omitted.filter(node => node !== part.node && contained(part.node, node));
    visit(part.node, part.file);
  }
  return Object.fromEntries(capabilities.map(capability => [capability,
    recognized.has(capability) ? { state: "RECOGNIZED", reason: "STRUCTURAL_MATCH_REQUIRES_BEHAVIOR" }
      : opaque || possible.has(capability) ? { state: "UNCERTAIN", reason: "DYNAMIC_OR_CUSTOM_IMPLEMENTATION" }
        : { state: "PROVEN_MISSING", reason: "NO_POSSIBLE_RENDERED_CONTROL" },
  ])) as Record<FunctionalCapability, FunctionalSourceAssessment>;
}
