import { FunctionalValidationError } from "./browser-qa-failure.js";
import type { Locator, Page } from "playwright";

/** A missing landmark is not proof of missing behavior. Accessibility is separate. */
export async function functionalPageSurface(page: Page): Promise<Locator> {
  // QA navigation may return at DOMContentLoaded before React paints. A count
  // query does not auto-wait and would mistake a hydrating page for missing UI.
  await page.locator("body").waitFor({ state: "visible", timeout: 2_000 });
  const main = page.locator("main,[role=main]").filter({ visible: true });
  if (await main.count() === 1) return main;
  const root = page.locator("#root,#app");
  if (await root.count() === 1)
    await root.locator(":scope > :not(script):not(style)").filter({ visible: true }).first().waitFor({ state: "visible", timeout: 2_000 });
  for (const selector of ["main,[role=main]", "#root", "#app", "body"]) {
    const candidates = page.locator(selector).filter({ visible: true });
    if (await candidates.count() === 1) return candidates;
  }
  throw new Error("Page has no unambiguous visible content surface");
}

export async function meaningfulPageContent(page: Page, name: string): Promise<void> {
  const surface = await functionalPageSurface(page);
  // A heading's HTML level is an accessibility concern, not evidence that a
  // navigated page failed to render. Require real visible headings/content.
  await surface.getByRole("heading").filter({ visible: true }).first().waitFor({ state: "visible", timeout: 2_000 });
  const content = await surface.evaluate(element => {
    const text = (node: Element): string => {
      const style = getComputedStyle(node);
      if (!node.getClientRects().length || ["hidden", "collapse"].includes(style.visibility) ||
        node.matches("header,footer,nav,[role=navigation],script,style")) return "";
      return [...node.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent ?? "" : child instanceof Element ? text(child) : "").join(" ").replace(/\s+/g, " ").trim();
    };
    return { text: text(element), headings: [...element.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(node => node.getClientRects().length &&
      !["hidden", "collapse"].includes(getComputedStyle(node).visibility) && !node.closest('header,footer,nav,[role="navigation"],[hidden],[aria-hidden="true"]')).map(node => node.textContent?.trim()).join(" ") };
  });
  if (!content.text || !content.headings || content.text === content.headings)
    throw new FunctionalValidationError("Required page " + name + " has only a heading or empty content");
}

/** Compare local meaningful panel content, not selection cosmetics. */
export async function probeTabs(page: Page, surface: Page | Locator): Promise<void> {
  let tabs = surface.getByRole("tab").filter({ visible: true });
  if (!await tabs.count()) tabs = surface.locator('[role="tablist"] button,.tabs button,[data-sites-capability="tabs"] button').filter({ visible: true });
  if (await tabs.count() < 2) throw new FunctionalValidationError("Requested tabs are absent");
  const original = await tabs.evaluateAll(elements => elements.findIndex(element => element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true" || /\b(?:active|selected)\b/.test(element.getAttribute("class") ?? "")));
  if (original < 0) throw new FunctionalValidationError("Tabs have no observable selected state");
  const other = original === 0 ? 1 : 0;
  const labels = new Set(await tabs.evaluateAll(elements => elements.map(element => (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim().toLocaleLowerCase())));
  // A real price, short description or status may be less than four words.
  // Verify content distinct from tab labels, plus change and restoration;
  // word count is not evidence that a panel is functional.
  const meaningful = (value: string) => /[\p{L}\p{N}]/u.test(value) && !labels.has(value.toLocaleLowerCase());
  const group = tabs.nth(original).locator("..");
  const container = group.locator("..");
  const text = (panel: Locator) => panel.evaluate(element => {
    const copy = (node: Element): string => {
      const style = getComputedStyle(node);
      if (!node.getClientRects().length || ["hidden", "collapse"].includes(style.visibility) ||
        node.matches("button,[role=tablist],nav,header,footer,script,style")) return "";
      return [...node.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent ?? "" : child instanceof Element ? copy(child) : "").join(" ").replace(/\s+/g, " ").trim();
    };
    return copy(element);
  });
  const panel = async (tab: Locator): Promise<Locator> => {
    const id = await tab.getAttribute("aria-controls");
    if (id) {
      const target = page.locator("[id=" + JSON.stringify(id) + "]");
      if (await target.count() !== 1 || !await target.isVisible() || !(await target.innerText()).trim())
        throw new FunctionalValidationError("Tab has a missing, hidden or empty explicit panel");
      return target;
    }
    const semantic = container.getByRole("tabpanel").filter({ visible: true });
    if (await semantic.count() === 1) return semantic;
    // A custom panel can omit role=tabpanel, but it must be local to the tab
    // group. Unrelated counters elsewhere on the page cannot prove tab behavior.
    const siblings = group.locator("xpath=following-sibling::*").filter({ visible: true });
    const candidates: Locator[] = [];
    for (const sibling of await siblings.all()) if (meaningful(await text(sibling))) candidates.push(sibling);
    if (candidates.length !== 1) throw new Error("Tabs have no unambiguous local meaningful panel");
    return candidates[0]!;
  };
  const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const selected = (tab: Locator) => tab.evaluate(element => element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true" || /\b(?:active|selected)\b/.test(element.getAttribute("class") ?? ""));
  const before = await text(await panel(tabs.nth(original)));
  if (!meaningful(before)) throw new FunctionalValidationError("Tabs have no meaningful initial panel content");
  try {
    await tabs.nth(other).click({ timeout: 800 }); await settle();
    const after = await text(await panel(tabs.nth(other)));
    if (!await selected(tabs.nth(other)) || after === before || !meaningful(after))
      throw new FunctionalValidationError("Tabs do not switch visible meaningful content");
  } finally { await tabs.nth(original).click({ timeout: 800 }); await settle(); }
  if (!await selected(tabs.nth(original)) || await text(await panel(tabs.nth(original))) !== before)
    throw new FunctionalValidationError("Tabs do not restore the original panel");
}
