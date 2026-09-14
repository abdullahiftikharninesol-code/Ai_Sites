export const VISUAL_ISSUE_TYPES = [
  "LAYOUT_OVERFLOW",
  "HORIZONTAL_SCROLL",
  "ELEMENT_OVERLAP",
  "TEXT_CLIPPING",
  "CONTENT_OUTSIDE_VIEWPORT",
  "BROKEN_IMAGE",
  "MISSING_IMAGE",
  "INVISIBLE_CONTENT",
  "BUTTON_NOT_VISIBLE",
  "NAVIGATION_OVERFLOW",
  "SECTION_SPACING",
  "EXCESSIVE_EMPTY_SPACE",
  "MOBILE_LAYOUT",
  "TABLE_OVERFLOW",
  "FORM_LAYOUT",
  "TYPOGRAPHY_SCALE",
  "CONTRAST_WARNING",
  "RESPONSIVE_BREAKPOINT",
  "RUNTIME_RENDER_ERROR",
] as const;
export type VisualIssueType = (typeof VISUAL_ISSUE_TYPES)[number];
export const VISUAL_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type VisualSeverity = (typeof VISUAL_SEVERITIES)[number];
export type ViewportName = "DESKTOP" | "TABLET" | "MOBILE";
export interface ViewportPreset {
  readonly name: ViewportName;
  readonly width: number;
  readonly height: number;
}
export const STANDARD_VIEWPORTS: readonly ViewportPreset[] = [
  { name: "DESKTOP", width: 1440, height: 900 },
  { name: "TABLET", width: 768, height: 1024 },
  { name: "MOBILE", width: 390, height: 844 },
];
export interface SiteScreenshotArtifact {
  readonly viewport: ViewportName;
  readonly width: number;
  readonly height: number;
  readonly artifactRef: string;
  readonly capturedAt: Date;
  readonly pageUrl: string;
  readonly contentHash: string;
}
export interface ElementObservation {
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly fontSize: number;
  readonly opacity: number;
  readonly visibility: string;
  readonly overflow: string;
}
export interface BrowserViewportResult {
  readonly viewport: ViewportPreset;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly screenshot: SiteScreenshotArtifact;
  readonly runtimeErrors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly failedResources: readonly string[];
  readonly brokenImages: readonly string[];
  readonly elements: readonly ElementObservation[];
  readonly renderDurationMs: number;
}
export interface VisualIssue {
  readonly id: string;
  readonly type: VisualIssueType;
  readonly severity: VisualSeverity;
  readonly viewport: ViewportName;
  readonly description: string;
  readonly selector?: string;
  readonly elementHint?: string;
  readonly screenshotRef?: string;
  readonly suggestedAction?: string;
}
export interface ViewportQAResult {
  readonly viewport: ViewportName;
  readonly passed: boolean;
  readonly score: number;
  readonly issues: readonly VisualIssue[];
  readonly screenshotRef: string;
}
export interface VisualQARequest {
  readonly siteId: string;
  readonly siteSpec?: unknown;
  readonly renders: readonly BrowserViewportResult[];
}
export interface VisualQAResult {
  readonly passed: boolean;
  readonly score: number;
  readonly issues: readonly VisualIssue[];
  readonly viewportResults: readonly ViewportQAResult[];
  readonly summary: string;
  readonly recommendation: "PASS" | "REPAIR" | "MANUAL_REVIEW";
}
export interface VisualQAProvider {
  evaluate(request: VisualQARequest): Promise<VisualQAResult>;
}
export interface VisualQAAttempt {
  readonly attemptNumber: number;
  readonly screenshots: readonly SiteScreenshotArtifact[];
  readonly issues: readonly VisualIssue[];
  readonly score: number;
  readonly result: VisualQAResult["recommendation"];
  readonly renderDurationMs: number;
  readonly createdAt: Date;
}
export interface VisualQAReport {
  readonly finalResult: VisualQAResult;
  readonly attempts: readonly VisualQAAttempt[];
  readonly visualRepairAttempts: number;
  readonly browserLaunches: number;
  readonly screenshotsCaptured: number;
  readonly renderDurationMs: number;
  readonly visualQaDurationMs: number;
  readonly artifactRef: string;
}
