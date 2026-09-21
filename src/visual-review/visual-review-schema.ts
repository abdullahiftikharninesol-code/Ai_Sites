/**
 * @file visual-review-schema.ts
 *
 * Provider-neutral structured response schema for `VisualReview`.
 *
 * NOTE ON SOURCE OF TRUTH: `createVisualReview` in
 * `src/visual-review/visual-review-domain.ts` is the authoritative runtime
 * validator. This schema mirrors that contract for providers that accept a
 * JSON schema hint; it never replaces local validation.
 */

export const VISUAL_REVIEW_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "VisualReview",
  type: "object",
  properties: {
    status: { type: "string", enum: ["PASS", "NEEDS_REPAIR", "FAIL", "INCONCLUSIVE"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          category: {
            type: "string",
            enum: [
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
            ],
          },
          severity: { type: "string", enum: ["BLOCKER", "MAJOR", "MINOR"] },
          repairability: { type: "string", enum: ["AUTO_REPAIRABLE", "NOT_AUTO_REPAIRABLE", "UNCERTAIN"] },
          route: { type: "string" },
          viewport: { type: "string", enum: ["DESKTOP", "TABLET", "MOBILE"] },
          viewportScope: {
            type: "string",
            enum: ["DESKTOP_ONLY", "TABLET_ONLY", "MOBILE_ONLY", "CROSS_VIEWPORT"],
          },
          target: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["SITES_PAGE", "SITES_SECTION", "COMPONENT", "ACCESSIBLE_ELEMENT", "SELECTOR"],
              },
              value: { type: "string" },
            },
            required: ["kind", "value"],
          },
          description: { type: "string" },
          evidence: {
            type: "object",
            properties: {
              screenshotRef: { type: "string" },
              targetMetadata: { type: "string" },
              observation: { type: "string" },
            },
            required: ["screenshotRef"],
          },
          suggestedRepairScope: { type: "string" },
        },
        required: ["issueId", "category", "severity", "repairability", "route", "viewport", "viewportScope", "description", "evidence"],
      },
    },
  },
  required: ["status", "issues"],
} as const;
