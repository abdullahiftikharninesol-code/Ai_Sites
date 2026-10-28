import type { Locator, Page, Route } from "playwright";
import { createBrowserQACheckResult } from "./browser-qa-domain.js";
import type { BrowserQACheckExecutor, BrowserQAPageContext } from "./browser-qa-runner.js";
import type { BrowserQACheckResult } from "./browser-qa-domain.js";
import type { FunctionalCapability, FunctionalRequirements } from "../sites/generation/functional-capabilities.js";
import type { FunctionalRequirement, ResolvedFunctionalContract } from "../sites/generation/functional-route-contract.js";
import { functionalSectionSurface, probeCategoryFiltering, probeMobileNavigation, probeRequiredNavigation, runRouteRequirements } from "./functional-route-probes.js";
import { closeControlledPanel, closeVisibleDialog, probeSizeSelection } from "./browser-qa-interaction-checks.js";
import { probeAccordionBehavior } from "./accordion-behavior.js";
import { probeTabs } from "./functional-surfaces.js";
import { probeDialogBehavior } from "./dialog-behavior.js";

async function requireVisible(locator: Locator, message: string): Promise<Locator> {
  const target = locator.first();
  if (!(await target.count()) || !(await target.isVisible())) throw new Error(message);
  return target;
}
const state = (page: Page) => page.evaluate(() => JSON.stringify({ text: document.body.innerText, url: location.href,
  theme: { root: document.documentElement.getAttribute("data-theme"), rootClass: document.documentElement.className,
    bodyClass: document.body.className, foreground: getComputedStyle(document.body).color, background: getComputedStyle(document.body).backgroundColor },
  fields: [...document.querySelectorAll("input,select,textarea")].map(element => ({ value: (element as HTMLInputElement).value, checked: (element as HTMLInputElement).checked })),
  selected: [...document.querySelectorAll("[aria-expanded],[aria-selected],[aria-pressed],[aria-checked],dialog")].map(element => [element.getAttribute("aria-expanded"), element.getAttribute("aria-selected"), element.getAttribute("aria-pressed"), element.getAttribute("aria-checked"), element.hasAttribute("open")]),
  // Icon-only controls can disappear without changing body text or ARIA state.
  // Observe actual rendered controls, not arbitrary DOM/class mutations.
  visibleControls: [...document.querySelectorAll("button,[role=button],input,select,textarea")].filter(element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse";
  }).map(element => [element.tagName, element.id, element.getAttribute("aria-label"), element.textContent]),
  // Task completion may use a visible strikethrough rather than changing text.
  completedText: [...document.querySelectorAll("button,button span,button s,button del,[role=button],[role=button] span")]
    .filter(element => element.getClientRects().length > 0 && element.textContent?.trim())
    .map(element => [element.textContent, getComputedStyle(element).textDecorationLine.includes("line-through")]),
  scroll: [scrollX, scrollY],
}));
async function expectChange(page: Page, before: string, message: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await state(page) !== before) return;
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
  }
  throw new Error(message);
}
async function demoForm(page: Page, capability: "newsletter" | "form", surface: Page | Locator = page) {
  const managed = surface.locator(`form[data-sites-capability="${capability}"]`);
  const form = await requireVisible((await managed.count()) ? managed : surface.locator("form").filter({ has: page.locator('input[type="email"]') }), `Missing ${capability} form`);
  const email = form.locator('input[type="email"]').first();
  if (!(await email.count())) throw new Error(`${capability} form has no email validation`);
  await email.fill("not-an-email");
  if (await form.evaluate(element => (element as HTMLFormElement).checkValidity())) throw new Error(`${capability} accepts invalid email`);
  for (const input of await form.locator("input:not([type=hidden]),textarea").all()) {
    const type = await input.getAttribute("type");
    if (!(await input.isVisible()) || !(await input.isEnabled())) continue;
    if (type === "checkbox" || type === "radio") { if (await input.getAttribute("required") !== null) await input.check({ timeout: 800 }); continue; }
    if (["submit", "button", "reset", "image"].includes(type ?? "")) continue;
    if (await input.getAttribute("readonly") !== null) continue;
    await input.fill(type === "email" ? "offline-qa@example.test" : "Offline demonstration");
  }
  for (const select of await form.locator("select").all()) {
    if (!(await select.isVisible()) || !(await select.isEnabled())) continue;
    const option = await select.locator("option").evaluateAll(options => options.map(option => option as HTMLOptionElement).find(option => !option.disabled && !option.closest("optgroup[disabled]") && option.value.trim())?.value);
    if (option) await select.selectOption(option);
    else if (await select.getAttribute("required") !== null) throw new Error(`${capability} required select has no usable choice`);
  }
  if (!(await form.evaluate(element => (element as HTMLFormElement).checkValidity()))) throw new Error(`${capability} still has invalid required fields after safe local input`);
  const before = await page.locator("body").innerText();
  // Never allow the QA probe to send submissions, even if a generated mock lies.
  const blocked: string[] = [];
  const guard = async (route: Route) => {
    if (route.request().isNavigationRequest() || ["fetch", "xhr"].includes(route.request().resourceType())) {
      blocked.push("Unexpected network submission"); await route.abort();
    } else await route.fallback();
  };
  await page.route("**/*", guard);
  try {
    await form.locator('button[type="submit"],button:not([type]),input[type="submit"]').first().click({ timeout: 800 });
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    const after = await page.locator("body").innerText();
    const feedback = await page.getByRole("status").allTextContents();
    feedback.push(...after.split("\n").filter(line => !before.split("\n").includes(line)));
    if (blocked.length || after === before || !feedback.some(text => /demo|mock|not (?:sent|subscribed)|in this view|local(?:ly)? only/i.test(text)))
      throw new Error(`${capability} needs observable, honest mock confirmation without a network submission`);
  } finally { await page.unroute("**/*", guard); }
}

