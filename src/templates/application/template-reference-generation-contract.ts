import { createHash } from "node:crypto";
import ts from "typescript";
import { ApplicationError } from "../../app/errors/application-error.js";
import { extractExplicitSiteName, validateSiteNameCandidate } from "../../sites/generation/site-name.js";
import type { SiteSpec } from "../../sites/domain/site-spec.js";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import { validateReferenceInteractions } from "../../cli/runtime/reference-interaction-validator.js";
import { createBrowserQACheckResult } from "../../browser-qa/browser-qa-domain.js";
import type { BrowserQACheckExecutor } from "../../browser-qa/browser-qa-runner.js";
import { closeVisibleDialog, probeSizeSelection } from "../../browser-qa/browser-qa-interaction-checks.js";
import type { ResolvedTemplateDesignReference } from "./template-design-context.js";

const identity = (value: string) => value.replace(/&amp;|&#38;/gi, "&").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export const requestedTemplateReferenceIdentity = (prompt: string): string | undefined => {
  const explicit = extractExplicitSiteName(prompt);
  if (explicit) return explicit;
  // The legacy naming heuristic does not recognize a standalone ampersand.
  // Handle it for reference requirements without changing scratch generation.
  const candidate = /\bfor\s+([^,\n.!?]{1,60}\s&\s[^,\n.!?]{1,60})(?=\s*[,\n.!?]|$)/iu.exec(prompt)?.[1];
  return validateSiteNameCandidate(candidate);
};

