import type { VisualQAResult } from "./visual-qa-types.js";
export class VisualRepairContextFormatter {
  constructor(private readonly maxIssues = 12) {}
  format(result: VisualQAResult): string {
    const issues = result.issues
      .filter((issue) => issue.severity !== "INFO")
      .slice(0, this.maxIssues);
    return [
      "[VISUAL_REPAIR] Apply targeted component/CSS fixes. Do not regenerate the project.",
      `Score: ${result.score}; recommendation: ${result.recommendation}`,
      ...issues.map(
        (issue) =>
          `- ${issue.viewport} ${issue.severity} ${issue.type}: ${issue.description}${issue.selector ? `; selector ${issue.selector}` : ""}${issue.suggestedAction ? `; action ${issue.suggestedAction}` : ""}${issue.screenshotRef ? `; screenshot ${issue.screenshotRef}` : ""}`,
      ),
    ].join("\n");
  }
}
