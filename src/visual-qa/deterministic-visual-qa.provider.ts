import { randomUUID } from "node:crypto";
import type {
  BrowserViewportResult,
  ElementObservation,
  VisualIssue,
  VisualQAProvider,
  VisualQARequest,
  VisualQAResult,
  VisualSeverity,
  ViewportQAResult,
} from "./visual-qa-types.js";
export const SEVERITY_DEDUCTIONS: Readonly<Record<VisualSeverity, number>> = {
  INFO: 0,
  LOW: 3,
  MEDIUM: 8,
  HIGH: 20,
  CRITICAL: 40,
};
export function scoreVisualIssues(issues: readonly VisualIssue[]): number {
  return Math.max(
    0,
    100 - issues.reduce((total, issue) => total + SEVERITY_DEDUCTIONS[issue.severity], 0),
  );
}
export function suspiciousOverlap(a: ElementObservation, b: ElementObservation): boolean {
  if (
    a.selector === b.selector ||
    ![a.tag, b.tag].some((tag) => ["button", "a", "h1", "h2", "input"].includes(tag))
  )
    return false;
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const area = Math.max(0, width) * Math.max(0, height);
  const smaller = Math.min(
    (a.right - a.left) * (a.bottom - a.top),
    (b.right - b.left) * (b.bottom - b.top),
  );
  return smaller > 0 && area / smaller > 0.35;
}
export class DeterministicVisualQAProvider implements VisualQAProvider {
  constructor(private readonly passScore = 90) {}
  evaluate(request: VisualQARequest): Promise<VisualQAResult> {
    const viewportResults = request.renders.map((render) => this.#viewport(render));
    const issues = viewportResults.flatMap((result) => result.issues);
    const score = scoreVisualIssues(issues);
    const hardFailure = issues.some((issue) => ["HIGH", "CRITICAL"].includes(issue.severity));
    const actionableScore = scoreVisualIssues(
      issues.filter((issue) => !["INFO", "LOW"].includes(issue.severity)),
    );
    const recommendation =
      hardFailure || actionableScore < this.passScore
        ? ("REPAIR" as const)
        : issues.length
          ? ("PASS" as const)
          : ("PASS" as const);
    return Promise.resolve({
      passed: recommendation === "PASS",
      score,
      issues,
      viewportResults,
      summary: issues.length
        ? `${issues.length} objective rendering issue(s); score ${score}`
        : "No objective rendering issues detected",
      recommendation,
    });
  }
  #viewport(render: BrowserViewportResult): ViewportQAResult {
    const issues: VisualIssue[] = [];
    const add = (issue: Omit<VisualIssue, "id" | "viewport" | "screenshotRef">) =>
      issues.push({
        id: randomUUID(),
        viewport: render.viewport.name,
        screenshotRef: render.screenshot.artifactRef,
        ...issue,
      });
    if (render.documentWidth > render.viewport.width + 1)
      add({
        type: "HORIZONTAL_SCROLL",
        severity: "HIGH",
        description: `Document width ${render.documentWidth}px exceeds ${render.viewport.width}px viewport`,
        suggestedAction:
          "Remove fixed widths and constrain content with width: 100% and max-width.",
      });
    for (const element of render.elements) {
      if (element.right > render.viewport.width + 2 || element.left < -2)
        add({
          type: render.viewport.name === "MOBILE" ? "MOBILE_LAYOUT" : "CONTENT_OUTSIDE_VIEWPORT",
          severity: "HIGH",
          description: `${element.selector} extends outside the viewport (${Math.round(element.left)}..${Math.round(element.right)}px)`,
          selector: element.selector,
          elementHint: element.text,
          suggestedAction:
            "Inspect this component and replace fixed sizing with responsive constraints.",
        });
      if (
        (element.scrollWidth > element.clientWidth + 2 ||
          element.scrollHeight > element.clientHeight + 2) &&
        ["hidden", "clip"].includes(element.overflow)
      )
        add({
          type: "TEXT_CLIPPING",
          severity: "MEDIUM",
          description: `${element.selector} clips its content`,
          selector: element.selector,
          elementHint: element.text,
          suggestedAction: "Allow wrapping or remove restrictive fixed height/width.",
        });
      if (element.text && element.fontSize > 0 && element.fontSize < 10)
        add({
          type: "TYPOGRAPHY_SCALE",
          severity: "LOW",
          description: `${element.selector} uses ${element.fontSize}px text`,
          selector: element.selector,
        });
      if (element.text && (element.opacity === 0 || element.visibility === "hidden"))
        add({
          type: "INVISIBLE_CONTENT",
          severity: "MEDIUM",
          description: `${element.selector} contains hidden content`,
          selector: element.selector,
        });
    }
    for (const image of render.brokenImages)
      add({
        type: "BROKEN_IMAGE",
        severity: "HIGH",
        description: `Image failed to render: ${image}`,
        elementHint: image,
        suggestedAction: "Replace or remove the invalid image source.",
      });
    for (const error of [...render.runtimeErrors, ...render.consoleErrors])
      add({
        type: "RUNTIME_RENDER_ERROR",
        severity: "CRITICAL",
        description: error.slice(0, 500),
        suggestedAction: "Inspect the runtime error and repair the relevant component.",
      });
    render.failedResources
      .filter((resource) => /\.(png|jpe?g|webp|gif|svg)(?:\?|\s|$)/i.test(resource))
      .forEach((resource) =>
        add({
          type: "MISSING_IMAGE",
          severity: "MEDIUM",
          description: `Image request failed: ${resource.slice(0, 300)}`,
        }),
      );
    for (let i = 0; i < render.elements.length; i++)
      for (let j = i + 1; j < render.elements.length; j++)
        if (suspiciousOverlap(render.elements[i]!, render.elements[j]!)) {
          add({
            type: "ELEMENT_OVERLAP",
            severity: "LOW",
            description: `${render.elements[i]!.selector} substantially overlaps ${render.elements[j]!.selector}`,
            selector: render.elements[i]!.selector,
            suggestedAction: "Review positioning; intentional overlays may be ignored.",
          });
          break;
        }
    const score = scoreVisualIssues(issues);
    const actionableScore = scoreVisualIssues(
      issues.filter((issue) => !["INFO", "LOW"].includes(issue.severity)),
    );
    return {
      viewport: render.viewport.name,
      passed:
        !issues.some((issue) => ["HIGH", "CRITICAL"].includes(issue.severity)) &&
        actionableScore >= this.passScore,
      score,
      issues,
      screenshotRef: render.screenshot.artifactRef,
    };
  }
}
