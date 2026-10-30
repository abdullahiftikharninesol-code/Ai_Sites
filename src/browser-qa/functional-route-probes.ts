import { FunctionalValidationError } from "./browser-qa-failure.js";
import type { Locator, Page } from "playwright";
import type { BrowserQAPageContext } from "./browser-qa-runner.js";
import { createBrowserQACheckResult, type BrowserQACheckResult } from "./browser-qa-domain.js";
import type { FunctionalRequirement, ResolvedFunctionalContract } from "../sites/generation/functional-route-contract.js";
import { equivalentPage } from "../sites/generation/requested-pages.js";
import { functionalPageSurface, meaningfulPageContent } from "./functional-surfaces.js";
import { classifyBrowserQAFailure } from "./browser-qa-failure.js";
import { mobileNavigationToggle } from "./mobile-navigation.js";

/** Resolve real semantic sections; a descriptive name is never a guessed ID. */
export async function functionalSectionSurface(page: Page, target: FunctionalRequirement["target"]): Promise<Locator> {
  if (target.sectionId) {
    const section = page.locator(`[id=${JSON.stringify(target.sectionId)}]`);
    if (await section.count() !== 1) throw new FunctionalValidationError(`Required explicit section ID ${target.sectionId} is missing or duplicated`);
    await section.waitFor({ state: "visible", timeout: 1_000 }); return section;
  }
  if (!target.sectionName) throw new Error("Section requirement has no explicit identity");
  const sections = page.locator('section,[role="region"]');
  const entries = await sections.evaluateAll(elements => elements.map((element, index) => ({ index,
    visible: !!element.getClientRects().length && !["hidden", "collapse"].includes(getComputedStyle(element).visibility),
    names: [element.getAttribute("aria-label"), ...(element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent),
      ...[...element.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].map(heading => heading.textContent)].filter((name): name is string => !!name?.trim()).map(name => name.trim()),
    descendants: elements.flatMap((other, child) => other !== element && element.contains(other) ? [child] : []),
  })));
  const matches = entries.filter(entry => entry.visible && entry.names.some(name => equivalentPage(name, target.sectionName!)));
  const deepest = matches.filter(entry => !matches.some(other => entry.descendants.includes(other.index)));
  if (deepest.length !== 1) throw new Error(`Required section ${target.sectionName} has ${deepest.length ? "ambiguous" : "no visible"} semantic heading/label`);
  return sections.nth(deepest[0]!.index);
}

const allCategory = /^(?:all(?:\s+(?:projects?|work|products?|categories|items))?|everything|show all)$/i;
const frame = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
async function visibleItems(surface: Page | Locator): Promise<string[]> {
  return surface.locator('article,[data-project],[data-product-id],[data-product],[role="listitem"],[role="grid"] > *,ul > li,button:has(h2,h3,h4),[role="button"]:has(h2,h3,h4)').evaluateAll(elements => elements.filter(element => {
    const style = getComputedStyle(element); return element.getClientRects().length && style.display !== "none" && style.visibility !== "hidden";
  }).filter(element => !elements.some(other => other !== element && other.contains(element))).map(element => {
    const id = element.getAttribute("data-project") || element.getAttribute("data-product-id") || element.getAttribute("data-product");
    const heading = element.querySelector("h2,h3,h4");
    // Ordinal badges and layout-dependent copy may legitimately change after
    // filtering. Compare actual item identity, not its position in the grid.
    return id || heading?.textContent?.trim() || element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ") || "";
  }).filter(Boolean).sort());
}
function subset(before: readonly string[], after: readonly string[]): boolean {
  if (!after.length || after.length >= before.length) return false;
  const remaining = new Map<string, number>();
  for (const item of before) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  return after.every(item => { const count = remaining.get(item) ?? 0; remaining.set(item, count - 1); return count > 0; });
}

/** Honor an explicit panel relation, or prove which semantic navigation opens.
 * Descriptive markup never implies a manufactured DOM ID. */
