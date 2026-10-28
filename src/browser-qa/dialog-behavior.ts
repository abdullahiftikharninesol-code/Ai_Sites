import type { Locator, Page } from "playwright";

/** Every enabled visible dismissal must work. Multiple legitimate close
 * controls are ordinary UI, not a Playwright selector ambiguity. */
export async function probeDialogBehavior(page: Page, surface: Page | Locator): Promise<void> {
  const managed = surface.locator('[data-sites-capability="dialog"] > button');
  const trigger = (await managed.count() ? managed : surface.getByRole("button", { name: /(?:view|open|read|explore).*(?:project|details|case|more)|details/i })).filter({ visible: true }).first();
  if (!await trigger.count() || !await trigger.isEnabled()) throw new Error("Requested dialog trigger is absent");
  const pinnedTrigger = await trigger.elementHandle({ timeout: 800 });
  if (!pinnedTrigger) throw new Error("Dialog trigger disappeared before activation");
  try {
  const visibleDialogs = page.getByRole("dialog").filter({ visible: true });
  if (await visibleDialogs.count()) throw new Error("Dialog is already visible before its trigger is activated");
  const open = async () => {
    await pinnedTrigger.click({ timeout: 800 });
    await visibleDialogs.first().waitFor({ state: "visible", timeout: 800 });
    if (await visibleDialogs.count() !== 1) throw new Error("Dialog trigger opens multiple ambiguous dialogs");
    const content = await visibleDialogs.evaluate(element => {
      const copy = (node: Element): string => {
        if (!node.getClientRects().length || ["hidden", "collapse"].includes(getComputedStyle(node).visibility) ||
          node.matches("button,[role=button],script,style")) return "";
        return [...node.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent ?? "" : child instanceof Element ? copy(child) : "").join(" ").trim();
      };
      return copy(element);
    });
    if (!content) throw new Error("Dialog has no meaningful project details");
    return visibleDialogs;
  };
  let dialog = await open();
  const closeButtons = () => dialog.getByRole("button", { name: /\b(?:close|dismiss)\b/i }).filter({ visible: true });
  const controls = await closeButtons().evaluateAll(elements => elements.map(element => ({
    id: element.id, label: element.getAttribute("aria-label"), text: element.textContent?.trim(),
    enabled: !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true",
  })));
  if (!controls.some(control => control.enabled)) throw new Error("Dialog has no usable Close control");
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
    if (await visibleDialogs.count()) throw new Error("Dialog Close control does not close its panel");
    if (controls.slice(index + 1).some(control => control.enabled)) dialog = await open();
  }
  } finally { await pinnedTrigger.dispose(); }
}
