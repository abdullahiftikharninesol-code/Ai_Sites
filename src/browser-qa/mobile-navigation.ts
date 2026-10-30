import type { Locator, Page } from "playwright";

/** Discovery hints only. The caller must still prove expansion, real links,
 * dismissal and destination navigation. Neither text nor ARIA alone is a pass. */
export async function mobileNavigationToggle(page: Page): Promise<Locator | undefined> {
  const buttons = page.getByRole("button").filter({ visible: true });
  const candidates = await buttons.evaluateAll(elements => elements.flatMap((element, index) => {
    if ((element instanceof HTMLButtonElement && element.disabled) || element.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-haspopup") === "dialog") return [];
    const id = element.getAttribute("aria-controls"), panel = id ? document.getElementById(id) : null;
    const navigation = !!panel && (panel.matches('nav,[role="navigation"],[role="menu"]') || !!panel.querySelector('nav,[role="navigation"],[role="menu"]'));
    const expanded = element.hasAttribute("aria-expanded");
    const label = element.getAttribute("aria-label") || (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim() || element.textContent || "";
    const named = /\b(?:menu|navigation|nav)\b/i.test(label) && !/\?\s*$/.test(label);
    // A known FAQ answer, tab panel or dialog is not navigation just because
    // its trigger mentions the word navigation.
    const otherPanel = panel?.matches('p,input,textarea,[role="tabpanel"],[role="dialog"]');
    if (navigation && expanded) return [{ index, score: 0 }];
    if (otherPanel) return [];
    if (named && expanded) return [{ index, score: 1 }];
    // Conditional panels may not exist until opened. A header controller is
    // a candidate even with a localized/icon-only name; behavior proves it.
    if (id && expanded && element.closest('header,[role="banner"],nav,[role="navigation"]')) return [{ index, score: 2 }];
    return named ? [{ index, score: 3 }] : [];
  }));
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  return candidates.length ? buttons.nth(candidates[0]!.index) : undefined;
}