export async function probeMobileNavigation(page: Page): Promise<void> {
  const initial = await mobileNavigationToggle(page);
  if (!initial) throw new FunctionalValidationError("Requested mobile menu is absent");
  const pinned = await initial.elementHandle({ timeout: 800 });
  if (!pinned) throw new Error("Mobile menu control disappeared before activation");
  try {
  // Resolve by name only once. A changing accessible name is an expected state
  // transition, not a missing button. Stable attributes also support rerenders.
  const controlId = await pinned.getAttribute("id"), controls = await pinned.getAttribute("aria-controls");
  const identity = controlId ? "[id=" + JSON.stringify(controlId) + "]" : controls ? "[aria-controls=" + JSON.stringify(controls) + "][aria-expanded]" : undefined;
  let stable = identity ? page.locator(identity).filter({ visible: true }) : undefined;
  if (stable && await stable.count() !== 1) stable = undefined;
  const toggle = {
    getAttribute: (name: string) => stable ? stable.getAttribute(name, { timeout: 800 }) : pinned.getAttribute(name),
    click: (options: { timeout: number }) => stable ? stable.click(options) : pinned.click(options),
  };
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click({ timeout: 800 });
  const before = await page.evaluateHandle(() => [...document.querySelectorAll("a[href],[role=menuitem][href]")].filter(element => {
    const style = getComputedStyle(element);
    return !!element.getClientRects().length && !["hidden", "collapse"].includes(style.visibility);
  }));
  try {
  await toggle.click({ timeout: 800 }); await frame(page);
  if (await toggle.getAttribute("aria-expanded") !== "true") throw new FunctionalValidationError("Mobile menu does not open");
  const id = await toggle.getAttribute("aria-controls");
  if (id) {
    const target = page.locator(`[id=${JSON.stringify(id)}]`);
    if (await target.count() !== 1 || !await target.isVisible()) throw new FunctionalValidationError("Mobile menu has a missing or hidden explicit navigation panel");
  }
  const revealed = await page.evaluateHandle(({ previous, id }) => {
    const root = id ? document.getElementById(id) : document;
    return [...(root?.querySelectorAll("a[href],[role=menuitem][href]") ?? [])].filter(element => {
      const style = getComputedStyle(element);
      return !previous.includes(element) && !!element.getClientRects().length && !["hidden", "collapse"].includes(style.visibility);
    });
  }, { previous: before, id });
  try {
  if (!await revealed.evaluate(elements => elements.length > 0 && elements.every(element => {
    const href = element.getAttribute("href")?.trim();
    return !!href && !/^(?:javascript:|#)$/i.test(href) && !!element.textContent?.trim();
  }))) throw new FunctionalValidationError("Mobile menu has no newly reachable navigation destinations");
  await toggle.click({ timeout: 800 }); await frame(page);
  if (await toggle.getAttribute("aria-expanded") !== "false" || !await revealed.evaluate(elements => elements.every(element =>
    !element.isConnected || !element.getClientRects().length || ["hidden", "collapse"].includes(getComputedStyle(element).visibility))))
    throw new FunctionalValidationError("Mobile menu does not close its navigation content");
  } finally { await revealed.dispose(); }
  } finally { await before.dispose(); }
  } finally { await pinned.dispose(); }
}

/** Proves filtering and restoration, rather than accepting selection cosmetics or sorting. */
export async function probeCategoryFiltering(page: Page, surface?: Page | Locator): Promise<void> {
  surface ??= await functionalPageSurface(page);
  const selects = surface.getByRole("combobox");
  for (const select of await selects.all()) {
    if (!(await select.isVisible())) continue;
    const options = await select.locator("option").evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() ?? "" })));
    const all = options.find(option => allCategory.test(option.text));
    if (!all || options.length < 3) continue;
    await select.selectOption(all.value); await frame(page); const before = await visibleItems(surface);
    for (const category of options.filter(option => option !== all).slice(0, 6)) {
      await select.selectOption(category.value); await frame(page);
      const after = await visibleItems(surface), selected = await select.inputValue();
      await select.selectOption(all.value); await frame(page);
      if (JSON.stringify(await visibleItems(surface)) !== JSON.stringify(before)) throw new FunctionalValidationError("Category filter All does not restore the complete result set");
      if (selected === category.value && subset(before, after)) return;
    }
    throw new FunctionalValidationError("Category selection does not filter visible results with observable selected state");
  }
  const allButtons = surface.getByRole("button", { name: allCategory }).or(surface.getByRole("tab", { name: allCategory }));
  for (const all of await allButtons.all()) {
    if (!(await all.isVisible()) || !(await all.isEnabled())) continue;
    const group = all.locator("..");
    const choices = group.getByRole("button").or(group.getByRole("tab"));
    const available = [];
    for (const choice of await choices.all()) if (await choice.isVisible() && await choice.isEnabled()) available.push(choice);
    if (available.length < 3) continue;
    await all.click({ timeout: 1_000 }); await frame(page); const before = await visibleItems(surface);
    for (const choice of available) {
      if (allCategory.test((await choice.innerText()).trim())) continue;
      await choice.hover(); await choice.focus(); await frame(page);
      const oldClass = await choice.getAttribute("class"), allClass = await all.getAttribute("class");
      await choice.click({ timeout: 1_000 }); await frame(page);
      const after = await visibleItems(surface);
      const semanticSelected = await choice.getAttribute("aria-pressed") === "true" || await choice.getAttribute("aria-selected") === "true";
      const visibleSelected = oldClass !== await choice.getAttribute("class") && allClass !== await all.getAttribute("class");
      await all.click({ timeout: 1_000 }); await frame(page);
      if (JSON.stringify(await visibleItems(surface)) !== JSON.stringify(before)) throw new FunctionalValidationError("Category filter All does not restore the complete result set");
      if ((semanticSelected || visibleSelected) && subset(before, after)) return;
    }
    throw new FunctionalValidationError("Category buttons are decorative, or do not filter and restore visible results");
  }
  throw new FunctionalValidationError("Requested category filter is absent or has fewer than two reachable categories");
}

