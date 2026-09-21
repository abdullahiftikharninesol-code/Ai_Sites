import { createHash } from "node:crypto";
import { ApplicationError } from "../app/errors/application-error.js";
import { STANDARD_VIEWPORTS, type ViewportName } from "../visual-qa/visual-qa-types.js";

export const BROWSER_QA_REPORT_VERSION = 1 as const;
export const BROWSER_QA_STATUSES = ["PASS", "PASS_WITH_WARNINGS", "FAIL"] as const;
export type BrowserQAStatus = (typeof BROWSER_QA_STATUSES)[number];
export const BROWSER_QA_CHECK_STATUSES = ["PASS", "FAIL", "WARNING", "SKIPPED"] as const;
export type BrowserQACheckStatus = (typeof BROWSER_QA_CHECK_STATUSES)[number];
export const BROWSER_QA_SEVERITIES = ["ERROR", "WARNING", "INFO"] as const;
export type BrowserQASeverity = (typeof BROWSER_QA_SEVERITIES)[number];
export const BROWSER_QA_CATEGORIES = [
  "RUNTIME",
  "CONSOLE",
  "NETWORK",
  "ROUTING",
  "ASSET",
  "INTERACTION",
  "FORM",
  "RESPONSIVE",
  "ACCESSIBILITY",
  "MOTION",
] as const;
export type BrowserQACategory = (typeof BROWSER_QA_CATEGORIES)[number];

export type BrowserQAViewport = Readonly<{
  id: ViewportName;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}>;

export const BROWSER_QA_VIEWPORTS: readonly BrowserQAViewport[] = Object.freeze(
  STANDARD_VIEWPORTS.map((viewport) =>
    Object.freeze({ id: viewport.name, width: viewport.width, height: viewport.height }),
  ),
);

export type BrowserQAEvidence =
  | Readonly<{ type: "console"; level: string; message: string; source?: string }>
  | Readonly<{
      type: "network";
      url: string;
      method?: string;
      status?: number;
      failureText?: string;
      resourceType?: string;
    }>
  | Readonly<{ type: "element"; locatorDescription: string; tagName?: string; accessibleName?: string }>
  | Readonly<{ type: "layout"; viewportWidth: number; scrollWidth: number; overflowPx: number }>
  | Readonly<{ type: "artifact"; artifactRef: string }>;

export interface BrowserQADiagnostic {
  readonly message: string;
  readonly evidence?: readonly BrowserQAEvidence[];
}

export interface BrowserQACheckResult {
  readonly checkId: string;
  readonly category: BrowserQACategory;
  readonly status: BrowserQACheckStatus;
  readonly severity: BrowserQASeverity;
  readonly route?: string;
  readonly viewport?: BrowserQAViewport;
  readonly message: string;
  readonly evidence?: readonly BrowserQAEvidence[];
  readonly startedAt?: string;
  readonly durationMs?: number;
}

export interface BrowserQACheckCounts {
  readonly passed: number;
  readonly failed: number;
  readonly warnings: number;
  readonly skipped: number;
}

export interface BrowserQABrowserInfo {
  readonly name: "chromium";
  readonly version?: string;
}

/**
 * Structured screenshot identity so Layer 3E can address a canonical Layer 3D
 * screenshot by route/viewport/browser directly, without reverse-engineering
 * the artifact key naming convention.
 */
export interface BrowserQAScreenshotDescriptor {
  readonly route: string;
  readonly viewport: BrowserQAViewport;
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly capturedAt: string;
}

