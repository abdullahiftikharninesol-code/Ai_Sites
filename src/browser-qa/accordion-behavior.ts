import { FunctionalValidationError } from "./browser-qa-failure.js";
import type { Locator, Page } from "playwright";
import { mobileNavigationToggle } from "./mobile-navigation.js";

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 25));
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 700;
  do { if (await check()) return; await pause(); } while (Date.now() < end);
  throw new FunctionalValidationError(message);
}

/** Read rendered answer text, excluding trigger labels, navigation and controls.
 * Also honor clipping ancestors so a collapsed max-height panel is not visible. */
async function answerText(surface: Locator): Promise<string> {
  return surface.evaluateAll(elements => elements.flatMap(element => {
    if (element.closest('button,[role="button"],summary,nav,[role="navigation"],[role="menu"],[role="dialog"],form')) return [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), texts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement, value = node.textContent?.trim();
      if (!parent || !value || !/[\p{L}\p{N}]/u.test(value) || parent.closest('button,[role="button"],summary,nav,[role="navigation"],[role="menu"],form,script,style,[role="status"],[role="alert"]')) continue;
      if (parent.closest("details:not([open])")) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const box = range.getBoundingClientRect(); if (!box.width || !box.height) continue;
      let visible = true, top = box.top, bottom = box.bottom, left = box.left, right = box.right;
      for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0") { visible = false; break; }
        const bounds = ancestor.getBoundingClientRect();
        if (/(?:hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        if (/(?:hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (bottom <= top || right <= left) { visible = false; break; }
      }
      if (visible) texts.push(value.replace(/\s+/g, " "));
    }
    return texts;
  }).join("\n"));
}

async function localSurfaces(button: Locator): Promise<Locator[]> {
  const controlled = (await button.getAttribute("aria-controls"))?.trim().split(/\s+/).filter(Boolean);
  if (controlled?.length) {
    // Keep the declared relation authoritative. A missing/wrong panel is a
    // broken relation, not permission to accept an unrelated page update.
    return controlled.slice(0, 4).map(id => button.page().locator(`[id=${JSON.stringify(id)}]`));
  }
  const surfaces: Locator[] = [button.locator("xpath=following-sibling::*[1]")];
  let parent = button;
  for (let depth = 0; depth < 5; depth++) {
    parent = parent.locator("..");
    const info = await parent.evaluate(element => ({ tag: element.tagName, controls: element.querySelectorAll('button,[role="button"],summary').length,
      excluded: !!element.closest('nav,[role="navigation"],[role="menu"],[role="dialog"]') }));
    if (["BODY", "HTML", "MAIN"].includes(info.tag) || info.excluded) break;
    if (info.tag !== "SECTION") surfaces.push(parent.locator("xpath=following-sibling::*[1]"));
    if (info.controls === 1) surfaces.push(parent);
    if (info.tag === "SECTION") break;
  }
  return surfaces;
}

async function exercise(button: Locator, surfaces: readonly Locator[], expanded: () => Promise<boolean | undefined>): Promise<void> {
  const initial = await expanded(), before = await Promise.all(surfaces.map(answerText));
  await button.click({ timeout: 1_200 });
  let chosen = -1, after: string[] = [], opening = true;
  await until(async () => {
    after = await Promise.all(surfaces.map(answerText));
    for (let index = 0; index < after.length; index++) {
      const oldText = before[index]!, newText = after[index]!;
      const grows = newText.length > oldText.length && newText.includes(oldText);
      const shrinks = oldText.length > newText.length && oldText.includes(newText);
      if ((initial === false && grows || initial === true && shrinks || initial === undefined && (grows || shrinks)) && await expanded() !== initial) {
        chosen = index; opening = grows; return true;
      }
      if (initial === undefined && (grows || shrinks)) { chosen = index; opening = grows; return true; }
    }
    return false;
  }, "Accordion changes no visible, meaningful local answer content");
  const surface = surfaces[chosen]!, original = before[chosen]!;
  if (initial !== undefined && await expanded() !== !initial) throw new FunctionalValidationError("Accordion expanded state does not follow its visible answer");
  await button.click({ timeout: 1_200 });
  await until(async () => await answerText(surface) === original && (initial === undefined || await expanded() === initial),
    opening ? "Accordion does not hide its answer when closed" : "Accordion does not restore its answer when opened");
  // Exact restoration above also rejects cosmetic label/state changes and
  // panels left visible after aria-expanded was changed to false.
}

/** Bounded native/ARIA/custom FAQ probes, independent of CSS/component names. */
export async function probeAccordionBehavior(page: Page, surface: Page | Locator = page): Promise<void> {
  let tested = 0;
  for (const details of (await surface.locator("details").all()).slice(0, 8)) {
    if (!(await details.isVisible())) continue;
    const summary = details.locator("summary").first();
    if (!(await summary.isVisible().catch(() => false))) throw new FunctionalValidationError("Accordion has no reachable summary control");
    await exercise(summary, [details], async () => await details.getAttribute("open") !== null); tested++;
  }
  const buttons = surface.getByRole("button");
  const navigationToggle = await (await mobileNavigationToggle(page))?.elementHandle();
  try {
  for (const button of await buttons.all()) {
    if (tested >= 8) break;
    if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
    if (navigationToggle && await button.evaluate((element, navigation) => element === navigation, navigationToggle)) continue;
    const eligible = await button.evaluate(element => {
      if (element.closest('details,nav,[role="navigation"],[role="menu"],[role="tablist"],[role="dialog"]')) return false;
      const name = element.getAttribute("aria-label") ?? element.textContent ?? "";
      if (/^(?:(?:open|close|toggle)\s+)?(?:menu|navigation|(?:shopping\s+)?cart|bag)(?:\s*\d*|\s*\(\d+\))?$/i.test(name.trim())) return false;
      const panels = (element.getAttribute("aria-controls") ?? "").split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
      if (panels.some(panel => panel!.matches('nav,[role="navigation"],[role="menu"],[role="tablist"],[role="dialog"]'))) return false;
      return element.hasAttribute("aria-expanded") || !!element.closest('h2,h3,h4,h5,h6,[role="heading"]') || /[?؟]/.test(name);
    });
    if (!eligible) continue;
    await exercise(button, await localSurfaces(button), async () => {
      const value = await button.getAttribute("aria-expanded"); return value === null ? undefined : value === "true";
    }); tested++;
  }
  } finally { await navigationToggle?.dispose(); }
  if (!tested) throw new FunctionalValidationError("Requested accordion has no reachable question/summary control");
}