/** Bounded observable probes. No extra AI role, no remote writes, no severity downgrade. */
export function functionalBrowserChecks(requirements: FunctionalRequirements, routes: readonly string[], backendEnabled = false, contract?: ResolvedFunctionalContract): BrowserQACheckExecutor[] {
  const capabilities = new Set(requirements.capabilities);
  const productRoute = routes.find(route => /\/product(?:s)?(?:\/|$)/.test(route)) ?? "/";
  type ScopedCheck = Omit<BrowserQACheckExecutor, "execute"> & { execute(context: BrowserQAPageContext, selected?: ReadonlySet<FunctionalCapability>, forceRoute?: boolean, section?: FunctionalRequirement["target"]): Promise<BrowserQACheckResult> };
  const checks: ScopedCheck[] = [{
    definition: { checkId: "functional.controls", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "INTERACTION", timeoutMs: 8_000 },
    async execute(context) {
      const initialUrl = context.page.url();
      const buttons = await context.page.getByRole("button").all();
      for (const [index, button] of buttons.slice(0, 12).entries()) {
        // Each independent probe starts from the same page, not a drawer/menu
        // left open by an earlier action. Observed runtime errors stay recorded.
        if (index > 0) {
          await context.page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 3_000 });
          // Wait for React's controls, not unrelated images and two extra frames
          // on every reset. Hover/focus still settle before state comparison.
          await context.page.getByRole("button").first().waitFor({ state: "attached", timeout: 1_000 });
        }
        if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
        if (await button.getAttribute("aria-pressed") === "true" || await button.getAttribute("aria-selected") === "true") continue;
        if (await button.evaluate(element => (element as HTMLButtonElement).type === "submit" && !!element.closest("form"))) continue;
        await button.scrollIntoViewIfNeeded({ timeout: 800 });
        const label = await button.getAttribute("aria-label") || await button.innerText();
        if (await button.getAttribute("aria-expanded") === "true") await closeControlledPanel(context.page, button);
        const expanded = await button.getAttribute("aria-expanded");
        // Hover/focus styling is not a click action. Settle it before recording
        // observable state so cosmetic rollover effects cannot satisfy QA.
        await button.hover({ timeout: 800 });
        await button.focus({ timeout: 800 });
        await context.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        // Dismissal must remove the associated notice, not merely its X button.
        // Unknown custom actions still use the generic observable-state probe.
        const dismiss = /^dismiss\b/i.test(label) ? await button.evaluateHandle(element => {
          const controlled = element.getAttribute("aria-controls");
          const region = controlled ? document.getElementById(controlled) : element.closest('[data-sites-dismissible],[role="alert"],[role="status"],.ai-note,.suggestion,.notice,.notification,.banner,.alert');
          return region && region !== element && region.textContent?.trim() ? region : null;
        }) : undefined;
        const before = await state(context.page);
        try {
          await button.click({ timeout: 800 });
          await expectChange(context.page, before, `Button has no observable action: ${label.slice(0, 80)}`);
          if (dismiss && await dismiss.evaluate(region => !!region)) {
            for (let attempt = 0; attempt < 30; attempt++) {
              if (await dismiss.evaluate(region => !region?.isConnected || region.getClientRects().length === 0 || ["hidden", "collapse"].includes(getComputedStyle(region).visibility))) break;
              if (attempt === 29) throw new Error(`Dismiss control leaves its content visible: ${label.slice(0, 80)}`);
              await context.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
            }
          }
        } finally { await dismiss?.dispose(); }
        if (context.page.url() !== initialUrl) {
          await context.page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 3_000 });
          continue;
        }
        if (expanded !== null && expanded !== await button.getAttribute("aria-expanded")) {
          if (!(expanded === "false" && await closeControlledPanel(context.page, button))) await button.click({ timeout: 800 });
        }
        await closeVisibleDialog(context.page);
      }
      return createBrowserQACheckResult({ checkId: "functional.controls", category: "INTERACTION", status: "PASS", severity: "ERROR", route: context.route, viewport: context.viewport, message: "Bounded visible button probes changed observable state" });
    },
  }, {
    definition: { checkId: "functional.requirements", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "INTERACTION", timeoutMs: 12_000 },
    async execute(context, selected = capabilities, forceRoute = false, section) {
      const page = context.page, capabilities = selected;
      const scoped = section?.kind === "SECTION";
      const surface = scoped ? await functionalSectionSurface(page, section) : page;
      if (forceRoute || context.route === productRoute) {
        if (capabilities.has("size")) await probeSizeSelection(surface);
        if (capabilities.has("quantity")) {
          const quantity = surface.getByRole("spinbutton", { name: /quantity/i }).first();
          if (await quantity.count()) { await quantity.fill("2"); if (await quantity.inputValue() !== "2") throw new Error("Quantity does not update"); }
          else {
            const increase = await requireVisible(surface.getByRole("button", { name: /increase quantity/i }), "Requested quantity controls are absent");
            const before = await state(page); await increase.click({ timeout: 800 }); await expectChange(page, before, "Quantity increment has no effect");
          }
        }
        if (capabilities.has("gallery")) {
          const image = surface.locator('[data-sites-gallery-active],.gallery > img,.gallery-main img,.gallery .large-image img').first();
          const thumbnail = surface.getByRole("button", { name: /^view(?: image)? 2$/i }).first();
          await requireVisible(image, "Requested active gallery image is absent");
          await surface.getByRole("button", { name: /^view(?: image)? 1$/i }).first().click({ timeout: 800 });
          const before = JSON.stringify([await image.getAttribute("src"), await image.getAttribute("alt")]);
          await (await requireVisible(thumbnail, "Requested selectable gallery thumbnails are absent")).click({ timeout: 800 });
          if (JSON.stringify([await image.getAttribute("src"), await image.getAttribute("alt")]) === before) throw new Error("Gallery selection does not change the active image");
        }
        if (capabilities.has("cart")) {
          const cart = await requireVisible(surface.getByRole("button", { name: /^(?:open\s+)?(?:shopping\s+)?(?:cart|bag)(?:\s|\(|,|:|$)/i }), "Requested cart trigger is absent");
          const counter = page.getByRole("status", { name: /(?:cart|bag) count/i });
          const cartCount = async () => (await cart.innerText()) + ((await counter.count()) ? await counter.first().innerText() : "");
          const before = await cartCount();
          const quantityInput = surface.getByRole("spinbutton", { name: /quantity/i }).first();
          const increment = surface.getByRole("button", { name: /increase quantity/i }).first();
          const quantityText = await increment.count() ? await increment.locator("..").innerText() : "1";
          const requestedQuantity = await quantityInput.count() ? Number(await quantityInput.inputValue()) : Number(quantityText.match(/\d+/)?.[0] ?? 1);
          const previousCount = Number(before.match(/\d+/g)?.at(-1) ?? 0);
          await (await requireVisible(surface.getByRole("button", { name: /add to (?:cart|bag)/i }), "Requested Add to Cart is absent")).click({ timeout: 800 });
          const after = await cartCount();
          if (after === before || Number(after.match(/\d+/g)?.at(-1)) !== previousCount + requestedQuantity)
            throw new Error("Add to Cart does not update the actual cart count by the selected quantity");
          // Add to Cart may legitimately open the drawer itself.
          const panel = page.locator('aside[aria-label*="cart" i],aside[aria-label*="bag" i],[role="dialog"][aria-label*="cart" i],[role="dialog"][aria-label*="bag" i]').first();
          if (!(await panel.count()) || !(await panel.isVisible())) await cart.click({ timeout: 800 });
          await requireVisible(panel, "Cart does not open a meaningful cart view");
          const content = await panel.innerText();
          const quantities = [...content.matchAll(/quantity\s*:?\s*(\d+)/gi)].map(match => Number(match[1]));
          for (const increase of await panel.getByRole("button", { name: /increase quantity/i }).all()) {
            const text = await increase.locator("..").innerText();
            const count = text.match(/(?:^|\s)(\d+)(?:\s|$)/)?.[1];
            if (count) quantities.push(Number(count));
          }
          const productHeading = await page.locator("main h1").first().innerText();
          const productWords = productHeading.toLowerCase().split(/\s+/).filter(word => word.length > 3);
          if (!quantities.some(value => value >= requestedQuantity) || /your cart is empty/i.test(content) ||
            !productWords.some(word => content.toLowerCase().includes(word))) throw new Error("Cart does not show the added product and quantity");
          await (await requireVisible(panel.getByRole("button", { name: /close (?:cart|bag|shopping)/i }).last(), "Cart has no Close control")).click({ timeout: 800 });
          if (await panel.isVisible()) throw new Error("Cart Close control does not close its panel");
        }
      }
      if (forceRoute || context.route === "/") {
        if (capabilities.has("category-filter")) {
          await probeCategoryFiltering(page, scoped ? surface : undefined);
        }
        if (capabilities.has("search")) {
          const searches = surface.getByRole("searchbox").or(surface.getByRole("textbox", { name: /search/i }));
          const search = await requireVisible(searches, "Requested search is absent");
          const before = await page.locator("body").innerText(); await search.fill("__no_matching_demo_product__");
          if (await page.locator("body").innerText() === before) throw new Error("Search does not update visible results");
        }
        if (capabilities.has("mobile-nav") && (context.viewport.id === "MOBILE" || await page.getByRole("button", { name: /^(?:menu|(?:open |close )?(?:menu|navigation))$/i }).first().isVisible().catch(() => false))) await probeMobileNavigation(page);
        if (capabilities.has("tabs")) await probeTabs(page, surface);
        if (capabilities.has("accordion")) {
          await probeAccordionBehavior(page, surface);
        }
        if (capabilities.has("dialog")) await probeDialogBehavior(page, surface);
        if (!requirements.backendRequired && !backendEnabled) {
          if (capabilities.has("newsletter")) await demoForm(page, "newsletter", surface);
          if (capabilities.has("form")) await demoForm(page, "form", surface);
        }
      }
      return createBrowserQACheckResult({ checkId: "functional.requirements", category: "INTERACTION", status: "PASS", severity: "ERROR", route: context.route, viewport: context.viewport, message: "Requested scoped functional behavior passed observable probes" });
    },
  }];
  if (contract) {
    const probe = checks[1]!;
    checks[1] = { ...probe, appliesTo: (route, viewport) => contract.requirements.some(requirement =>
      (requirement.capability !== "mobile-nav" || viewport.id === "MOBILE") &&
      (requirement.target.kind === "SITE" ? requirement.routes?.includes(route) : requirement.routes?.[0] === route)),
      execute: context => runRouteRequirements(context, contract, async requirement => {
      await probe.execute(context, new Set([requirement.capability]), true, requirement.target);
    }) };
    checks.push({ definition: { checkId: "functional.navigation", version: 1, category: "INTERACTION", defaultSeverity: "ERROR", scope: "PAGE", timeoutMs: 12_000 },
      appliesTo: route => route === "/" && contract.pages.length > 0,
      execute: context => context.route === "/" ? probeRequiredNavigation(context, contract) : Promise.resolve(createBrowserQACheckResult({ checkId: "functional.navigation", category: "ROUTING", status: "SKIPPED", severity: "ERROR", route: context.route, viewport: context.viewport, message: "Requested navigation is exercised from the site entry route" })),
    });
  }
  return checks;
}