export interface BrowserQAReportInput {
  readonly reportVersion?: 1;
  readonly runId: string;
  readonly projectId?: string;
  readonly siteVersionId?: string;
  readonly jobId?: string;
  readonly status?: BrowserQAStatus;
  readonly browser: BrowserQABrowserInfo;
  readonly viewports: readonly BrowserQAViewport[];
  readonly routes: readonly string[];
  readonly checks: readonly BrowserQACheckResult[];
  readonly artifactRefs?: readonly string[];
  readonly screenshots?: readonly BrowserQAScreenshotDescriptor[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface BrowserQAReport {
  readonly reportVersion: 1;
  readonly runId: string;
  readonly projectId?: string;
  readonly siteVersionId?: string;
  readonly jobId?: string;
  readonly status: BrowserQAStatus;
  readonly browser: BrowserQABrowserInfo;
  readonly viewports: readonly BrowserQAViewport[];
  readonly routes: readonly string[];
  readonly checks: readonly BrowserQACheckResult[];
  readonly artifactRefs: readonly string[];
  readonly screenshots: readonly BrowserQAScreenshotDescriptor[];
  readonly summary: BrowserQACheckCounts;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

const isString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isIn = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);

function fail(message: string): never {
  throw new ApplicationError("VALIDATION_FAILED", message);
}

function freezeEvidence(evidence: readonly BrowserQAEvidence[] | undefined): readonly BrowserQAEvidence[] | undefined {
  return evidence === undefined ? undefined : Object.freeze(evidence.map((item) => Object.freeze({ ...item })));
}

function freezeViewport(viewport: BrowserQAViewport): BrowserQAViewport {
  if (!isIn(["DESKTOP", "TABLET", "MOBILE"] as const, viewport.id)) fail("Browser QA viewport ID is invalid");
  if (!Number.isInteger(viewport.width) || viewport.width <= 0 || !Number.isInteger(viewport.height) || viewport.height <= 0)
    fail("Browser QA viewport dimensions must be positive integers");
  return Object.freeze({ ...viewport });
}

function checkSort(a: BrowserQACheckResult, b: BrowserQACheckResult): number {
  const viewportA = a.viewport?.id ?? "";
  const viewportB = b.viewport?.id ?? "";
  const routeA = a.route ?? "";
  const routeB = b.route ?? "";
  return viewportA.localeCompare(viewportB) || routeA.localeCompare(routeB) || a.category.localeCompare(b.category) || a.checkId.localeCompare(b.checkId);
}

export function createBrowserQACheckResult(input: BrowserQACheckResult): BrowserQACheckResult {
  if (!isString(input.checkId) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(input.checkId))
    fail("Browser QA checkId must be a stable lowercase identifier");
  if (!isIn(BROWSER_QA_CATEGORIES, input.category)) fail(`Unknown Browser QA category '${String(input.category)}'`);
  if (!isIn(BROWSER_QA_CHECK_STATUSES, input.status)) fail(`Unknown Browser QA check status '${String(input.status)}'`);
  if (!isIn(BROWSER_QA_SEVERITIES, input.severity)) fail(`Unknown Browser QA severity '${String(input.severity)}'`);
  if (input.status === "SKIPPED" && (!isString(input.message) || !input.message.trim())) fail("Skipped Browser QA checks require a reason");
  if (!isString(input.message) || input.message.length > 2_000) fail("Browser QA check message is invalid");
  if (input.route !== undefined && !isString(input.route)) fail("Browser QA route must be a non-empty string");
  if (input.startedAt !== undefined && !isString(input.startedAt)) fail("Browser QA startedAt must be an ISO string");
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) fail("Browser QA durationMs is invalid");
  return Object.freeze({
    ...input,
    ...(input.viewport === undefined ? {} : { viewport: freezeViewport(input.viewport) }),
    ...(input.evidence === undefined ? {} : { evidence: freezeEvidence(input.evidence)! }),
  });
}

export function aggregateBrowserQAStatus(checks: readonly BrowserQACheckResult[]): BrowserQAStatus {
  if (checks.some((check) => check.status === "FAIL" && check.severity === "ERROR")) return "FAIL";
  if (checks.some((check) => check.status === "WARNING" || (check.status === "FAIL" && check.severity === "WARNING")))
    return "PASS_WITH_WARNINGS";
  return "PASS";
}

export function countBrowserQAChecks(checks: readonly BrowserQACheckResult[]): BrowserQACheckCounts {
  return Object.freeze({
    passed: checks.filter((check) => check.status === "PASS").length,
    failed: checks.filter((check) => check.status === "FAIL").length,
    warnings: checks.filter((check) => check.status === "WARNING").length,
    skipped: checks.filter((check) => check.status === "SKIPPED").length,
  });
}

export function createBrowserQAReport(input: BrowserQAReportInput): BrowserQAReport {
  if (!isString(input.runId)) fail("Browser QA runId is required");
  if (input.browser.name !== "chromium") fail("Only Chromium is supported by the initial Browser QA runner");
  if (!isString(input.startedAt) || !isString(input.completedAt)) fail("Browser QA timestamps are required");
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) fail("Browser QA report durationMs is invalid");
  const seen = new Set<string>();
  const checks = input.checks.map(createBrowserQACheckResult).sort(checkSort);
  for (const check of checks) {
    const key = [check.viewport?.id ?? "", check.route ?? "", check.category, check.checkId].join("\u0000");
    if (seen.has(key)) fail(`Duplicate Browser QA check '${check.checkId}' for the same scope`);
    seen.add(key);
  }
  const viewports = input.viewports.map(freezeViewport).sort((a, b) => a.id.localeCompare(b.id));
  const routes = [...new Set(input.routes)].sort((a, b) => a.localeCompare(b));
  const artifactRefs = [...new Set(input.artifactRefs ?? [])].sort((a, b) => a.localeCompare(b));
  const screenshots = [...(input.screenshots ?? [])]
    .sort((a, b) => a.route.localeCompare(b.route) || a.viewport.id.localeCompare(b.viewport.id) || a.artifactRef.localeCompare(b.artifactRef));
  const seenScreenshotKeys = new Set<string>();
  for (const shot of screenshots) {
    if (!isString(shot.artifactRef)) fail("Browser QA screenshot descriptor artifactRef is required");
    if (!isString(shot.route)) fail("Browser QA screenshot descriptor route is required");
    if (!isString(shot.contentHash)) fail("Browser QA screenshot descriptor contentHash is required");
    if (!isString(shot.capturedAt)) fail("Browser QA screenshot descriptor capturedAt is required");
    const key = `${shot.route} ${shot.viewport.id}`;
    if (seenScreenshotKeys.has(key)) fail(`Duplicate Browser QA screenshot descriptor for route '${shot.route}' viewport '${shot.viewport.id}'`);
    seenScreenshotKeys.add(key);
  }
  const status = aggregateBrowserQAStatus(checks);
  const report: BrowserQAReport = {
    reportVersion: 1,
    runId: input.runId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.siteVersionId === undefined ? {} : { siteVersionId: input.siteVersionId }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    status,
    browser: Object.freeze({ ...input.browser }),
    viewports: Object.freeze(viewports),
    routes: Object.freeze(routes),
    checks: Object.freeze(checks),
    artifactRefs: Object.freeze(artifactRefs),
    screenshots: Object.freeze(screenshots.map((shot) => Object.freeze({ ...shot, viewport: freezeViewport(shot.viewport) }))),
    summary: countBrowserQAChecks(checks),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
  };
  return Object.freeze(report);
}

export function serializeBrowserQAReport(report: BrowserQAReport): string {
  return JSON.stringify(report);
}

export function hashBrowserQAReport(report: BrowserQAReport): string {
  return createHash("sha256").update(serializeBrowserQAReport(report), "utf8").digest("hex");
}
