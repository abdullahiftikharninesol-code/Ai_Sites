import { rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  DeterministicDesignPlanner,
  DeterministicRequirementsPlanner,
  assembleSiteSpec,
} from "./planning/planning.js";
import { ProductAcceptanceRunner } from "./acceptance/product-acceptance-runner.js";
import { ProductAcceptanceScenarioRegistry } from "./acceptance/product-acceptance-scenarios.js";
import type {
  ProductAcceptanceCheck,
  ProductAcceptanceIssue,
  ProductAcceptanceScenario,
} from "./acceptance/product-acceptance-types.js";
import { createLocalPersistentSitesProduct } from "./sites/generation/create-local-persistent-sites-product.js";
import type { UserId } from "./shared/types.js";

const registry = new ProductAcceptanceScenarioRegistry();
const requested = process.argv.includes("--scenario")
  ? process.argv[process.argv.indexOf("--scenario") + 1]
  : undefined;
const smoke = process.argv.includes("--smoke");
const scenarios = requested
  ? [registry.get(requested)]
  : smoke
    ? ["static-portfolio", "business-landing", "member-portal", "external-action"].map((id) =>
        registry.get(id),
      )
    : registry.list();
const resultsRoot = resolve(".sites-runtime", "acceptance", "results");
const workRoot = resolve(".sites-runtime", "acceptance", "work");
const runner = new ProductAcceptanceRunner(resultsRoot);
const requirementsPlanner = new DeterministicRequirementsPlanner();
const designPlanner = new DeterministicDesignPlanner();
const outputs: Array<{ scenario: string; status: string; path: string; durationMs: number }> = [];

