import { ApplicationError } from "../../app/errors/application-error.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
import { APPROVED_UI_PACKAGE_VERSIONS } from "./optional-dependencies.js";
export type SiteGenerationWarningCode =
  | "UNSUPPORTED_FEATURE_IGNORED"
  | "PLACEHOLDER_ASSET_USED"
  | "DEPENDENCY_REJECTED"
  | "PREVIEW_VALIDATION_WARNING";
export interface SiteGenerationWarning {
  readonly code: SiteGenerationWarningCode;
  readonly message: string;
}
export interface ScopeValidationResult {
  readonly unsupportedFeatures: readonly string[];
  readonly warnings: readonly SiteGenerationWarning[];
  readonly normalizedRequirements: readonly string[];
}
// A negation cue, optionally followed by the verb/determiner it governs
// ("no", "without a", "do not use any", "doesn't need a", "not connected to").
const NEGATION_CUE =
  /\b(?:no|without|not|never|nor|avoid(?:ing)?|(?:do|does|did|should|must|will)\s*(?:not|n't)|(?:don|doesn|didn|shouldn|mustn|won)['’]t)(?:\s+(?:use|using|need|needs|require|requires|include|add|have|want|connect(?:ed)?|to|any|a|an|the|real|actual|external|separate|server-side))*\b/gi;
// Words that end a negated list and start an affirmative request
// ("no login but store orders in a database").
const AFFIRMATIVE_BREAK =
  /\b(?:but|however|with|using|use|uses|add|include|need|needs|require|requires|store|stores|save|saves|persist|persists|connect|connects|via|through|that|which|for)\b/i;

/** True when every mention of `term` is explicitly excluded ("no database", "without a backend server"). */
function onlyNegatedMentions(prompt: string, term: string): boolean {
  const pattern = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "gi");
  let mentioned = false;
  for (const clause of prompt.split(/[.;!?\n]/)) {
    for (const match of clause.matchAll(pattern)) {
      mentioned = true;
      const before = clause.slice(0, match.index);
      const cues = [...before.matchAll(NEGATION_CUE)];
      const cue = cues.at(-1);
      if (!cue) return false;
      const between = before.slice((cue.index ?? 0) + cue[0].length);
      if (AFFIRMATIVE_BREAK.test(between)) return false;
    }
  }
  return mentioned;
}

