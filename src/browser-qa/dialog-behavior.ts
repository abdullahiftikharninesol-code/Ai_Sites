import { FunctionalValidationError } from "./browser-qa-failure.js";
import type { ElementHandle, Locator, Page } from "playwright";

/** Semantic hints prioritize discovery; opening a real dialog proves it. */
async function discoverDialogTrigger(page: Page, surface: Page | Locator): Promise<ElementHandle<HTMLElement | SVGElement>> {
  const explicit = surface.locator('[data-sites-capability="dialog"] > button,[aria-haspopup="dialog"]');
  const named = surface.getByRole("button", { name: /(?:view|open|read|explore|inspect|preview).*(?:project|details|case|more|course|record)|details/i });
  const cards = surface.getByRole("button").filter({ has: page.getByRole("heading") });
  const other = surface.getByRole("button");
  const identities = new Set<string>();
  const candidates: { selector: string; signature: string }[] = [];
  for (const group of [explicit, named, cards, other]) for (const control of await group.filter({ visible: true }).all()) {
    if (!await control.isEnabled() || await control.evaluate(element => (element as HTMLButtonElement).type === "submit" && !!element.closest("form"))) continue;
    const identity = await control.evaluate(element => {
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.id && document.querySelectorAll('[id=' + JSON.stringify(node.id) + ']').length === 1) { parts.unshift('[id=' + JSON.stringify(node.id) + ']'); break; }
        const index = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName).indexOf(node) + 1 : 1;
        parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      }
      return { selector: parts.join(' > '), signature: JSON.stringify([element.tagName, element.id, element.getAttribute('role'), element.getAttribute('aria-label'), element.getAttribute('aria-controls'), element.textContent]) };
    });
    if (!identities.has(identity.selector)) { identities.add(identity.selector); candidates.push(identity); }
  }
  const url = page.url();
  const dialogs = page.getByRole("dialog").filter({ visible: true });
  if (await dialogs.count()) throw new FunctionalValidationError("Dialog is already visible before its trigger is activated");
  const limit = 8;
  for (const [index, candidate] of candidates.slice(0, limit).entries()) {
    // Discovery must not inherit a filter/menu opened by an unrelated control.
    if (index) { await page.goto(url, { waitUntil: "load", timeout: 3000 }); await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))); }
    const control = page.locator(candidate.selector);
    if (await control.count() !== 1 || !await control.isVisible()) throw new Error("Dialog discovery control identity changed after reset");
    const signature = await control.evaluate(element => JSON.stringify([element.tagName, element.id, element.getAttribute('role'), element.getAttribute('aria-label'), element.getAttribute('aria-controls'), element.textContent]));
    if (signature !== candidate.signature) throw new Error("Dialog discovery control identity changed after reset");
    const handle = await control.elementHandle({ timeout: 800 });
    if (!handle) throw new Error("Dialog discovery control disappeared");
    try {
      await handle.click({ timeout: 800 });
      // An accessible name is only a hint. Require an actual visible native or
      // ARIA dialog, without class-name assumptions or forced interactions.
      try { await dialogs.first().waitFor({ state: "visible", timeout: 800 }); }
      catch (error) { if (error instanceof Error && error.name === "TimeoutError" && !await dialogs.count()) { await handle.dispose(); continue; } throw error; }
      return handle;
    } catch (error) { await handle.dispose(); throw error; }
  }
  if (candidates.length > limit) throw new Error("Dialog discovery budget exhausted; remaining controls were not validated");
  throw new FunctionalValidationError("Requested dialog trigger is absent or does not open an accessible dialog");
}

/** Every enabled visible dismissal must work. Multiple legitimate close
 * controls are ordinary UI, not a Playwright selector ambiguity. */
export async function probeDialogBehavior(page: Page, surface: Page | Locator): Promise<void> {
  const pinnedTrigger = await discoverDialogTrigger(page, surface);
  try {
  const visibleDialogs = page.getByRole("dialog").filter({ visible: true });
  const open = async (reopen = true) => {
    if (reopen) await pinnedTrigger.click({ timeout: 800 });
    await visibleDialogs.first().waitFor({ state: "visible", timeout: 800 });
    if (await visibleDialogs.count() !== 1) throw new FunctionalValidationError("Dialog trigger opens multiple ambiguous dialogs");
    const content = await visibleDialogs.evaluate(element => {
      const copy = (node: Element): string => {
        if (!node.getClientRects().length || ["hidden", "collapse"].includes(getComputedStyle(node).visibility) ||
          node.matches("button,[role=button],script,style")) return "";
        return [...node.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent ?? "" : child instanceof Element ? copy(child) : "").join(" ").trim();
      };
      return copy(element);
    });
    if (!content) throw new FunctionalValidationError("Dialog has no meaningful project details");
    return visibleDialogs;
  };
  let dialog = await open(false);
  const closeButtons = () => dialog.getByRole("button", { name: /\b(?:close|dismiss)\b/i }).filter({ visible: true });
  const controls = await closeButtons().evaluateAll(elements => elements.map(element => ({
    id: element.id, label: element.getAttribute("aria-label"), text: element.textContent?.trim(),
    enabled: !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true",
  })));
  if (!controls.some(control => control.enabled)) throw new FunctionalValidationError("Dialog has no usable Close control");
  for (const [index, expected] of controls.entries()) {
    if (!expected.enabled) continue;
    const current = closeButtons();
    if (await current.count() !== controls.length) throw new Error("Dialog Close controls changed ambiguously between activations");
    const close = current.nth(index);
    const actual = await close.evaluate(element => ({ id: element.id, label: element.getAttribute("aria-label"), text: element.textContent?.trim() }));
    if (actual.id !== expected.id || actual.label !== expected.label || actual.text !== expected.text)
      throw new Error("Dialog Close control identity changed between activations");
    await close.click({ timeout: 800 });
    await dialog.waitFor({ state: "hidden", timeout: 800 });
    if (await visibleDialogs.count()) throw new FunctionalValidationError("Dialog Close control does not close its panel");
    if (controls.slice(index + 1).some(control => control.enabled)) dialog = await open();
  }
  } finally { await pinnedTrigger.dispose(); }
}
