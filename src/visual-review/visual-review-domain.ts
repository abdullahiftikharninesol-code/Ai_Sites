import { createHash } from "node:crypto";
import { ApplicationError } from "../app/errors/application-error.js";
import type { ViewportName } from "../visual-qa/visual-qa-types.js";

/**
 * Layer 3E structured Visual QA domain. Independent from the legacy
 * `src/visual-qa` deterministic subsystem: that subsystem's numeric score
 * remains compatibility telemetry only and never authorizes a status here.
 */

export const VISUAL_REVIEW_SCHEMA_VERSION = 1 as const;

export const VISUAL_REVIEW_STATUSES = ["PASS", "NEEDS_REPAIR", "FAIL", "INCONCLUSIVE"] as const;
export type VisualReviewStatus = (typeof VISUAL_REVIEW_STATUSES)[number];

export const VISUAL_ISSUE_CATEGORIES = [
  "LAYOUT",
  "SPACING",
  "TYPOGRAPHY",
  "HIERARCHY",
  "ALIGNMENT",
  "IMAGE_CROP",
  "RESPONSIVE",
  "CONTRAST",
  "COMPONENT_CONSISTENCY",
  "MOTION_VISUAL",
  "OVERFLOW",
] as const;
export type VisualIssueCategory = (typeof VISUAL_ISSUE_CATEGORIES)[number];

export const VISUAL_ISSUE_SEVERITIES = ["BLOCKER", "MAJOR", "MINOR"] as const;
export type VisualIssueSeverity = (typeof VISUAL_ISSUE_SEVERITIES)[number];
const SEVERITY_RANK: Readonly<Record<VisualIssueSeverity, number>> = { BLOCKER: 0, MAJOR: 1, MINOR: 2 };

export const VISUAL_REPAIRABILITIES = ["AUTO_REPAIRABLE", "NOT_AUTO_REPAIRABLE", "UNCERTAIN"] as const;
export type VisualRepairability = (typeof VISUAL_REPAIRABILITIES)[number];

export const VISUAL_VIEWPORT_SCOPES = ["DESKTOP_ONLY", "TABLET_ONLY", "MOBILE_ONLY", "CROSS_VIEWPORT"] as const;
export type VisualViewportScope = (typeof VISUAL_VIEWPORT_SCOPES)[number];

export const VISUAL_ISSUE_LIFECYCLE_STATUSES = ["OPEN", "REPAIRED", "UNRESOLVED", "NOT_AUTO_REPAIRED"] as const;
export type VisualIssueLifecycleStatus = (typeof VISUAL_ISSUE_LIFECYCLE_STATUSES)[number];

export const VISUAL_REPAIR_ATTEMPT_STATUSES = [
  "PENDING",
  "APPLIED",
  "STATIC_VALIDATION_FAILED",
  "BUILD_FAILED",
  "BROWSER_QA_REGRESSION",
  "NO_PROGRESS",
  "SUCCEEDED",
  "ROLLED_BACK",
] as const;
export type VisualRepairAttemptStatus = (typeof VISUAL_REPAIR_ATTEMPT_STATUSES)[number];

/** Initial bounded repair budget. Raising this requires controlled evaluation evidence. */
export const MAX_VISUAL_REPAIR_ATTEMPTS = 1 as const;

export const VISUAL_TARGET_KINDS = [
  "SITES_PAGE",
  "SITES_SECTION",
  "COMPONENT",
  "ACCESSIBLE_ELEMENT",
  "SELECTOR",
] as const;
export type VisualTargetKind = (typeof VISUAL_TARGET_KINDS)[number];

export interface VisualTargetBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisualTarget {
  readonly kind: VisualTargetKind;
  readonly value: string;
  readonly boundingBox?: VisualTargetBoundingBox;
}

