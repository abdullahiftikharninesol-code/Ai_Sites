/**
 * @file site-plan-schema.ts
 *
 * Authoritative Canonical JSON Schemas for Site Planning and Edit Planning.
 *
 * NOTE ON SOURCE OF TRUTH:
 * `validateSitePlan` in `src/sites/domain/site-plan.ts` is the authoritative runtime
 * domain contract for SitePlan. This canonical schema mirrors that contract for
 * model provider-neutral structured response contracts.
 *
 * Similarly, `IntelligenceValidators.validateEdit` in `src/agents/intelligence/intelligence-validators.ts`
 * is the authoritative runtime domain contract for SiteEditPlan.
 */

export const CANONICAL_SITE_PLAN_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SitePlan",
  type: "object",
  properties: {
    intent: {
      type: "object",
      description: "Classified site generation or edit intent",
      properties: {
        type: {
          type: "string",
          enum: [
            "CREATE_SITE",
            "EDIT_SITE",
            "CONTINUE_SITE",
            "INSPECT_SITE",
            "PUBLISH_SITE",
            "ROLLBACK_SITE",
            "UNPUBLISH_SITE",
            "UNSUPPORTED_OR_OTHER",
          ],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: { type: "string" },
      },
      required: ["type"],
      additionalProperties: false,
    },
    site: {
      type: "object",
      description: "High-level site metadata",
      properties: {
        category: { type: "string" },
        name: { type: "string" },
        purpose: { type: "string" },
        targetAudience: { type: "string" },
      },
      additionalProperties: false,
    },
    requirements: {
      type: "object",
      description: "Functional and page requirements for the website",
      properties: {
        pages: {
          type: "array",
          description: "List of site pages (between 1 and 16)",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              purpose: { type: "string" },
            },
            required: ["name", "path"],
            additionalProperties: false,
          },
        },
        features: {
          type: "array",
          description: "Required functional features",
          items: { type: "string" },
          maxItems: 32,
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          maxItems: 16,
        },
        responsiveRequirements: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
        },
        contentRequirements: {
          type: "array",
          items: { type: "string" },
          maxItems: 24,
        },
        sections: {
          type: "array",
          items: { type: "string" },
          maxItems: 24,
        },
      },
      required: ["pages", "features"],
      additionalProperties: false,
    },
    design: {
      type: "object",
      description: "Visual and UX design guidelines",
      properties: {
        direction: { type: "string" },
        tone: { type: "string" },
        layout: { type: "string" },
        colorDirection: { type: "string" },
        typographyDirection: { type: "string" },
        responsiveness: { type: "boolean" },
        style: { type: "string" },
        theme: { type: "string" },
        colors: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        typography: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        spacing: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        layoutDirection: {
          type: "string",
          enum: ["LTR", "RTL"],
        },
        responsiveStrategy: { type: "string" },
      },
      required: ["direction", "responsiveness"],
      additionalProperties: false,
    },
    implementation: {
      type: "object",
      description: "Technical stack and implementation decisions",
      properties: {
        framework: { type: "string", enum: ["react-vite"] },
        language: { type: "string", enum: ["typescript"] },
        stylingStrategy: { type: "string" },
      },
      required: ["framework", "language"],
      additionalProperties: false,
    },
    capabilities: {
      type: "object",
      description: "Optional advanced runtime, auth, and integration capabilities",
      properties: {
        runtime: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            collections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  fields: { type: "array", items: { type: "object" } },
                  access: { type: "object" },
                },
                required: ["name", "fields"],
              },
            },
          },
          required: ["enabled", "collections"],
        },
        auth: {
          type: "object",
          properties: {
            authRequired: { type: "boolean" },
            publicPages: { type: "array", items: { type: "string" } },
            protectedPages: { type: "array", items: { type: "string" } },
            capabilities: { type: "array", items: { type: "string" } },
            ownerCollections: { type: "array", items: { type: "string" } },
          },
          required: ["authRequired"],
        },
        integrations: {
          type: "object",
          properties: {
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  purpose: { type: "string" },
                  inputFields: { type: "array", items: { type: "string" } },
                  authRequired: { type: "boolean" },
                  secretRefs: { type: "array", items: { type: "string" } },
                },
                required: ["name", "purpose"],
              },
            },
          },
          required: ["actions"],
        },
      },
      additionalProperties: false,
    },
    content: {
      type: "object",
      description: "Initial copy and structured content plan",
      properties: {
        headline: { type: "string" },
        subheading: { type: "string" },
        primaryCta: { type: "string" },
        sectionCopy: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        faq: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
            },
            required: ["question", "answer"],
            additionalProperties: false,
          },
        },
      },
      required: ["headline", "subheading", "primaryCta"],
      additionalProperties: false,
    },
  },
  required: ["requirements", "design"],
  additionalProperties: false,
};

export const SITE_PLAN_JSON_SCHEMA = CANONICAL_SITE_PLAN_JSON_SCHEMA;

export const CANONICAL_SITE_EDIT_PLAN_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SiteEditPlan",
  type: "object",
  properties: {
    requestedChanges: {
      type: "array",
      description: "List of requested modifications",
      items: { type: "string" },
    },
    mustPreserve: {
      type: "array",
      description: "Components, routes, or features that must not be broken or removed",
      items: { type: "string" },
    },
    likelyAffectedAreas: {
      type: "array",
      description: "Files, sections, or styles expected to change",
      items: { type: "string" },
    },
    mutations: {
      type: "object",
      description: "Flags indicating which subsystems need schema/code updates",
      properties: {
        runtime: { type: "boolean" },
        auth: { type: "boolean" },
        integration: { type: "boolean" },
      },
      required: ["runtime", "auth", "integration"],
      additionalProperties: false,
    },
  },
  required: ["requestedChanges", "mustPreserve", "likelyAffectedAreas", "mutations"],
  additionalProperties: false,
};

export const SITE_EDIT_PLAN_JSON_SCHEMA = CANONICAL_SITE_EDIT_PLAN_JSON_SCHEMA;

/**
 * Projects a canonical JSON Schema to Gemini-supported schema format.
 * Strips unsupported keywords like `$schema` if present.
 */
export function projectGeminiSchema(
  canonicalSchema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const clean = (obj: unknown): unknown => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(clean);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "$schema") continue; // Not supported by Gemini responseSchema
      result[k] = clean(v);
    }
    return result;
  };
  return clean(canonicalSchema) as Record<string, unknown>;
}

/**
 * Projects a canonical JSON Schema to OpenAI-supported schema format.
 */
export function projectOpenAISchema(
  canonicalSchema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const clean = (obj: unknown): unknown => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(clean);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "$schema") continue;
      result[k] = clean(v);
    }
    return result;
  };
  return clean(canonicalSchema) as Record<string, unknown>;
}
