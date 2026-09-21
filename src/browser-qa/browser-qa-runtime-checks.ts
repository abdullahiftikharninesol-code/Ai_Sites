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
) => ({ checkId, version: 1, category, defaultSeverity, scope: "VIEWPORT" as const, timeoutMs });

export const browserQARuntimeChecks: readonly BrowserQACheckExecutor[] = [
  {
    definition: definition("broken-images", "ASSET", "ERROR", 3_000),
    async execute(context) {
      const broken = await context.page.evaluate(() => [...document.images]
        .filter((image) => {
          const box = image.getBoundingClientRect();
          const visible = box.width > 0 && box.height > 0;
          return visible && image.complete && image.naturalWidth === 0;
        })
        .map((image) => image.currentSrc || image.src)
        .slice(0, 50));
      return result(context, broken.length
        ? {
            checkId: "broken-images",
            category: "ASSET",
            status: "FAIL",
            severity: "ERROR",
            message: `${broken.length} visible image${broken.length === 1 ? "" : "s"} failed to load`,
            evidence: broken.map((url): BrowserQAEvidence => ({ type: "network", url, resourceType: "image", failureText: "Image naturalWidth is zero" })),
          }
        : {
            checkId: "broken-images",
            category: "ASSET",
            status: "PASS",
            severity: "ERROR",
            message: "Visible images loaded successfully",
          });
    },
  },
  {
    definition: { ...definition("accessibility-smoke", "ACCESSIBILITY", "WARNING", 3_000), scope: "PAGE" as const },
    async execute(context) {
      const findings = await context.page.evaluate(() => {
        const issues: string[] = [];
        const accessibleName = (element: Element): string => {
          const aria = element.getAttribute("aria-label")?.trim();
          if (aria) return aria;
          const labelledBy = element.getAttribute("aria-labelledby");
          if (labelledBy) return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
          return (element.textContent ?? "").trim();
        };
        for (const element of document.querySelectorAll("button, [role=button]"))
          if (!accessibleName(element)) issues.push("unnamed button");
        for (const input of document.querySelectorAll("input, textarea, select")) {
          const id = input.getAttribute("id");
          const labelled = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          if (!labelled && !input.getAttribute("aria-label") && !input.getAttribute("aria-labelledby")) issues.push("unlabeled form control");
        }
        for (const image of document.querySelectorAll("img"))
          if (!image.hasAttribute("alt") && image.getAttribute("role") !== "presentation" && image.getAttribute("aria-hidden") !== "true") issues.push("image without alt representation");
        const ids = new Set<string>();
        for (const element of document.querySelectorAll("[id]")) {
          const id = element.id;
          if (ids.has(id)) issues.push(`duplicate id: ${id.slice(0, 100)}`);
          ids.add(id);
        }
        return issues.slice(0, 50);
      });
      return result(context, findings.length
        ? {
            checkId: "accessibility-smoke",
            category: "ACCESSIBILITY",
            status: "WARNING",
            severity: "WARNING",
            message: `${findings.length} accessibility smoke finding${findings.length === 1 ? "" : "s"}`,
            evidence: findings.map((message): BrowserQAEvidence => ({ type: "element", locatorDescription: "runtime accessibility smoke", accessibleName: message })),
          }
        : {
            checkId: "accessibility-smoke",
            category: "ACCESSIBILITY",
            status: "PASS",
            severity: "WARNING",
            message: "Basic runtime accessibility smoke passed",
          });
    },
  },
];
