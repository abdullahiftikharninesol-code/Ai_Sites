import { FunctionalValidationError } from "./browser-qa-failure.js";
import {
  createBrowserQACheckResult,
  type BrowserQACheckResult,
  type BrowserQAEvidence,
} from "./browser-qa-domain.js";
import type { BrowserQACheckExecutor } from "./browser-qa-runner.js";
import type { Page, Locator } from "playwright";

export async function closeControlledPanel(page: Page, control: Locator): Promise<boolean> {
  const id = await control.getAttribute("aria-controls");
  if (!id) return false;
  const panel = page.locator(`[id="${escapeCssId(id)}"]`);
  const close = panel.getByRole("button", { name: /^close(?:\s|$)/i }).first();
  if (!(await panel.isVisible()) || !(await close.count()) || !(await close.isVisible())) return false;
  if (await close.evaluate(element => (element as HTMLButtonElement).type === "submit" && !!element.closest("form"))) return false;
  await close.click({ timeout: 800 });
  return true;
}

/** Close through a real control, never force-click through an overlay or hide it. */
export async function closeVisibleDialog(page: Page): Promise<boolean> {
  const dialogs = page.locator('dialog[open],[role="dialog"]');
  for (const dialog of await dialogs.all()) {
    if (!(await dialog.isVisible())) continue;
    const close = dialog.getByRole("button", { name: /^close(?:\s|$)/i }).last();
    if (await close.count() && await close.isVisible()) await close.click({ timeout: 800 });
    else if (await dialog.evaluate(element => element.tagName === "DIALOG")) await page.keyboard.press("Escape");
    else throw new FunctionalValidationError("Opened dialog has no usable Close control");
    if (await dialog.isVisible()) throw new FunctionalValidationError("Dialog Close control does not close its panel");
    return true;
  }
  return false;
}

export async function probeSizeSelection(page: Page | Locator): Promise<void> {
  const select = page.getByRole("combobox", { name: /^size$/i }).first();
  if (await select.count()) {
    const current = await select.inputValue();
    const options = await select.locator("option").evaluateAll(items => items.filter(item => !(item as HTMLOptionElement).disabled).map(item => (item as HTMLOptionElement).value));
    const alternative = options.find(value => value && value !== current);
    if (!alternative) throw new FunctionalValidationError("Size selector has no alternative usable option");
    await select.selectOption(alternative);
    if (await select.inputValue() !== alternative) throw new FunctionalValidationError("Size selection does not change");
    return;
  }
  const sizes = page.getByRole("button", { name: /^(?:(?:select\s+)?size\s+)?(?:XS|S|M|L|XL|XXL)$/i });
  for (const size of await sizes.all()) {
    if (!(await size.isVisible()) || !(await size.isEnabled()) || await size.getAttribute("aria-pressed") === "true") continue;
    await size.click({ timeout: 800 });
    if (await size.getAttribute("aria-pressed") !== "true") throw new FunctionalValidationError("Size selection exposes no accessible selected state");
    return;
  }
  const group = page.getByRole("radiogroup", { name: /size/i });
  for (const radio of await group.getByRole("radio").all()) {
    if (await radio.isChecked() || !(await radio.isEnabled())) continue;
    await radio.check({ timeout: 800 });
    if (!(await radio.isChecked())) throw new FunctionalValidationError("Size selection does not change");
    return;
  }
  throw new FunctionalValidationError("Requested accessible size control is missing");
}
async function restoreExpansion(page: Page, control: Locator, before: string | null): Promise<void> {
  if (await control.getAttribute("aria-expanded") === before) return;
  if (before === "false" && await closeControlledPanel(page, control)) return;
  await control.click({ timeout: 800 });
}

const result = (
  context: Parameters<BrowserQACheckExecutor["execute"]>[0],
  input: Omit<BrowserQACheckResult, "route" | "viewport">,
): BrowserQACheckResult =>
  createBrowserQACheckResult({ ...input, route: context.route, viewport: context.viewport });

const definition = (
  checkId: string,
  category: BrowserQACheckResult["category"],
  defaultSeverity: BrowserQACheckResult["severity"],
  timeoutMs: number,
) => ({ checkId, version: 1, category, defaultSeverity, scope: "INTERACTION" as const, timeoutMs });

