import { createHash } from "node:crypto";
import ts from "typescript";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { SiteSpec } from "../../sites/domain/site-spec.js";

/**
 * Model-submitted completion manifest claiming generation completion.
 */
export interface GenerationCompletionManifest {
  readonly filesImplemented: readonly string[];
  readonly pagesImplemented: readonly string[];
  readonly sectionsImplemented: readonly string[];
  readonly navigationImplemented: boolean;
  readonly responsiveImplementationCompleted: boolean;
}

/**
 * Deterministically constructed requirements that generation must satisfy.
 */
export interface GenerationCompletionRequirements {
  readonly requiredFiles: readonly string[];
  readonly requiredPages: readonly string[];
  readonly requiredSections: readonly string[];
  readonly requireNavigation: boolean;
  readonly requireResponsiveImplementation: boolean;
  readonly scaffoldHashes?: Readonly<Record<string, string>> | undefined;
  readonly requireScaffoldBaseline?: boolean | undefined;
}

export type CompletionIssueCode =
  | "MISSING_REQUIRED_FILE"
  | "EMPTY_REQUIRED_FILE"
  | "REQUIRED_FILE_NOT_MODIFIED"
  | "SCAFFOLD_BASELINE_UNAVAILABLE"
  | "MISSING_PAGE"
  | "MISSING_SECTION"
  | "MISSING_PAGE_EVIDENCE"
  | "MISSING_SECTION_EVIDENCE"
  | "NAVIGATION_NOT_IMPLEMENTED"
  | "RESPONSIVE_NOT_IMPLEMENTED"
  | "UNSAFE_PATH"
  | "INVALID_MANIFEST";

export interface CompletionIssue {
  readonly code: CompletionIssueCode;
  readonly target: string;
  readonly message: string;
}

export interface CompletionValidationResult {
  readonly valid: boolean;
  readonly issues: readonly CompletionIssue[];
}

export interface GenerationCompletionTelemetry {
  readonly attempts: number;
  readonly accepted: boolean;
  readonly rejectedAttempts: number;
  readonly lastIssues?: readonly { readonly code: string; readonly target: string }[] | undefined;
}

export interface StructuralEvidence {
  readonly pages: ReadonlySet<string>;
  readonly sections: ReadonlySet<string>;
}

/**
 * Canonical normalized representation of SiteSpec page and section requirements.
 */
export interface NormalizedSiteSpecIdentity {
  readonly pageIds: readonly string[];
  readonly sectionIds: readonly string[];
}

/**
 * Derives a stable, canonical alphanumeric identifier from any name or path.
 */
export function canonicalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Single authoritative normalization path transforming raw SiteSpec structures
 * into deterministic canonical page and section identifiers.
 */
export function normalizeSiteSpecIdentity(siteSpec?: SiteSpec | undefined): NormalizedSiteSpecIdentity {
  // 1. Authoritative page identifiers from siteSpec.requirements.pages
  const rawPages = siteSpec?.requirements?.pages ?? [];
  const pageIds = rawPages.length > 0
    ? [...new Set(rawPages.map((p) => canonicalizeIdentifier(p.name || p.path || "home")).filter(Boolean))]
    : ["home"];

  // 2. Authoritative section identifiers from content plan / requirements
  let rawSections: readonly string[] = [];
  if (siteSpec?.content?.sectionCopy && Object.keys(siteSpec.content.sectionCopy).length > 0) {
    rawSections = Object.keys(siteSpec.content.sectionCopy);
  } else if (
    siteSpec?.requirements &&
    "sections" in siteSpec.requirements &&
    Array.isArray((siteSpec.requirements as any).sections)
  ) {
    rawSections = (siteSpec.requirements as any).sections;
  } else if (siteSpec?.requirements?.features && siteSpec.requirements.features.length > 0) {
    rawSections = siteSpec.requirements.features;
  } else {
    rawSections = ["hero"];
  }

  const sectionIds = [...new Set(rawSections.map(canonicalizeIdentifier).filter(Boolean))];

  return {
    pageIds: pageIds.length > 0 ? pageIds : ["home"],
    sectionIds: sectionIds.length > 0 ? sectionIds : ["hero"],
  };
}