export class SitesV1ScopeValidator {
  readonly #unsupported = [
    "kubernetes",
    "redis",
    "docker",
    "backend server",
    "database",
    "background worker",
  ];
  validate(prompt: string): ScopeValidationResult {
    const unsupportedFeatures = this.#unsupported.filter((item) => {
      const mentioned = new RegExp(`\\b${item.replace(/\s+/g, "\\s+")}\\b`, "i").test(prompt);
      return mentioned && !onlyNegatedMentions(prompt, item);
    });
    if (unsupportedFeatures.length)
      throw new ApplicationError(
        "UNSUPPORTED_SITE_REQUIREMENT",
        `Unsupported Phase 6 requirement: ${unsupportedFeatures.join(", ")}`,
        { metadata: { unsupportedFeatures } },
      );
    return {
      unsupportedFeatures: [],
      warnings: [],
      normalizedRequirements: [
        "responsive desktop/tablet/mobile",
        "basic semantic accessibility",
        "frontend-only React/Vite",
      ],
    };
  }
}
export class SiteDependencyPolicy {
  // Approved optional UI packages are sourced from the single registry that also
  // drives import validation and installation, so package.json policy cannot
  // drift from what a generated site is actually allowed to import.
  readonly allowed = new Set([
    "react",
    "react-dom",
    "react-router-dom",
    "vite",
    "typescript",
    "@vitejs/plugin-react",
    "@types/react",
    "@types/react-dom",
    ...Object.keys(APPROVED_UI_PACKAGE_VERSIONS),
  ]);
  validate(names: readonly string[]): void {
    const rejected = names.filter((name) => !this.allowed.has(name));
    if (rejected.length)
      throw new ApplicationError(
        "DEPENDENCY_POLICY_VIOLATION",
        `Dependencies are not approved: ${rejected.join(", ")}`,
        { metadata: { rejected } },
      );
  }
}
export class SitePackageValidator {
  constructor(private readonly dependencies = new SiteDependencyPolicy()) {}
  validate(content: string): void {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new ApplicationError("DEPENDENCY_POLICY_VIOLATION", "package.json is invalid JSON");
    }
    if (!value || typeof value !== "object")
      throw new ApplicationError("DEPENDENCY_POLICY_VIOLATION", "package.json must be an object");
    const pkg = value as Record<string, unknown>;
    if (
      pkg.packageManager &&
      typeof pkg.packageManager === "string" &&
      !pkg.packageManager.startsWith("npm")
    )
      throw new ApplicationError("DEPENDENCY_POLICY_VIOLATION", "Only npm is supported");
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts) : [];
    const rejectedScripts = scripts.filter((name) => !["build", "dev", "test"].includes(name));
    if (rejectedScripts.length)
      throw new ApplicationError(
        "DEPENDENCY_POLICY_VIOLATION",
        `Scripts are not approved: ${rejectedScripts.join(", ")}`,
      );
    const dependencyEntries = [pkg.dependencies, pkg.devDependencies].flatMap((section) =>
      section && typeof section === "object"
        ? Object.entries(section as Record<string, unknown>)
        : [],
    );
    const unsafeSources = dependencyEntries
      .filter(([, version]) =>
        typeof version === "string"
          ? /^(?:file:|git(?:\+|:)|https?:|workspace:|link:)/i.test(version)
          : true,
      )
      .map(([name]) => name);
    if (unsafeSources.length)
      throw new ApplicationError(
        "DEPENDENCY_POLICY_VIOLATION",
        `Dependencies use unsupported sources: ${unsafeSources.join(", ")}`,
        { metadata: { rejected: unsafeSources } },
      );
    const names = dependencyEntries.map(([name]) => name);
    this.dependencies.validate(names);
  }
}
export class GeneratedProjectValidator {
  async validate(execution: LocalExecutionProvider, environmentId: string): Promise<void> {
    for (const path of ["package.json", "index.html"])
      if (!(await execution.fileExists(environmentId, path)))
        throw new ApplicationError("VALIDATION_FAILED", `Generated project is missing ${path}`);
    const entrypoints = ["src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js"];
    if (!(await Promise.all(entrypoints.map((path) => execution.fileExists(environmentId, path)))).some(Boolean))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Generated project is missing a supported src/main entrypoint",
      );
    const files = await execution.listFiles(environmentId, "src");
    if (
      !files.some(
        (entry) => entry.type === "FILE" && /(^|\/)App\.(tsx|ts|jsx|js)$/.test(entry.path),
      )
    )
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Generated project is missing an application component",
      );
    if (
      execution.getLastBuildSuccess(environmentId) !== true ||
      !(await execution.fileExists(environmentId, "dist/index.html"))
    )
      throw new ApplicationError(
        "BUILD_FAILED",
        "Generated project has no successful production build output",
      );
  }
}
export class BuildObservationFormatter {
  constructor(private readonly maxBytes = 8_000) {}
  format(stderr: string, stdout = ""): string {
    const combined = `${stderr}\n${stdout}`.trim();
    const buffer = Buffer.from(combined);
    return buffer.length <= this.maxBytes
      ? combined
      : `[build output truncated]\n${buffer.subarray(-this.maxBytes).toString()}`;
  }
}
export class SiteFunctionalValidator {
  async validate(
    url: string,
    expectedContent?: string,
  ): Promise<{ readonly status: number; readonly contentVerified: boolean }> {
    const root = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!root.ok)
      throw new ApplicationError("PREVIEW_FAILED", `Preview returned HTTP ${root.status}`);
    const html = await root.text();
    if (!/<div[^>]+id=["']root["']/.test(html))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Preview HTML does not contain the application root",
      );
    let contentVerified = true;
    if (expectedContent) {
      const module = await fetch(`${url}/src/App.tsx`, { signal: AbortSignal.timeout(5_000) });
      contentVerified = module.ok && (await module.text()).includes(expectedContent);
      if (!contentVerified)
        throw new ApplicationError(
          "VALIDATION_FAILED",
          "Expected generated content was not served",
        );
    }
    return { status: root.status, contentVerified };
  }
}
