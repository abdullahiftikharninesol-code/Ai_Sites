import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { Storage } from "@google-cloud/storage";
import { PlaygroundService, loadPlaygroundConfig } from "../dist/dev-server/playground-service.js";

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function terminalJob(service, ownerId, jobId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const job = service.getJob(ownerId, jobId);
    if (job?.status === "SUCCEEDED" || job?.status === "FAILED") return job;
    await wait(500);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function sourceText(service, ownerId, projectId, versionId) {
  const listing = await service.sourceFiles(ownerId, projectId, versionId);
  const text = [];
  for (const file of listing.files) {
    if (file.encoding) continue;
    const value = await service.sourceFiles(ownerId, projectId, versionId, file.path);
    text.push(`--- ${file.path}\n${value.content}`);
  }
  return text.join("\n");
}

async function inspectPreview(browser, previewUrl, routes, screenshotPath) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const statuses = {};
  try {
    for (const route of routes) {
      const response = await page.goto(new URL(route, previewUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      statuses[route] = response?.status() ?? 0;
      await page.waitForTimeout(250);
    }
    await page.goto(new URL("/", previewUrl).toString(), {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    const bodyText = await page.locator("body").innerText();
    const internalLinks = await page.locator('a[href^="/"]').evaluateAll((links) =>
      [...new Set(links.map((link) => link.getAttribute("href")).filter(Boolean))],
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { statuses, bodyText, internalLinks };
  } finally {
    await page.close();
  }
}

async function templateGcsSnapshot(service, keys) {
  const bucket = new Storage().bucket(process.env.SITES_TEMPLATE_GCS_BUCKET.trim());
  const snapshot = {};
  for (const key of keys) {
    const template = await service.product.templateInstantiation.deps.templates.findTemplateVersion(key, 1);
    if (!template?.sourceObject) throw new Error(`Template ${key}@1 has no sourceObject`);
    const [metadata] = await bucket.file(template.sourceObject).getMetadata();
    snapshot[key] = {
      object: template.sourceObject,
      sourceSha256: template.sourceSha256,
      generation: metadata.generation,
      metageneration: metadata.metageneration,
      md5Hash: metadata.md5Hash,
      updated: metadata.updated,
    };
  }
  return snapshot;
}

async function versionArtifacts(projectId, versionId) {
  const root = resolve(".sites-runtime", "playground", "artifacts", "sites", projectId, "versions", versionId);
  const read = async (path) => {
    try { return JSON.parse(await readFile(resolve(root, path), "utf8")); } catch { return undefined; }
  };
  const build = await read("build/build.json");
  const qa = await read("qa/report.json");
  return {
    build: build && { success: build.success, exitCode: build.exitCode },
    qa: qa && { status: qa.status, summary: qa.summary, routes: qa.routes?.length },
  };
}

async function templateCollectionsHash(service) {
  const hash = createHash("sha256");
  for (const name of ["sites_templates", "sites_categories"]) {
    const docs = await service.product.database.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    hash.update(`${name}:${docs.length}:${JSON.stringify(docs)}`);
  }
  return hash.digest("hex");
}

function roleCounts(result) {
  const counts = {};
  for (const task of result.intelligence ?? []) counts[task.taskKind] = (counts[task.taskKind] ?? 0) + 1;
  return counts;
}

function assertBudget(label, result, maxLogical) {
  const counts = roleCounts(result);
  const forbidden = Object.keys(counts).filter((kind) => /planner|coder/i.test(kind));
  const logical = result.workflowJob?.logicalCalls ?? 0;
  if (forbidden.length || logical > maxLogical)
    throw new Error(`AI_CALL_BUDGET_EXCEEDED ${label}: logical=${logical} roles=${JSON.stringify(counts)}`);
}

async function findOwner(service) {
  for (const projectId of [
    "0fea6355-0656-4ecc-9a6b-d46605da4849",
    "6a2a3807-2766-41e0-a9a8-0d8b423f7cc3",
  ]) {
    const project = await service.product.projects.getById(projectId);
    if (project && await service.product.readCanonicalQuota(project.ownerId)) return project.ownerId;
  }
  const quotas = await service.product.database.connection
    .collection("subscriberquotas")
    .find({ is_credit_implemented: true })
    .limit(20)
    .toArray();
  for (const quota of quotas) {
    const ownerId = String(quota.user);
    if (await service.product.readCanonicalQuota(ownerId)) return ownerId;
  }
  throw new Error("No authenticated owner with an enabled canonical quota was found");
}

async function runCase(service, browser, ownerId, definition) {
  const quotaBefore = await service.product.readCanonicalQuota(ownerId);
  const instantiated = await service.instantiateTemplate(
    ownerId,
    definition.templateKey,
    1,
    definition.projectName,
  );
  const quotaAfterInstantiation = await service.product.readCanonicalQuota(ownerId);
  const projectBefore = await service.product.projects.getById(instantiated.projectId);
  const originalSource = await sourceText(
    service,
    ownerId,
    instantiated.projectId,
    instantiated.versionId,
  );
  const started = await service.edit(
    ownerId,
    instantiated.projectId,
    definition.instruction,
    instantiated.versionId,
  );
  const terminal = await terminalJob(service, ownerId, started.id);
  if (terminal.status !== "SUCCEEDED") {
    const failedJob = (await service.product.jobs.listBySite(instantiated.projectId)).items.find((job) => job.operation === "EDIT");
    console.log("EDIT_FAILURE", JSON.stringify({
      projectId: instantiated.projectId,
      versionId: instantiated.versionId,
      error: terminal.error,
      intelligence: terminal.intelligence?.map((task) => ({ taskKind: task.taskKind, status: task.status })),
      job: failedJob && { id: failedJob.id, logicalCalls: failedJob.logicalCalls, physicalRequests: failedJob.physicalRequests, billingStatus: failedJob.billingStatus, creditsCharged: failedJob.creditsCharged },
    }));
    throw new Error(`${definition.templateKey} edit failed: ${terminal.error?.code} ${terminal.error?.message}`);
  }

  const quotaAfter = await service.product.readCanonicalQuota(ownerId);
  const projectAfter = await service.product.projects.getById(instantiated.projectId);
  const versions = (await service.product.versions.listBySite(instantiated.projectId)).items;
  const editedSource = await sourceText(
    service,
    ownerId,
    instantiated.projectId,
    terminal.versionId,
  );
  const workflowJobs = (await service.product.jobs.listBySite(instantiated.projectId)).items;
  const workflowJob = workflowJobs.find((job) => job.operation === "EDIT");
  const screenshot = resolve(".sites-runtime", "phase7-review", `${definition.templateKey}-edited.png`);
  const previewInspection = await inspectPreview(
    browser,
    terminal.preview.url,
    definition.routes,
    screenshot,
  );

  return {
    definition,
    instantiated,
    projectIdUnchanged: projectBefore?.id === projectAfter?.id,
    originalVersionId: instantiated.versionId,
    editedVersionId: terminal.versionId,
    currentVersionId: projectAfter?.latestVersionId,
    versionNumbers: versions.map((version) => ({
      id: version.id,
      number: version.versionNumber,
      parent: version.parentVersionId,
    })),
    originalVersionPreserved: versions.some((version) => version.id === instantiated.versionId),
    originalSourcePreserved: (await sourceText(
      service,
      ownerId,
      instantiated.projectId,
      instantiated.versionId,
    )) === originalSource,
    sourceChecks: definition.sourceChecks(editedSource),
    previewInspection: {
      statuses: previewInspection.statuses,
      internalLinks: previewInspection.internalLinks,
      bodyChecks: definition.bodyChecks(previewInspection.bodyText),
      screenshot,
    },
    quotaBefore: quotaBefore ? {
      tokenCredit: quotaBefore.token_credit,
      tokenCreditUsed: quotaBefore.token_credit_used,
    } : undefined,
    quotaAfterInstantiation: quotaAfterInstantiation ? {
      tokenCredit: quotaAfterInstantiation.token_credit,
      tokenCreditUsed: quotaAfterInstantiation.token_credit_used,
    } : undefined,
    editedArtifacts: await versionArtifacts(instantiated.projectId, terminal.versionId),
    quotaAfter: quotaAfter ? {
      tokenCredit: quotaAfter.token_credit,
      tokenCreditUsed: quotaAfter.token_credit_used,
    } : undefined,
    terminalBilling: {
      billingStatus: terminal.billingStatus,
      creditsCharged: terminal.creditsCharged,
    },
    workflowJob: workflowJob ? {
      status: workflowJob.status,
      provider: workflowJob.provider,
      logicalCalls: workflowJob.logicalCalls,
      physicalRequests: workflowJob.physicalRequests,
      retries: workflowJob.retries,
      model: workflowJob.model,
      inputTokens: workflowJob.inputTokens,
      cachedInputTokens: workflowJob.cachedInputTokens,
      outputTokens: workflowJob.outputTokens,
      totalTokens: workflowJob.totalTokens,
      editJobCount: workflowJobs.filter((job) => job.operation === "EDIT").length,
      billingStatus: workflowJob.billingStatus,
      creditsCharged: workflowJob.creditsCharged,
      modelOutputReceived: workflowJob.modelOutputReceived,
      websiteGenerated: workflowJob.websiteGenerated,
    } : undefined,
    intelligence: terminal.intelligence?.map((task) => ({
      taskKind: task.taskKind,
      status: task.status,
      turns: task.turns,
      toolCalls: task.toolCalls,
    })),
  };
}

const service = new PlaygroundService(loadPlaygroundConfig());
let browser;
try {
  await mkdir(resolve(".sites-runtime", "phase7-review"), { recursive: true });
  await service.start();
  browser = await chromium.launch({ headless: true });
  const ownerId = await findOwner(service);
  // The account the earlier Phase 7 run (job 6ad5b06528c4064515d15a28) used.
  if (ownerId !== "6abde73589aa28cf4fe93f84") throw new Error(`TEST_ACCOUNT_REQUIRED: resolved ${ownerId}`);
  const catalogBefore = JSON.stringify({
    templates: await service.listActiveTemplates({ tags: [], page: 1, limit: 100 }),
    categories: await service.listActiveTemplateCategories(),
  });
  const gcsBefore = await templateGcsSnapshot(service, ["modern-saas", "restaurant"]);
  const collectionsBefore = await templateCollectionsHash(service);
  console.log("OWNER", ownerId);

  const modern = await runCase(service, browser, ownerId, {
    templateKey: "modern-saas",
    projectName: "NovaPay Site",
    instruction: "Rename FlowPilot to NovaPay. Change the primary accent from blue to a deep green and rewrite the hero so the product is an AI-powered finance platform. Keep the existing layout.",
    routes: ["/", "/features", "/pricing", "/about", "/contact"],
    sourceChecks: (source) => ({
      brand: source.includes("NovaPay"),
      hero: /AI-powered finance|AI finance|finance platform/i.test(source),
      color: /deep green|#(?:0[0-9a-f]{5}|1[0-9a-f]{5}|2[0-9a-f]{5})/i.test(source),
    }),
    bodyChecks: (body) => ({
      brand: body.includes("NovaPay"),
      hero: /AI-powered finance|AI finance|finance platform/i.test(body),
    }),
  });

  await service.stopPreview(ownerId, modern.instantiated.preview.sessionId);
  if (modern.instantiated.preview.sessionId !== undefined) {
    const editedPreview = service.previews.list().find((item) => item.siteId === modern.instantiated.projectId);
    if (editedPreview) await service.stopPreview(ownerId, editedPreview.id);
  }
  const restored = await service.startPreview(ownerId, modern.instantiated.projectId, modern.originalVersionId);
  const restoredInspection = await inspectPreview(
    browser,
    restored.previewUrl,
    modern.definition.routes,
    resolve(".sites-runtime", "phase7-review", "modern-saas-restored.png"),
  );
  modern.restore = {
    versionId: modern.originalVersionId,
    routes: restoredInspection.statuses,
    originalBrandVisible: restoredInspection.bodyText.includes("FlowPilot"),
    editedBrandAbsent: !restoredInspection.bodyText.includes("NovaPay"),
  };
  await service.stopPreview(ownerId, restored.previewSessionId);
  modern.roleCounts = roleCounts(modern);
  console.log("MODERN_INTERIM", JSON.stringify({ projectId: modern.instantiated.projectId, roleCounts: modern.roleCounts, workflowJob: modern.workflowJob }));
  assertBudget("modern-saas", modern, 2);
  if ((modern.workflowJob?.logicalCalls ?? 0) > 1)
    throw new Error("STOP_BEFORE_RESTAURANT: Modern SaaS used a build repair, so a Restaurant repair could exceed the 3-call ceiling");

  const restaurant = await runCase(service, browser, ownerId, {
    templateKey: "restaurant",
    projectName: "Saffron House Site",
    instruction: "Rename the restaurant to Saffron House and change the visual direction to warm burgundy and cream. Update the hero and menu copy for modern South Asian dining while preserving the current layout.",
    routes: ["/", "/menu", "/about", "/reservations", "/contact"],
    sourceChecks: (source) => ({
      brand: source.includes("Saffron House"),
      copy: /South Asian/i.test(source),
      color: /burgundy|cream|#[0-9a-f]{6}/i.test(source),
    }),
    bodyChecks: (body) => ({
      brand: body.includes("Saffron House"),
      copy: /South Asian/i.test(body),
    }),
  });

  restaurant.roleCounts = roleCounts(restaurant);
  const gcsAfter = await templateGcsSnapshot(service, ["modern-saas", "restaurant"]);
  const catalogAfter = JSON.stringify({
    templates: await service.listActiveTemplates({ tags: [], page: 1, limit: 100 }),
    categories: await service.listActiveTemplateCategories(),
  });
  console.log("PHASE7_RESULT_START");
  console.log(JSON.stringify({
    provider: service.agentProviderId,
    ownerId,
    catalogUnchanged: catalogBefore === catalogAfter,
    templateGcsUnchanged: JSON.stringify(gcsBefore) === JSON.stringify(gcsAfter),
    templateCollectionsUnchanged: collectionsBefore === await templateCollectionsHash(service),
    gcsBefore,
    totalLogicalCalls: (modern.workflowJob?.logicalCalls ?? 0) + (restaurant.workflowJob?.logicalCalls ?? 0),
    modern,
    restaurant,
  }, null, 2));
  console.log("PHASE7_RESULT_END");
} finally {
  if (browser) await browser.close();
  await service.close();
}