/**
 * Deterministically derives GenerationCompletionRequirements from a SiteSpec.
 */
export function buildCompletionRequirements(
  siteSpec?: SiteSpec | undefined,
  scaffoldHashes?: Readonly<Record<string, string>> | undefined,
): GenerationCompletionRequirements {
  // The model owns the application entry component. Styles and all project
  // infrastructure are already present in the deterministic starter and may
  // be overlaid by the model, but do not need to be reproduced in its bundle.
  const requiredFiles = ["src/App.tsx"];
  const identity = normalizeSiteSpecIdentity(siteSpec);

  const requireNavigation = identity.pageIds.length > 1;
  const requireResponsiveImplementation = true;

  return {
    requiredFiles,
    requiredPages: identity.pageIds,
    requiredSections: identity.sectionIds,
    requireNavigation,
    requireResponsiveImplementation,
    ...(scaffoldHashes !== undefined ? { scaffoldHashes } : {}),
    requireScaffoldBaseline: true,
  };
}

/**
 * Statically resolves the string value of a JSX attribute.
 * Only accepts StringLiteral or static NoSubstitutionTemplateLiteral.
 * Explicitly rejects dynamic expressions (identifiers, function calls, template expressions with spans).
 */
export function extractStaticJsxAttributeValue(attr: ts.JsxAttribute): string | undefined {
  const initializer = attr.initializer;
  if (!initializer) {
    return undefined;
  }

  // <element attr="value" />
  if (ts.isStringLiteral(initializer)) {
    return initializer.text;
  }

  // <element attr={"value"} /> or <element attr={`value`} />
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    const expr = initializer.expression;
    if (ts.isStringLiteral(expr)) {
      return expr.text;
    }
    if (ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text;
    }
  }

  return undefined;
}

/**
 * Extracts statically determinable data-sites-page and data-sites-section attribute values
 * from a TSX/JSX AST. Ignores comments, strings, template literals, metadata objects, and dynamic expressions.
 */