export interface VisualScreenshotReference {
  readonly artifactRef: string;
  readonly siteVersionId: string;
  readonly route: string;
  readonly viewport: ViewportName;
  readonly width: number;
  readonly height: number;
  readonly browser: string;
  readonly contentHash: string;
  readonly capturedAt: string;
}

export interface VisualEvidence {
  readonly screenshotRef: string;
  readonly targetMetadata?: string;
  readonly observation?: string;
}

export interface VisualIssue {
  readonly issueId: string;
  readonly category: VisualIssueCategory;
  readonly severity: VisualIssueSeverity;
  readonly repairability: VisualRepairability;
  readonly route: string;
  readonly viewport: ViewportName;
  readonly viewportScope: VisualViewportScope;
  readonly target?: VisualTarget;
  readonly description: string;
  readonly evidence: VisualEvidence;
  readonly suggestedRepairScope?: string;
}

export interface VisualReviewAgentIdentity {
  readonly agentId: string;
  readonly agentContractVersion: number;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly provider: string;
  readonly model: string;
}

export interface VisualReview {
  readonly schemaVersion: typeof VISUAL_REVIEW_SCHEMA_VERSION;
  readonly reviewId: string;
  readonly siteId: string;
  readonly siteVersionId: string;
  readonly status: VisualReviewStatus;
  readonly confidence?: number;
  readonly screenshotRefs: readonly VisualScreenshotReference[];
  readonly issues: readonly VisualIssue[];
  readonly summary?: string;
  readonly agent: VisualReviewAgentIdentity;
  /** Legacy `src/visual-qa` numeric score, kept only as compatibility telemetry. Never authoritative. */
  readonly deterministicVisualScore?: number;
  readonly createdAt: string;
}

export interface VisualReviewInput {
  readonly reviewId: string;
  readonly siteId: string;
  readonly siteVersionId: string;
  readonly status: VisualReviewStatus;
  readonly confidence?: number;
  readonly screenshotRefs: readonly VisualScreenshotReference[];
  readonly issues: readonly VisualIssue[];
  readonly summary?: string;
  readonly agent: VisualReviewAgentIdentity;
  readonly deterministicVisualScore?: number;
  readonly createdAt?: string;
}

export interface VisualIssueOutcome {
  readonly issueId: string;
  readonly status: VisualIssueLifecycleStatus;
}

export interface VisualRepairAttempt {
  readonly attemptId: string;
  readonly sourceReviewId: string;
  readonly attemptNumber: number;
  readonly issueIds: readonly string[];
  readonly beforeSourceHash: string;
  readonly afterSourceHash?: string;
  readonly filesChanged: readonly string[];
  readonly status: VisualRepairAttemptStatus;
  readonly buildResult?: "PASS" | "FAIL";
  readonly browserQaRunId?: string;
  readonly afterReviewId?: string;
  readonly issueOutcomes?: readonly VisualIssueOutcome[];
  readonly createdAt: string;
}

export interface VisualRepairAttemptInput {
  readonly attemptId: string;
  readonly sourceReviewId: string;
  readonly attemptNumber: number;
  readonly issueIds: readonly string[];
  readonly beforeSourceHash: string;
  readonly afterSourceHash?: string;
  readonly filesChanged?: readonly string[];
  readonly status: VisualRepairAttemptStatus;
  readonly buildResult?: "PASS" | "FAIL";
  readonly browserQaRunId?: string;
  readonly afterReviewId?: string;
  readonly issueOutcomes?: readonly VisualIssueOutcome[];
  readonly createdAt?: string;
}

const isString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isIn = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);
const VIEWPORT_NAMES: readonly ViewportName[] = ["DESKTOP", "TABLET", "MOBILE"];

function fail(message: string): never {
  throw new ApplicationError("VALIDATION_FAILED", message);
}

function assertUniqueStrings(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) fail(`${field} must not contain duplicates`);
}

