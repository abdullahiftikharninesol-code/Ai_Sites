import type { BrowserQAScreenshotDescriptor } from "../browser-qa/browser-qa-domain.js";
import type { SiteSpec } from "../sites/domain/site-spec.js";
import type { VisualScreenshotReference } from "./visual-review-domain.js";
import { MAX_VISUAL_REVIEW_IMAGES_PER_REQUEST } from "./visual-review-multimodal.js";

/**
 * Layer 3E.5 pipeline glue: bounded, deterministic screenshot selection over
 * Layer 3D's own canonical descriptors (no second browser pass), and a
 * compact trusted design-context summary for the Visual Review prompt.
 */

/**
 * Deterministically selects a bounded screenshot set for one Visual Review
 * request: the home route first (all its viewports), then remaining routes
 * in alphabetical order, until the per-request image cap is reached.
 */
export function selectVisualReviewScreenshots(
  descriptors: readonly BrowserQAScreenshotDescriptor[],
  maxCount: number = MAX_VISUAL_REVIEW_IMAGES_PER_REQUEST,
): readonly BrowserQAScreenshotDescriptor[] {
  const routeOrder = [...new Set(descriptors.map((d) => d.route))].sort((a, b) => {
    if (a === "/" && b !== "/") return -1;
    if (b === "/" && a !== "/") return 1;
    return a.localeCompare(b);
  });
  const byRoute = new Map<string, BrowserQAScreenshotDescriptor[]>();
  for (const descriptor of descriptors) {
    const list = byRoute.get(descriptor.route) ?? [];
    list.push(descriptor);
    byRoute.set(descriptor.route, list);
  }
  const selected: BrowserQAScreenshotDescriptor[] = [];
  for (const route of routeOrder) {
    const shots = [...(byRoute.get(route) ?? [])].sort((a, b) => a.viewport.id.localeCompare(b.viewport.id));
    for (const shot of shots) {
      if (selected.length >= maxCount) return selected;
      selected.push(shot);
    }
  }
  return selected;
}

export function toVisualScreenshotReference(
  descriptor: BrowserQAScreenshotDescriptor,
  siteVersionId: string,
  browserName: string,
): VisualScreenshotReference {
  return {
    artifactRef: descriptor.artifactRef,
    siteVersionId,
    route: descriptor.route,
    viewport: descriptor.viewport.id,
    width: descriptor.viewport.width,
    height: descriptor.viewport.height,
    browser: browserName,
    contentHash: descriptor.contentHash,
    capturedAt: descriptor.capturedAt,
  };
}

/** Compact trusted design-intent summary. Never includes user-entered runtime data. */
export function summarizeDesignContextForVisualReview(siteSpec: SiteSpec | undefined): string {
  if (!siteSpec) return "No SiteSpec design context is available for this version.";
  const { design, requirements } = siteSpec;
  return JSON.stringify({
    siteType: requirements?.siteType,
    pages: requirements?.pages?.map((page) => page.path),
    style: design?.style,
    theme: design?.theme,
    colors: design?.colors,
    typography: design?.typography,
    spacing: design?.spacing,
  });
}