/** Only enrich a reference run from the user's requirements, never from reference routes. */
export function templateReferenceSiteSpec(spec: SiteSpec, prompt: string): SiteSpec {
  const pages = [...spec.requirements.pages];
  const add = (name: string, path: string) => { if (!pages.some((page) => page.path === path)) pages.push({ name, path }); };
  if (/\bproduct[- ]detail(?:s)?\b/i.test(prompt)) add("Product Detail", "/product");
  for (const match of prompt.matchAll(/\b([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)\s+page\b/gi)) {
    const name = match[1]!.replace(/^(?:a|an|the|new|create|build)\s+/i, "");
    if (!/^(?:home|landing|web|this|each|every|another|product[- ]details?)$/i.test(name)) add(name, `/${name.toLowerCase().replace(/\s+/g, "-")}`);
  }
  const features = [
    ...spec.requirements.features,
    ...([
      [/categor(?:y|ies)/i, "categories"], [/featured products/i, "featured products"], [/product cards/i, "product cards"],
      [/sale badges/i, "sale badges"], [/newsletter/i, "newsletter signup"], [/footer/i, "footer"],
      [/add to cart/i, "Add to Cart interaction"], [/quantity/i, "quantity controls"], [/\bsizes?\b/i, "size selection"],
    ] as const).filter(([pattern]) => pattern.test(prompt)).map(([, name]) => name),
  ];
  return { ...spec, project: { ...spec.project, name: requestedTemplateReferenceIdentity(prompt) ?? spec.project.name }, requirements: { ...spec.requirements, pages, features } };
}

/** Fail closed before materialization; no extra inference or repair loop is introduced. */
export function validateTemplateReferenceBundle(bundle: SiteCoderFileBundle, reference: ResolvedTemplateDesignReference, prompt: string, options: { readonly acceptance?: "USABLE_WEBSITE" } = {}): readonly { readonly check: string; readonly message: string }[] {
  if (options.acceptance !== "USABLE_WEBSITE") validateReferenceInteractions(bundle);
  const advisories: { check: string; message: string }[] = [];
  const incompleteIdentity = (message: string) => {
    if (options.acceptance !== "USABLE_WEBSITE") throw new ApplicationError("GENERATION_INCOMPLETE", message);
    advisories.push({ check: "template-reference.identity", message });
  };
  const requested = requestedTemplateReferenceIdentity(prompt);
  const literals: string[] = [];
  for (const file of bundle.files) {
    if (!/\.(?:tsx|jsx|ts|js)$/.test(file.path)) continue;
    if (reference.applicationHashes.includes(createHash("sha256").update(file.content).digest("hex")))
      throw new ApplicationError("GENERATION_INCOMPLETE", "The unchanged reference application cannot be accepted as a generated website");
    const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, /x$/.test(file.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const visibleCandidates = identity(literals.join(" "));
  if (requested && !visibleCandidates.includes(identity(requested)))
    incompleteIdentity("The generated application does not implement the requested business identity");
  const forbidden = [...reference.originalBrands, ...(requested ? reference.originalProductNames : [])]
    .filter((value) => identity(value) !== identity(requested ?? ""));
  if (forbidden.some((value) => visibleCandidates.includes(identity(value)) || identity(bundle.siteName ?? "").includes(identity(value))))
    incompleteIdentity("Original template branding or placeholder products remain in the generated application");
  return advisories;
}

/** Browser-level identity/content and requested mock-commerce checks supplement, never replace, shared QA. */
export function templateReferenceBrowserCheck(reference: ResolvedTemplateDesignReference, prompt: string): BrowserQACheckExecutor {
  const requested = requestedTemplateReferenceIdentity(prompt);
  const forbidden = [...reference.originalBrands, ...(requested ? reference.originalProductNames : [])]
    .filter((value) => identity(value) !== identity(requested ?? ""));
  return {
    definition: { checkId: "template-reference.requirements", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 8_000 },
    async execute(context) {
      const issues: string[] = [];
      const text = await context.page.locator("body").innerText();
      const title = await context.page.title();
      if (forbidden.some((value) => identity(`${text}\n${title}`).includes(identity(value)))) issues.push("Original template identity/content is still rendered");
      if (context.route === "/") {
        if (requested && !identity(text).includes(identity(requested))) issues.push("Requested business identity is not rendered");
        if (/\bhero\b/i.test(prompt) && !(await context.page.locator("main h1").count())) issues.push("Requested hero heading is missing");
        if (/categor(?:y|ies)/i.test(prompt) && !/categor|collection/i.test(text)) issues.push("Requested categories are missing");
        if (/featured products|product cards/i.test(prompt) && !(await context.page.locator('main article, main [class*="product"], main [data-product]').count())) issues.push("Requested product cards are missing");
        if (/sale badges/i.test(prompt) && !/sale|%\s*off|save\s+\d+/i.test(text)) issues.push("Requested sale badges are missing");
        if (/newsletter/i.test(prompt) && !(await context.page.locator('form input[type="email"]').count())) issues.push("Requested newsletter signup is missing");
        if (/footer/i.test(prompt) && !(await context.page.locator("footer").count())) issues.push("Requested footer is missing");
      }
      if (context.route === "/product" && /product[- ]detail/i.test(prompt)) {
        if (/gallery/i.test(prompt) && (await context.page.locator('main img, main [role="img"]').count()) < 2) issues.push("Requested product gallery placeholders are missing");
        if (/\bsizes?\b/i.test(prompt)) {
          try { await probeSizeSelection(context.page); }
          catch (error) { issues.push(error instanceof Error ? error.message : "Size selection failed"); }
        }
        if (/quantity/i.test(prompt)) {
          const quantity = context.page.getByRole("spinbutton", { name: /quantity/i }).first();
          const increase = context.page.getByRole("button", { name: /increase quantity/i }).first();
          if (await quantity.count()) { await quantity.fill("2"); if (await quantity.inputValue() !== "2") issues.push("Quantity control does not update"); }
          else if (await increase.count()) {
            const container = increase.locator("..");
            const before = await container.innerText(); await increase.click();
            if (await container.innerText() === before) issues.push("Quantity control does not update");
          } else issues.push("Requested accessible quantity control is missing");
        }
        if (/add to cart/i.test(prompt)) {
          const add = context.page.getByRole("button", { name: /add to (?:cart|bag)/i }).first();
          if (!(await add.count())) issues.push("Requested Add to Cart control is missing");
          else {
            const before = await context.page.locator("body").innerText(); await add.click();
            try { await context.page.waitForFunction((previous) => document.body.innerText !== previous, before, { timeout: 1_000 }); }
            catch { issues.push("Add to Cart has no observable local result"); }
            await closeVisibleDialog(context.page);
          }
        }
      }
      return createBrowserQACheckResult({
        checkId: "template-reference.requirements", category: "INTERACTION", severity: "ERROR",
        status: issues.length ? "FAIL" : "PASS", message: issues.length ? issues.join("; ") : "Requested reference-guided identity, content and supported mock interactions passed",
        route: context.route, viewport: context.viewport,
      });
    },
  };
}