function freezeBoundingBox(box: VisualTargetBoundingBox): VisualTargetBoundingBox {
  for (const [key, value] of Object.entries(box)) {
    if (!Number.isFinite(value)) fail(`Visual target boundingBox.${key} must be finite`);
  }
  if (box.width < 0 || box.height < 0) fail("Visual target boundingBox dimensions must not be negative");
  return Object.freeze({ ...box });
}

function freezeTarget(target: VisualTarget): VisualTarget {
  if (!isIn(VISUAL_TARGET_KINDS, target.kind)) fail(`Unknown visual target kind '${String(target.kind)}'`);
  if (!isString(target.value)) fail("Visual target value must be a non-empty string");
  return Object.freeze({
    ...target,
    ...(target.boundingBox === undefined ? {} : { boundingBox: freezeBoundingBox(target.boundingBox) }),
  });
}

function freezeEvidence(evidence: VisualEvidence): VisualEvidence {
  if (!isString(evidence.screenshotRef)) fail("Visual issue evidence.screenshotRef is required");
  return Object.freeze({ ...evidence });
}

function targetSortKey(target: VisualTarget | undefined): string {
  return target ? `${target.kind}:${target.value}` : "";
}

function issueSortKey(issue: VisualIssue): string {
  return [
    issue.route,
    issue.viewport,
    String(SEVERITY_RANK[issue.severity]),
    issue.category,
    targetSortKey(issue.target),
    issue.issueId,
  ].join(" ");
}

function screenshotSortKey(ref: VisualScreenshotReference): string {
  return [ref.route, ref.viewport, ref.artifactRef].join(" ");
}

export function createVisualIssue(input: VisualIssue): VisualIssue {
  if (!isString(input.issueId)) fail("Visual issue issueId is required");
  if (!isIn(VISUAL_ISSUE_CATEGORIES, input.category)) fail(`Unknown visual issue category '${String(input.category)}'`);
  if (!isIn(VISUAL_ISSUE_SEVERITIES, input.severity)) fail(`Unknown visual issue severity '${String(input.severity)}'`);
  if (!isIn(VISUAL_REPAIRABILITIES, input.repairability)) fail(`Unknown visual repairability '${String(input.repairability)}'`);
  if (!isString(input.route)) fail("Visual issue route is required");
  if (!isIn(VIEWPORT_NAMES, input.viewport)) fail(`Unknown visual issue viewport '${String(input.viewport)}'`);
  if (!isIn(VISUAL_VIEWPORT_SCOPES, input.viewportScope)) fail(`Unknown visual viewport scope '${String(input.viewportScope)}'`);
  if (!isString(input.description) || input.description.length > 2_000) fail("Visual issue description is invalid");
  if (input.suggestedRepairScope !== undefined && input.suggestedRepairScope.length > 2_000)
    fail("Visual issue suggestedRepairScope is too long");
  const { target: _target, ...rest } = input;
  return Object.freeze({
    ...rest,
    evidence: freezeEvidence(input.evidence),
    ...(input.target === undefined ? {} : { target: freezeTarget(input.target) }),
  });
}

function validateStatusIssueConsistency(status: VisualReviewStatus, issues: readonly VisualIssue[]): void {
  if (status === "PASS" && issues.some((issue) => issue.severity === "BLOCKER"))
    fail("A PASS visual review must not contain a BLOCKER issue");
  if (status === "NEEDS_REPAIR" && !issues.some((issue) => issue.repairability === "AUTO_REPAIRABLE"))
    fail("A NEEDS_REPAIR visual review requires at least one AUTO_REPAIRABLE issue");
  if (status === "FAIL" && issues.length === 0) fail("A FAIL visual review requires at least one issue");
  if (status === "INCONCLUSIVE" && issues.length > 0)
    fail("An INCONCLUSIVE visual review must not report issues from insufficient evidence");
}

