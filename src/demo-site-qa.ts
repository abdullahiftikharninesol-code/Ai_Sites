import { resolve } from "node:path";
import { createLocalSitesProduct } from "./sites/generation/create-local-sites-product.js";
import type { UserId } from "./shared/types.js";
const product = createLocalSitesProduct({
  executionRoot: resolve(".sites-runtime/site-qa-demo"),
  artifactRoot: resolve(".local-data/site-qa-demo/artifacts"),
  visualQAEnabled: true,
  visualQaScenario: true,
});
const userId = "visual-qa-demo-user" as UserId;
console.log(
  "Phase 7 offline product demo: Mock Agent + Playwright Chromium + deterministic visual QA",
);
const generated = await product.orchestrator.generateWebsite({
  userId,
  prompt: "Create a responsive modern software product website",
  projectName: "Visual QA Demo",
  planningMode: "deterministic",
  agentProvider: "mock",
  visualQAEnabled: true,
});
const qa = generated.visualQA!;
for (const viewport of qa.attempts[0]!.screenshots.map((shot) => shot.viewport)) {
  const first = qa.attempts[0]!.issues.filter((issue) => issue.viewport === viewport);
  const final = qa.finalResult.viewportResults.find((result) => result.viewport === viewport)!;
  console.log(
    `${viewport}: initial issues ${first.length}; final score ${final.score}; ${final.passed ? "PASS" : "FAIL"}`,
  );
}
console.log(
  `Detected: ${[...new Set(qa.attempts[0]!.issues.map((issue) => issue.type))].join(", ")}`,
);
console.log(`Visual repair attempts: ${qa.visualRepairAttempts}`);
console.log(`Final QA: ${qa.finalResult.recommendation}; score ${qa.finalResult.score}`);
console.log(
  `Screenshots captured: ${qa.screenshotsCaptured}; retained: ${qa.attempts
    .at(-1)!
    .screenshots.map((shot) => shot.artifactRef)
    .join(", ")}`,
);
console.log(
  `Render time: ${qa.renderDurationMs}ms; total QA: ${qa.visualQaDurationMs}ms; build: ${generated.build.durationMs}ms`,
);
const edited = await product.orchestrator.editWebsite({
  userId,
  siteId: generated.siteId,
  versionId: generated.versionId,
  instruction: "Change the hero heading",
  agentProvider: "mock",
  visualQAEnabled: true,
});
console.log(
  `Edit V2 QA: ${edited.visualQA!.finalResult.recommendation}; score ${edited.visualQA!.finalResult.score}; parent ${edited.fromVersionId}`,
);
console.log(
  `Cleanup: environments=${product.execution.getActiveEnvironmentCount()}, browsers=${product.browserRenderer.activeBrowserCount}`,
);
console.log(`Artifacts: ${resolve(".local-data/site-qa-demo/artifacts")}`);