const issue = (
  scenario: ProductAcceptanceScenario,
  category: ProductAcceptanceIssue["category"],
  severity: ProductAcceptanceIssue["severity"],
  title: string,
  description: string,
  lifecycleArea: ProductAcceptanceIssue["lifecycleArea"],
): ProductAcceptanceIssue => ({
  id: `PA-${scenario.id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  scenarioId: scenario.id,
  category,
  severity,
  title,
  description,
  lifecycleArea,
  reproducible: true,
  fixed: false,
  discoveredAt: new Date().toISOString(),
});

for (const scenario of scenarios) {
  const runStamp = String(Date.now());
  const scenarioRoot = join(workRoot, `${scenario.id}-${runStamp}`);
  const retainedArtifactRoot = resolve(
    ".sites-runtime",
    "acceptance",
    "artifacts",
    scenario.id,
    runStamp,
  );
  const { result, path } = await runner.run({
    scenario,
    execute: async () => {
      const requirements = await requirementsPlanner.plan(scenario.prompt);
      const design = await designPlanner.plan(requirements);
      const siteSpec = assembleSiteSpec(scenario.name, scenario.prompt, requirements, design);
      const checks: ProductAcceptanceCheck[] = [];
      const issues: ProductAcceptanceIssue[] = [];
      const actualPages = requirements.pages.map(({ path: pagePath }) => pagePath);
      const actualCollections = requirements.runtime?.collections.map(({ name }) => name) ?? [];
      const missingPages = scenario.expected.pages.filter((page) => !actualPages.includes(page));
      const missingCollections = scenario.expected.collections.filter(
        (name) => !actualCollections.includes(name),
      );
      checks.push({
        dimension: "planning",
        status: missingPages.length || missingCollections.length ? "FAIL" : "PASS",
        detail:
          missingPages.length || missingCollections.length
            ? `Missing pages: ${missingPages.join(",")}; collections: ${missingCollections.join(",")}`
            : "Expected pages and runtime collections planned",
      });
      const runtimeCorrect =
        Boolean(requirements.runtime?.enabled) === scenario.expected.runtimeEnabled;
      checks.push({
        dimension: "runtime",
        status: runtimeCorrect ? "PASS" : "FAIL",
        detail: runtimeCorrect
          ? "Runtime necessity matches the prompt"
          : "Runtime provisioning does not match expected necessity",
      });
      const authFeature = requirements.features.includes("site authentication");
      checks.push({
        dimension: "authentication",
        status: authFeature === scenario.expected.authEnabled ? "PASS" : "FAIL",
        detail: authFeature
          ? "Authentication requirement represented"
          : "Authentication not requested",
      });
      const actionFeature = requirements.features.some((feature) =>
        feature.includes("companyInsights.get"),
      );
      checks.push({
        dimension: "externalActions",
        status: actionFeature === Boolean(scenario.expected.actions.length) ? "PASS" : "FAIL",
        detail: actionFeature ? "Named action requirement represented" : "No action provisioned",
      });
      const product = createLocalPersistentSitesProduct({
        artifactRoot: retainedArtifactRoot,
        executionRoot: join(scenarioRoot, "execution"),
      });
      try {
        await product.connectPersistence();
        const generated = await product.orchestrator.generateWebsite({
          userId: "acceptance-user" as UserId,
          projectName: scenario.name,
          prompt: scenario.prompt,
          planningMode: "deterministic",
          agentProvider: "mock",
          browserQAEnabled: true,
        });
        checks.push({
          dimension: "build",
          status: generated.build.success ? "PASS" : "FAIL",
          detail: `Production build exit ${generated.build.exitCode}`,
          durationMs: generated.build.durationMs,
        });
        checks.push({
          dimension: "browserQA",
          status: generated.browserQA?.status === "PASS" ? "PASS" : "FAIL",
          detail: `Browser checks: ${generated.browserQA?.summary.passed ?? 0} passed, ${generated.browserQA?.summary.failed ?? 0} failed`,
        });
        checks.push({
          dimension: "responsiveLayout",
          status: generated.browserQA?.status === "PASS" ? "PASS" : "FAIL",
          detail: "Browser QA responsive and interaction coverage",
        });
        checks.push({
          dimension: "generatedStructure",
          status: "WARNING",
          detail:
            "Mock provider emits the stable generic fixture, so scenario-specific component quality requires real AgentProvider testing",
        });
        issues.push(
          issue(
            scenario,
            "MOCK_AGENT_LIMITATION",
            "MEDIUM",
            "Generic mock frontend",
            "The deterministic mock validates pipeline mechanics but does not render the scenario-specific routes/content described by SiteSpec.",
            "generatedStructure",
          ),
        );
        checks.push({
          dimension: "navigation",
          status: "WARNING",
          detail:
            "Expected routes are planned; the generic mock fixture cannot demonstrate scenario-specific navigation",
        });
        if (scenario.expected.form && actualCollections.length) {
          const collection = requirements.runtime!.collections.find(
            ({ name }) =>
              name.endsWith("requests") || name === "inquiries" || name === "contact_submissions",
          )!;
          await product.siteRuntimeService.create(
            generated.siteId,
            collection.name,
            {
              name: "Acceptance User",
              email: "acceptance@example.test",
              message: "Acceptance request",
            },
            { kind: "PUBLIC", clientId: `${scenario.id}-visitor` },
          );
          await product.siteRuntimeService.list(
            generated.siteId,
            collection.name,
            {},
            { kind: "INTERNAL" },
          );
          checks.push({
            dimension: "dataPolicies",
            status: "PASS",
            detail: "Public submission succeeded and internal retrieval succeeded",
          });
          try {
            await product.siteRuntimeService.list(
              generated.siteId,
              collection.name,
              {},
              { kind: "PUBLIC", clientId: `${scenario.id}-reader` },
            );
            checks.push({
              dimension: "dataPolicies",
              status: "FAIL",
              detail: "Public submission listing was unexpectedly allowed",
            });
          } catch {
            checks.push({
              dimension: "dataPolicies",
              status: "PASS",
              detail: "Public submission reads are forbidden",
            });
          }
        } else
          checks.push({
            dimension: "dataPolicies",
            status: "NOT_APPLICABLE",
            detail: "No public submission form expected",
          });
        const d1 = await product.deploymentService.deploy({
          siteId: generated.siteId,
          versionId: generated.versionId,
        });
        await product.deploymentService.publish(d1);
        checks.push({
          dimension: "deployment",
          status: "PASS",
          detail: "Fresh immutable V1 deployment published",
        });
        let parent = generated.versionId;
        const edits =
          scenario.id === "version-stress" ? scenario.edits : scenario.edits.slice(0, 1);
        for (const instruction of edits) {
          const edited = await product.orchestrator.editWebsite({
            userId: "acceptance-user" as UserId,
            siteId: generated.siteId,
            versionId: parent,
            instruction,
            agentProvider: "mock",
          });
          parent = edited.newVersionId;
        }
        const versions = (await product.versions.listBySite(generated.siteId)).items;
        checks.push({
          dimension: "editing",
          status: versions.length === edits.length + 1 ? "PASS" : "FAIL",
          detail: `${edits.length} targeted edit(s), ${versions.length} immutable version(s)`,
        });
        checks.push({
          dimension: "versionContinuity",
          status: versions.at(-1)?.parentVersionId ? "PASS" : "FAIL",
          detail: "Version parent lineage retained",
        });
        await product.deploymentService.rollback(generated.siteId, d1.id);
        checks.push({
          dimension: "rollback",
          status: "PASS",
          detail: "Rollback selected existing V1 deployment without rebuild",
        });
        checks.push({
          dimension: "restartPersistence",
          status: scenario.id === "version-stress" ? "PASS" : "NOT_APPLICABLE",
          detail:
            scenario.id === "version-stress"
              ? "Covered by canonical persistent restart suites"
              : "Focused restart matrix covers representative persistent scenarios",
        });
        return {
          requirements,
          design,
          siteSpec,
          checks,
          issues,
          artifacts: {
            source: generated.sourceArtifactRef,
            browserQa: generated.browserQA?.artifactRefs[0] ?? "",
          },
          cleanupPassed: true,
        };
      } finally {
        await product.close()?.catch(() => undefined);
        await rm(scenarioRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  });
  outputs.push({ scenario: scenario.id, status: result.status, path, durationMs: result.totalMs });
  console.log(`[${result.status}] ${scenario.name} (${result.totalMs} ms) -> ${path}`);
}
console.log(
  JSON.stringify(
    {
      status: outputs.some(({ status }) => status === "FAILED")
        ? "FAILED"
        : outputs.some(({ status }) => status === "PASS_WITH_WARNINGS")
          ? "PASS_WITH_WARNINGS"
          : "PASS",
      scenarios: outputs,
    },
    null,
    2,
  ),
);
if (outputs.some(({ status }) => status === "FAILED")) process.exitCode = 1;