export function extractJsxStructuralMarkers(
  filePath: string,
  content: string,
  scriptKind?: ts.ScriptKind,
): StructuralEvidence {
  const pages = new Set<string>();
  const sections = new Set<string>();

  const kind =
    scriptKind ??
    (filePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : filePath.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.TS);

  try {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);

    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        for (const prop of node.attributes.properties) {
          if (ts.isJsxAttribute(prop)) {
            const attrName = ts.isIdentifier(prop.name)
              ? prop.name.text.toLowerCase()
              : prop.name.getText(sourceFile).toLowerCase();
            if (attrName === "data-sites-page" || attrName === "data-sites-section") {
              const staticValue = extractStaticJsxAttributeValue(prop);
              if (staticValue !== undefined) {
                const canonical = canonicalizeIdentifier(staticValue);
                if (canonical) {
                  if (attrName === "data-sites-page") {
                    pages.add(canonical);
                  } else {
                    sections.add(canonical);
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch {
    // If parsing encounters an internal anomaly, return empty sets safely
  }

  return { pages, sections };
}

/**
 * Deterministically extracts structural markers from HTML content,
 * safely ignoring HTML comments and script/style block contents.
 */
export function extractHtmlStructuralMarkers(htmlContent: string): StructuralEvidence {
  const pages = new Set<string>();
  const sections = new Set<string>();

  // 1. Strip comments: <!-- ... -->
  let sanitized = htmlContent.replace(/<!--[\s\S]*?-->/g, "");
  // 2. Strip scripts and styles to prevent matching string literals inside JS/CSS
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // 3. Match opening or self-closing tags with data-sites-page or data-sites-section
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9:-]*)\s+([^>]*?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(sanitized)) !== null) {
    const attrString = match[2];
    if (!attrString) continue;

    const pageMatch = /\bdata-sites-page\s*=\s*["']([^"']+)["']/i.exec(attrString);
    if (pageMatch && pageMatch[1]) {
      const canonical = canonicalizeIdentifier(pageMatch[1]);
      if (canonical) pages.add(canonical);
    }

    const sectionMatch = /\bdata-sites-section\s*=\s*["']([^"']+)["']/i.exec(attrString);
    if (sectionMatch && sectionMatch[1]) {
      const canonical = canonicalizeIdentifier(sectionMatch[1]);
      if (canonical) sections.add(canonical);
    }
  }

  return { pages, sections };
}

/**
 * Deterministic validator verifying both manifest claims and structural source evidence.
 */
export class GenerationCompletionValidator {
  constructor(private readonly execution: ExecutionProvider) {}

  async validate(
    environmentId: string,
    requirements: GenerationCompletionRequirements,
    manifest: GenerationCompletionManifest,
  ): Promise<CompletionValidationResult> {
    const issues: CompletionIssue[] = [];

    if (!manifest || typeof manifest !== "object") {
      return {
        valid: false,
        issues: [
          {
            code: "INVALID_MANIFEST",
            target: "manifest",
            message: "Completion manifest must be an object",
          },
        ],
      };
    }

    // 1. Safety check on manifest file paths
    const filesImplemented = Array.isArray(manifest.filesImplemented)
      ? manifest.filesImplemented
      : [];
    for (const rawPath of filesImplemented) {
      if (typeof rawPath !== "string") {
        issues.push({
          code: "UNSAFE_PATH",
          target: String(rawPath),
          message: `Invalid file path in completion manifest: '${rawPath}'`,
        });
        continue;
      }
      const trimmed = rawPath.trim();
      if (
        trimmed.startsWith("/") ||
        trimmed.startsWith("\\") ||
        trimmed.includes("..") ||
        /^[A-Za-z]:/.test(trimmed)
      ) {
        issues.push({
          code: "UNSAFE_PATH",
          target: rawPath,
          message: `Path in completion manifest must be project-relative and safe: '${rawPath}'`,
        });
      }
    }

    // 2. Required files existence, non-emptiness, and scaffold baseline divergence
    const normalizedImplementedFiles = new Set(
      filesImplemented.map((f) => String(f).trim().replace(/\\/g, "/")),
    );

    for (const reqFile of requirements.requiredFiles) {
      const normalizedReq = reqFile.trim().replace(/\\/g, "/");
      let content: string;
      try {
        content = await this.execution.readFile(environmentId, normalizedReq);
      } catch {
        issues.push({
          code: "MISSING_REQUIRED_FILE",
          target: normalizedReq,
          message: `Required file '${normalizedReq}' does not exist in workspace`,
        });
        continue;
      }

      if (content.trim().length === 0) {
        issues.push({
          code: "EMPTY_REQUIRED_FILE",
          target: normalizedReq,
          message: `Required file '${normalizedReq}' is empty`,
        });
        continue;
      }

      // Scaffold baseline check: must be genuinely modified from starter scaffold
      if (requirements.requireScaffoldBaseline) {
        const baselineHash = requirements.scaffoldHashes?.[normalizedReq];
        if (!baselineHash) {
          issues.push({
            code: "SCAFFOLD_BASELINE_UNAVAILABLE",
            target: normalizedReq,
            message: `Scaffold baseline hash is unexpectedly unavailable for required file '${normalizedReq}'`,
          });
        } else {
          const currentHash = createHash("sha256").update(content).digest("hex");
          if (currentHash === baselineHash) {
            issues.push({
              code: "REQUIRED_FILE_NOT_MODIFIED",
              target: normalizedReq,
              message: `Required file '${normalizedReq}' has not been modified from its scaffold baseline`,
            });
          }
        }
      }

      if (!normalizedImplementedFiles.has(normalizedReq)) {
        issues.push({
          code: "MISSING_REQUIRED_FILE",
          target: normalizedReq,
          message: `Required file '${normalizedReq}' was not declared in filesImplemented manifest`,
        });
      }
    }

    // 3. Inspect source files across workspace using AST and syntactic parsers
    const foundPages = new Set<string>();
    const foundSections = new Set<string>();

    try {
      const allFiles = await this.execution.listFiles(environmentId);
      for (const entry of allFiles) {
        if (entry.type !== "FILE") continue;

        const normalizedPath = entry.path.replace(/\\/g, "/");
        if (
          normalizedPath.endsWith(".tsx") ||
          normalizedPath.endsWith(".jsx") ||
          normalizedPath.endsWith(".ts")
        ) {
          try {
            const content = await this.execution.readFile(environmentId, entry.path);
            const markers = extractJsxStructuralMarkers(normalizedPath, content);
            for (const p of markers.pages) foundPages.add(p);
            for (const s of markers.sections) foundSections.add(s);
          } catch {
            // ignore unreadable files
          }
        } else if (normalizedPath.endsWith(".html")) {
          try {
            const content = await this.execution.readFile(environmentId, entry.path);
            const markers = extractHtmlStructuralMarkers(content);
            for (const p of markers.pages) foundPages.add(p);
            for (const s of markers.sections) foundSections.add(s);
          } catch {
            // ignore unreadable files
          }
        }
      }
    } catch {
      // ignore list failures
    }

    // 4. Required pages: manifest declaration AND structural marker evidence
    const declaredPages = new Set(
      (Array.isArray(manifest.pagesImplemented) ? manifest.pagesImplemented : []).map((p) =>
        canonicalizeIdentifier(String(p)),
      ),
    );

    for (const reqPage of requirements.requiredPages) {
      const canonicalReqPage = canonicalizeIdentifier(reqPage);

      // Manifest coverage check
      if (!declaredPages.has(canonicalReqPage)) {
        issues.push({
          code: "MISSING_PAGE",
          target: reqPage,
          message: `Required page '${reqPage}' is not declared in pagesImplemented manifest`,
        });
      }

      // Structural evidence check (AST extracted data-sites-page)
      if (!foundPages.has(canonicalReqPage)) {
        issues.push({
          code: "MISSING_PAGE_EVIDENCE",
          target: reqPage,
          message: `Required page '${reqPage}' lacks structural evidence in source (missing data-sites-page="${canonicalReqPage}")`,
        });
      }
    }

    // 5. Required sections: manifest declaration AND structural marker evidence
    const declaredSections = new Set(
      (Array.isArray(manifest.sectionsImplemented) ? manifest.sectionsImplemented : []).map((s) =>
        canonicalizeIdentifier(String(s)),
      ),
    );

    for (const reqSection of requirements.requiredSections) {
      const canonicalReqSection = canonicalizeIdentifier(reqSection);

      // Manifest coverage check
      if (!declaredSections.has(canonicalReqSection)) {
        issues.push({
          code: "MISSING_SECTION",
          target: reqSection,
          message: `Required section '${reqSection}' is not declared in sectionsImplemented manifest`,
        });
      }

      // Structural evidence check (AST extracted data-sites-section)
      if (!foundSections.has(canonicalReqSection)) {
        issues.push({
          code: "MISSING_SECTION_EVIDENCE",
          target: reqSection,
          message: `Required section '${reqSection}' lacks structural evidence in source (missing data-sites-section="${canonicalReqSection}")`,
        });
      }
    }

    // 6. Navigation requirement
    if (requirements.requireNavigation && !manifest.navigationImplemented) {
      issues.push({
        code: "NAVIGATION_NOT_IMPLEMENTED",
        target: "navigation",
        message:
          "Navigation between pages/sections is required by SiteSpec but navigationImplemented is false",
      });
    }

    // 7. Responsive implementation declaration (honest verification: declaration + styles modified)
    if (requirements.requireResponsiveImplementation && !manifest.responsiveImplementationCompleted) {
      issues.push({
        code: "RESPONSIVE_NOT_IMPLEMENTED",
        target: "responsive",
        message:
          "Responsive mobile/tablet/desktop implementation is required by SiteSpec but responsiveImplementationCompleted is false",
      });
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}

/**
 * Produces a compact, token-efficient observation instructing the model on missing requirements.
 */
export function formatCompletionIssues(issues: readonly CompletionIssue[]): string {
  const lines = [
    "Generation is not complete.",
    "",
    "Unresolved requirements:",
    ...issues.map((i) => `- [${i.code}] ${i.message}`),
    "",
    "Complete the missing implementation, ensure structural markers (data-sites-page, data-sites-section) are present, and call finalize_generation again.",
  ];
  return lines.join("\n");
}