export interface FunctionalProbeResult {
  readonly requirementId: string;
  readonly capability: string;
  readonly expectedRoute: string;
  readonly actualRoute: string;
  readonly result: "PASS" | "FAIL";
  readonly sourceEvidence?: FunctionalRequirement["sourceEvidence"];
  readonly sourceAssessment?: FunctionalRequirement["sourceAssessment"];
}
export async function runRouteRequirements(
  context: BrowserQAPageContext,
  contract: ResolvedFunctionalContract,
  probe: (requirement: FunctionalRequirement) => Promise<void>,
): Promise<BrowserQACheckResult> {
  const observations: FunctionalProbeResult[] = [];
  const applicable = contract.requirements.filter(requirement => {
    if (requirement.capability === "mobile-nav" && context.viewport.id !== "MOBILE") return false;
    const routes = requirement.routes ?? [];
    return requirement.target.kind === "SITE" ? routes.includes(context.route) : routes[0] === context.route;
  });
  for (const requirement of applicable) {
    const candidates = requirement.routes ?? [];
    const siteWide = requirement.target.kind === "SITE";
    let error: unknown;
    for (const route of siteWide ? [context.route] : candidates) {
      try {
        const target = new URL(route, context.page.url());
        if (new URL(context.page.url()).pathname !== target.pathname) await context.page.goto(target.toString(), { waitUntil: "load", timeout: 4_000 });
        await context.page.locator("main,#root").first().waitFor({ state: "visible", timeout: 2_000 });
        await frame(context.page);
        if (requirement.target.kind === "SECTION") await functionalSectionSurface(context.page, requirement.target);
        await probe(requirement);
        observations.push({ requirementId: requirement.id, capability: requirement.capability, expectedRoute: route, actualRoute: new URL(context.page.url()).pathname,
          result: "PASS", sourceEvidence: requirement.sourceEvidence, sourceAssessment: requirement.sourceAssessment }); error = undefined; break;
      } catch (cause) {
        error = cause;
        observations.push({ requirementId: requirement.id, capability: requirement.capability, expectedRoute: route, actualRoute: new URL(context.page.url()).pathname,
          result: "FAIL", sourceEvidence: requirement.sourceEvidence, sourceAssessment: requirement.sourceAssessment });
      }
    }
    const detail = error instanceof Error ? error.message : "No implemented required route";
    const boundedDetail = detail.length <= 1500 ? detail : detail.slice(0, 900) + "\n…\n" + detail.slice(-590);
    if (error || !candidates.length) return createBrowserQACheckResult({ checkId: "functional.requirements", category: "INTERACTION", status: "FAIL", severity: "ERROR",
      failureKind: error ? classifyBrowserQAFailure(error, "functional.requirements") : "FUNCTIONAL_FAILURE",
      route: context.route, viewport: context.viewport, message: `${requirement.id} on ${candidates.join(", ")}`.slice(0, 400) + ": " + boundedDetail,
      functionalProbes: observations });
  }
  return createBrowserQACheckResult({ checkId: "functional.requirements", category: "INTERACTION", status: applicable.length ? "PASS" : "SKIPPED", severity: "ERROR",
    route: context.route, viewport: context.viewport, message: applicable.length ? "Route-scoped requested behavior passed observable probes" : "No requested functional behavior is assigned to this route and viewport", functionalProbes: observations });
}

/** Required pages need actual reachable navigation, including collapsed mobile menus. */
export async function probeRequiredNavigation(context: BrowserQAPageContext, contract: ResolvedFunctionalContract): Promise<BrowserQACheckResult> {
  const meaningful = (name: string) => meaningfulPageContent(context.page, name);
  await meaningful("Home");
  for (const page of contract.pages.filter(page => page.route !== "/")) {
    await context.page.goto(new URL("/", context.page.url()).toString(), { waitUntil: "load", timeout: 4_000 });
    const find = async () => {
      for (const link of await context.page.getByRole("link").all()) {
        const href = await link.getAttribute("href"); if (!href) continue;
        const destination = new URL(href, context.page.url());
        if (destination.origin === new URL(context.page.url()).origin && destination.pathname === page.route && await link.isVisible()) return link;
      }
      return undefined;
    };
    let link = await find();
    if (!link) {
      const menu = await mobileNavigationToggle(context.page);
      if (menu) { if (await menu.getAttribute("aria-expanded") !== "true") await menu.click({ timeout: 800 }); await frame(context.page); link = await find(); }
    }
    if (!link) throw new FunctionalValidationError(`Required page ${page.name} has no reachable navigation to ${page.route}`);
    await link.click({ timeout: 1_500 }); await frame(context.page);
    if (new URL(context.page.url()).pathname !== page.route) throw new FunctionalValidationError(`Navigation to ${page.name} did not reach ${page.route}`);
    await meaningful(page.name);
  }
  return createBrowserQACheckResult({ checkId: "functional.navigation", category: "ROUTING", status: "PASS", severity: "ERROR", route: context.route, viewport: context.viewport,
    message: "Every requested page is reachable through the actual navigation" });
}
