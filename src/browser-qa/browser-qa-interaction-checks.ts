import {
  createBrowserQACheckResult,
  type BrowserQACheckResult,
  type BrowserQAEvidence,
} from "./browser-qa-domain.js";
import type { BrowserQACheckExecutor } from "./browser-qa-runner.js";

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
            severity: "ERROR",
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
      const expandable = context.page.locator("button[aria-expanded][aria-controls]").first();
      if (await expandable.count()) {
        const before = await expandable.getAttribute("aria-expanded");
        const controlledId = await expandable.getAttribute("aria-controls");
        await expandable.click({ timeout: 2_000 });
        const after = await expandable.getAttribute("aria-expanded");
        const controlledVisible = controlledId
          ? await context.page.locator(`#${escapeCssId(controlledId)}`).isVisible().catch(() => false)
          : false;
        await expandable.click({ timeout: 2_000 }).catch(() => undefined);
        if (before === after && !controlledVisible)
          return result(context, {
            checkId: "interaction-smoke",
            category: "INTERACTION",
            status: "FAIL",
            severity: "ERROR",
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
        const details = summary.locator("..", { has: summary });
        const before = await details.getAttribute("open");
        await summary.click({ timeout: 2_000 });
        const after = await details.getAttribute("open");
        await summary.click({ timeout: 2_000 }).catch(() => undefined);
        return result(context, after === before
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
      const control = context.page.locator("button[aria-expanded][aria-controls]").first();
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
      const visible = targetId ? await context.page.locator(`#${escapeCssId(targetId)}`).isVisible().catch(() => false) : false;
      await control.click({ timeout: 2_000 }).catch(() => undefined);
      return result(context, after !== before && visible
        ? { checkId: "interaction.mobile-nav", category: "INTERACTION", status: "PASS", severity: "ERROR", message: "Mobile navigation opened and exposed its controlled menu" }
        : { checkId: "interaction.mobile-nav", category: "INTERACTION", status: "FAIL", severity: "ERROR", message: "Mobile navigation toggle did not expose its controlled menu" });
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
          const id = control.getAttribute("id");
          if (!control.getAttribute("name")) issues.push("form control without name");
          if (!control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby") && !(id && document.querySelector(`label[for="${CSS.escape(id)}"]`))) issues.push("form control without label");
        }
        return issues.slice(0, 25);
      });
      return result(context, findings.length
        ? { checkId: "form-smoke", category: "FORM", status: "FAIL", severity: "ERROR", message: `${findings.length} form smoke finding${findings.length === 1 ? "" : "s"}`, evidence: findings.map((message): BrowserQAEvidence => ({ type: "element", locatorDescription: "form control", accessibleName: message })) }
        : { checkId: "form-smoke", category: "FORM", status: "PASS", severity: "ERROR", message: "Form controls have names and labels; no submission was triggered" });
    },
  },
  {
    definition: definition("browser-safety-events", "INTERACTION", "ERROR", 1_000),
    async execute(context) {
      const events = [...context.events.dialogs, ...context.events.popups, ...context.events.downloads];
      return result(context, events.length
        ? { checkId: "browser-safety-events", category: "INTERACTION", status: "FAIL", severity: "ERROR", message: "Unexpected dialog, popup, or download was handled", evidence: events }
        : { checkId: "browser-safety-events", category: "INTERACTION", status: "PASS", severity: "ERROR", message: "No unexpected dialog, popup, or download occurred" });
    },
  },
];

function escapeCssId(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function interactionEvidence(message: string): BrowserQAEvidence {
  return { type: "element", locatorDescription: "semantic interactive control", accessibleName: message };
}
