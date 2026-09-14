import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { VisualQAConfig } from "./visual-qa-config.js";
import type { VisualQAProvider, VisualQAAttempt, VisualQAReport } from "./visual-qa-types.js";
import type { BrowserRenderer } from "./browser-renderer.js";
import { VisualRepairContextFormatter } from "./visual-repair-context.js";
export interface VisualQARunRequest {
  readonly siteId: string;
  readonly versionKey: string;
  readonly previewUrl: string;
  readonly siteSpec?: unknown;
  readonly repair: (context: string, attempt: number) => Promise<string>;
}
export class VisualQARunner {
  readonly formatter = new VisualRepairContextFormatter();
  constructor(
    readonly renderer: BrowserRenderer,
    private readonly provider: VisualQAProvider,
    private readonly artifacts: ArtifactStore,
    private readonly config: VisualQAConfig,
  ) {}
  get strict(): boolean {
    return this.config.strict;
  }
  async run(request: VisualQARunRequest): Promise<VisualQAReport> {
    const started = Date.now();
    const attempts: VisualQAAttempt[] = [];
    let url = request.previewUrl;
    let repairs = 0;
    let previousRefs: string[] = [];
    for (let attempt = 1; attempt <= this.config.maxRepairAttempts + 1; attempt++) {
      const renders = await this.renderer.render({
        url,
        viewports: this.config.viewports,
        artifactPrefix: `sites/${request.siteId}/versions/${request.versionKey}/screenshots/attempt-${attempt}`,
      });
      const result = await this.provider.evaluate({
        siteId: request.siteId,
        ...(request.siteSpec ? { siteSpec: request.siteSpec } : {}),
        renders,
      });
      const screenshotRefs = renders.map((render) => render.screenshot.artifactRef);
      attempts.push({
        attemptNumber: attempt,
        screenshots: renders.map((render) => render.screenshot),
        issues: result.issues,
        score: result.score,
        result: result.recommendation,
        renderDurationMs: renders.reduce((sum, render) => sum + render.renderDurationMs, 0),
        createdAt: new Date(),
      });
      if (this.config.screenshotRetentionMode === "FINAL_ONLY" && previousRefs.length)
        await Promise.all(previousRefs.map((ref) => this.artifacts.delete(ref)));
      previousRefs = screenshotRefs;
      if (result.recommendation !== "REPAIR")
        return this.#save(request, attempts, repairs, started, result);
      if (repairs >= this.config.maxRepairAttempts)
        return this.#save(request, attempts, repairs, started, {
          ...result,
          passed: false,
          recommendation: "MANUAL_REVIEW",
        });
      repairs++;
      url = await request.repair(this.formatter.format(result), repairs);
    }
    throw new Error("Unreachable visual QA loop state");
  }
  async #save(
    request: VisualQARunRequest,
    attempts: VisualQAAttempt[],
    repairs: number,
    started: number,
    finalResult: VisualQAReport["finalResult"],
  ): Promise<VisualQAReport> {
    const artifactRef = `sites/${request.siteId}/versions/${request.versionKey}/qa/report.json`;
    const report = {
      finalResult,
      attempts,
      visualRepairAttempts: repairs,
      browserLaunches: attempts.length,
      screenshotsCaptured: attempts.reduce((sum, attempt) => sum + attempt.screenshots.length, 0),
      renderDurationMs: attempts.reduce((sum, attempt) => sum + attempt.renderDurationMs, 0),
      visualQaDurationMs: Date.now() - started,
      artifactRef,
    };
    await this.artifacts.put(artifactRef, Buffer.from(JSON.stringify(report)), {
      kind: "VISUAL_QA_REPORT",
      contentType: "application/json",
    });
    return report;
  }
}