export const browserQAResponsiveAndInteractionChecks: readonly BrowserQACheckExecutor[] = [
  {
    definition: { ...definition("responsive-overflow", "RESPONSIVE", "ERROR", 2_000), scope: "VIEWPORT" as const },
    async execute(context) {
      const layout = await context.page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      const overflowPx = Math.max(0, layout.scrollWidth - layout.viewportWidth);
      return result(context, overflowPx > 1
        ? {
            checkId: "responsive-overflow",
            category: "RESPONSIVE",
            status: "FAIL",
            severity: "WARNING",
            message: `Document overflows the viewport by ${overflowPx}px`,
            evidence: [{ type: "layout", ...layout, overflowPx }],
          }
        : {
            checkId: "responsive-overflow",
            category: "RESPONSIVE",
            status: "PASS",
            severity: "ERROR",
            message: "Document fits within the viewport",
            evidence: [{ type: "layout", ...layout, overflowPx }],
          });
    },
  },
  {
    definition: definition("interaction-smoke", "INTERACTION", "ERROR", 3_000),
    async execute(context) {
      const candidates = context.page.locator("button[aria-expanded][aria-controls]");
      let expandable: Locator | undefined;
      for (const candidate of await candidates.all()) if (await candidate.isVisible() && await candidate.isEnabled()) { expandable = candidate; break; }
      if (expandable) {
        const before = await expandable.getAttribute("aria-expanded");
        const controlledId = await expandable.getAttribute("aria-controls");
        await expandable.click({ timeout: 2_000 });
        const after = await expandable.getAttribute("aria-expanded");
        const controlledVisible = controlledId
          ? await context.page.locator(`[id="${escapeCssId(controlledId)}"]`).isVisible().catch(() => false)
          : false;
        await restoreExpansion(context.page, expandable, before);
        if (before === after && !controlledVisible)
          return result(context, {
            checkId: "interaction-smoke",
            category: "INTERACTION",
            status: "FAIL",
            severity: "WARNING",
            message: "Expandable control did not expose a changed state or visible controlled content",
            evidence: [{
              type: "element",
              locatorDescription: "button[aria-expanded][aria-controls]",
              ...(await expandable.textContent() ? { accessibleName: (await expandable.textContent())! } : {}),
            }],
          });
        return result(context, {
          checkId: "interaction-smoke",
          category: "INTERACTION",
          status: "PASS",
          severity: "ERROR",
          message: "Representative expandable control changed state safely",
        });
      }
      const summary = context.page.locator("details > summary").first();
      if (await summary.count()) {
        const details = summary.locator("xpath=parent::details");
        const before = await details.getAttribute("open");
        await summary.click({ timeout: 2_000 });
        const after = await details.getAttribute("open");
        await summary.click({ timeout: 2_000 }).catch(() => undefined);
        const restored = await details.getAttribute("open");
        return result(context, (before !== null) === (after !== null) || (restored !== null) !== (before !== null)
          ? {
              checkId: "interaction-smoke",
              category: "INTERACTION",
              status: "FAIL",
              severity: "ERROR",
              message: "Representative details/summary control did not change state",
            }
          : {
              checkId: "interaction-smoke",
              category: "INTERACTION",
              status: "PASS",
              severity: "ERROR",
              message: "Representative details/summary control changed state safely",
            });
      }
      return result(context, {
        checkId: "interaction-smoke",
        category: "INTERACTION",
        status: "SKIPPED",
        severity: "INFO",
        message: "No supported semantic expandable control was present",
      });
    },
  },
  {
    definition: definition("interaction.mobile-nav", "INTERACTION", "ERROR", 3_000),
    async execute(context) {
      if (context.viewport.id !== "MOBILE")
        return result(context, {
          checkId: "interaction.mobile-nav",
          category: "INTERACTION",
          status: "SKIPPED",
          severity: "INFO",
          message: "Mobile navigation is scoped to the mobile viewport",
        });
      const controls = context.page.locator("button[aria-expanded][aria-controls]");
      let control: Locator | undefined;
      for (const candidate of await controls.all()) {
        const id = await candidate.getAttribute("aria-controls");
        const label = (await candidate.getAttribute("aria-label")) || (await candidate.innerText());
        const target = id ? context.page.locator(`[id="${escapeCssId(id)}"]`) : undefined;
        const navigation = target && await target.count() && await target.evaluate(element => element.tagName === "NAV" || element.getAttribute("role") === "navigation");
        if (navigation || /\b(?:menu|navigation)\b/i.test(label)) { control = candidate; break; }
      }
      if (!control) return result(context, { checkId: "interaction.mobile-nav", category: "INTERACTION", status: "SKIPPED", severity: "INFO", message: "No semantic mobile navigation toggle was present" });
      if (!(await control.count()))
        return result(context, {
          checkId: "interaction.mobile-nav",
          category: "INTERACTION",
          status: "SKIPPED",
          severity: "INFO",
          message: "No semantic mobile navigation toggle was present",
        });
      const before = await control.getAttribute("aria-expanded");
      await control.click({ timeout: 2_000 });
      const after = await control.getAttribute("aria-expanded");
      const targetId = await control.getAttribute("aria-controls");
      const visible = targetId ? await context.page.locator(`[id="${escapeCssId(targetId)}"]`).isVisible().catch(() => false) : false;
      await restoreExpansion(context.page, control, before);
      return result(context, after !== before && visible
        ? { checkId: "interaction.mobile-nav", category: "INTERACTION", status: "PASS", severity: "ERROR", message: "Mobile navigation opened and exposed its controlled menu" }
        : { checkId: "interaction.mobile-nav", category: "INTERACTION", status: "FAIL", severity: "WARNING", message: "Mobile navigation toggle did not expose its controlled menu" });
    },
  },
  {
    definition: definition("form-smoke", "FORM", "ERROR", 3_000),
    async execute(context) {
      if (!(await context.page.locator("form").count()))
        return result(context, {
          checkId: "form-smoke",
          category: "FORM",
          status: "SKIPPED",
          severity: "INFO",
          message: "No form was present for safe form smoke",
        });
      const findings = await context.page.evaluate(() => {
        const issues: string[] = [];
        for (const control of document.querySelectorAll("input, textarea, select")) {
          if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image"].includes(control.type)) continue;
          if (!control.getAttribute("name")) issues.push("form control without name");
          const field = control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          const native = [...(field.labels ?? [])].some(label => !!label.textContent?.trim());
          const labelled = (control.getAttribute("aria-labelledby") ?? "").split(/\s+/).some(id => !!document.getElementById(id)?.textContent?.trim());
          if (!control.getAttribute("aria-label")?.trim() && !labelled && !native) issues.push("form control without label");
        }
        return issues.slice(0, 25);
      });
      return result(context, findings.length
        ? { checkId: "form-smoke", category: "FORM", status: "FAIL", severity: "WARNING", message: `${findings.length} form smoke finding${findings.length === 1 ? "" : "s"}`, evidence: findings.map((message): BrowserQAEvidence => ({ type: "element", locatorDescription: "form control", accessibleName: message })) }
        : { checkId: "form-smoke", category: "FORM", status: "PASS", severity: "ERROR", message: "Form controls have names and labels; no submission was triggered" });
    },
  },
  {
    definition: definition("browser-safety-events", "INTERACTION", "ERROR", 1_000),
    execute(context) {
      const events = [...context.events.dialogs, ...context.events.popups, ...context.events.downloads];
      return Promise.resolve(result(context, events.length
        ? { checkId: "browser-safety-events", category: "INTERACTION", status: "FAIL", severity: "ERROR", message: "Unexpected dialog, popup, or download was handled", evidence: events }
        : { checkId: "browser-safety-events", category: "INTERACTION", status: "PASS", severity: "ERROR", message: "No unexpected dialog, popup, or download occurred" }));
    },
  },
];

function escapeCssId(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function interactionEvidence(message: string): BrowserQAEvidence {
  return { type: "element", locatorDescription: "semantic interactive control", accessibleName: message };
}