export function createVisualReview(input: VisualReviewInput): VisualReview {
  if (!isString(input.reviewId)) fail("Visual review reviewId is required");
  if (!isString(input.siteId)) fail("Visual review siteId is required");
  if (!isString(input.siteVersionId)) fail("Visual review siteVersionId is required");
  if (!isIn(VISUAL_REVIEW_STATUSES, input.status)) fail(`Unknown visual review status '${String(input.status)}'`);
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.confidence)))
    fail("Visual review confidence must be between 0 and 1");
  if (input.deterministicVisualScore !== undefined) {
    if (!Number.isFinite(input.deterministicVisualScore) || input.deterministicVisualScore < 0 || input.deterministicVisualScore > 100)
      fail("deterministicVisualScore must be between 0 and 100");
  }
  if (!isString(input.agent.agentId)) fail("Visual review agent.agentId is required");
  if (!Number.isInteger(input.agent.agentContractVersion) || input.agent.agentContractVersion <= 0)
    fail("Visual review agent.agentContractVersion must be a positive integer");
  if (!isString(input.agent.promptId)) fail("Visual review agent.promptId is required");
  if (!Number.isInteger(input.agent.promptVersion) || input.agent.promptVersion <= 0)
    fail("Visual review agent.promptVersion must be a positive integer");
  if (!isString(input.agent.promptHash)) fail("Visual review agent.promptHash is required");
  if (!isString(input.agent.provider)) fail("Visual review agent.provider is required");
  if (!isString(input.agent.model)) fail("Visual review agent.model is required");

  const screenshotRefs = [...input.screenshotRefs].sort((a, b) => screenshotSortKey(a).localeCompare(screenshotSortKey(b)));
  assertUniqueStrings(
    screenshotRefs.map((ref) => ref.artifactRef),
    "screenshotRefs",
  );
  const knownScreenshotRefs = new Set(screenshotRefs.map((ref) => ref.artifactRef));
  for (const ref of screenshotRefs) {
    if (!isString(ref.artifactRef)) fail("Visual screenshot reference artifactRef is required");
    if (!isString(ref.siteVersionId)) fail("Visual screenshot reference siteVersionId is required");
    if (!isString(ref.route)) fail("Visual screenshot reference route is required");
    if (!isIn(VIEWPORT_NAMES, ref.viewport)) fail(`Unknown visual screenshot viewport '${String(ref.viewport)}'`);
    if (!Number.isInteger(ref.width) || ref.width <= 0 || !Number.isInteger(ref.height) || ref.height <= 0)
      fail("Visual screenshot reference dimensions must be positive integers");
    if (!isString(ref.browser)) fail("Visual screenshot reference browser is required");
    if (!isString(ref.contentHash)) fail("Visual screenshot reference contentHash is required");
    if (!isString(ref.capturedAt)) fail("Visual screenshot reference capturedAt is required");
  }

  const issues = input.issues.map(createVisualIssue).sort((a, b) => issueSortKey(a).localeCompare(issueSortKey(b)));
  assertUniqueStrings(
    issues.map((issue) => issue.issueId),
    "issues[].issueId",
  );
  for (const issue of issues) {
    if (!knownScreenshotRefs.has(issue.evidence.screenshotRef))
      fail(`Visual issue '${issue.issueId}' references an unknown screenshot '${issue.evidence.screenshotRef}'`);
  }
  validateStatusIssueConsistency(input.status, issues);

  const review: VisualReview = {
    schemaVersion: VISUAL_REVIEW_SCHEMA_VERSION,
    reviewId: input.reviewId,
    siteId: input.siteId,
    siteVersionId: input.siteVersionId,
    status: input.status,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    screenshotRefs: Object.freeze(screenshotRefs),
    issues: Object.freeze(issues),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    agent: Object.freeze({ ...input.agent }),
    ...(input.deterministicVisualScore === undefined ? {} : { deterministicVisualScore: input.deterministicVisualScore }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return Object.freeze(review);
}

export function serializeVisualReview(review: VisualReview): string {
  return JSON.stringify(review);
}

export function hashVisualReview(review: VisualReview): string {
  return createHash("sha256").update(serializeVisualReview(review), "utf8").digest("hex");
}

/** Stable normalized fingerprint used for no-progress/oscillation detection across reviews. */
export function visualIssueFingerprint(issue: Pick<VisualIssue, "category" | "route" | "viewportScope" | "target">): string {
  return [issue.category, issue.route, issue.viewportScope, targetSortKey(issue.target)].join(" ");
}

export function createVisualRepairAttempt(input: VisualRepairAttemptInput): VisualRepairAttempt {
  if (!isString(input.attemptId)) fail("Visual repair attempt attemptId is required");
  if (!isString(input.sourceReviewId)) fail("Visual repair attempt sourceReviewId is required");
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1 || input.attemptNumber > MAX_VISUAL_REPAIR_ATTEMPTS)
    fail(`Visual repair attemptNumber must be an integer between 1 and ${MAX_VISUAL_REPAIR_ATTEMPTS}`);
  if (!Array.isArray(input.issueIds) || input.issueIds.length === 0) fail("Visual repair attempt requires at least one issueId");
  assertUniqueStrings(input.issueIds, "issueIds");
  for (const issueId of input.issueIds) if (!isString(issueId)) fail("Visual repair attempt issueIds must be non-empty strings");
  if (!isString(input.beforeSourceHash)) fail("Visual repair attempt beforeSourceHash is required");
  if (input.afterSourceHash !== undefined && !isString(input.afterSourceHash))
    fail("Visual repair attempt afterSourceHash must be a non-empty string when present");
  const filesChanged = [...(input.filesChanged ?? [])].sort((a, b) => a.localeCompare(b));
  assertUniqueStrings(filesChanged, "filesChanged");
  if (!isIn(VISUAL_REPAIR_ATTEMPT_STATUSES, input.status)) fail(`Unknown visual repair attempt status '${String(input.status)}'`);
  if (input.buildResult !== undefined && input.buildResult !== "PASS" && input.buildResult !== "FAIL")
    fail("Visual repair attempt buildResult must be PASS or FAIL");
  const issueIdSet = new Set(input.issueIds);
  const issueOutcomes = input.issueOutcomes
    ? [...input.issueOutcomes].sort((a, b) => a.issueId.localeCompare(b.issueId))
    : undefined;
  if (issueOutcomes) {
    assertUniqueStrings(
      issueOutcomes.map((outcome) => outcome.issueId),
      "issueOutcomes[].issueId",
    );
    for (const outcome of issueOutcomes) {
      if (!issueIdSet.has(outcome.issueId))
        fail(`Visual repair attempt issueOutcome references unknown issueId '${outcome.issueId}'`);
      if (!isIn(VISUAL_ISSUE_LIFECYCLE_STATUSES, outcome.status))
        fail(`Unknown visual issue lifecycle status '${String(outcome.status)}'`);
    }
  }

  const attempt: VisualRepairAttempt = {
    attemptId: input.attemptId,
    sourceReviewId: input.sourceReviewId,
    attemptNumber: input.attemptNumber,
    issueIds: Object.freeze([...input.issueIds]),
    beforeSourceHash: input.beforeSourceHash,
    ...(input.afterSourceHash === undefined ? {} : { afterSourceHash: input.afterSourceHash }),
    filesChanged: Object.freeze(filesChanged),
    status: input.status,
    ...(input.buildResult === undefined ? {} : { buildResult: input.buildResult }),
    ...(input.browserQaRunId === undefined ? {} : { browserQaRunId: input.browserQaRunId }),
    ...(input.afterReviewId === undefined ? {} : { afterReviewId: input.afterReviewId }),
    ...(issueOutcomes === undefined ? {} : { issueOutcomes: Object.freeze(issueOutcomes) }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return Object.freeze(attempt);
}

export function serializeVisualRepairAttempt(attempt: VisualRepairAttempt): string {
  return JSON.stringify(attempt);
}
