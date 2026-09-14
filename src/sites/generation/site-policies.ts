import { ApplicationError } from "../../app/errors/application-error.js";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
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
    const unsupportedFeatures = this.#unsupported.filter((item) =>
      prompt.toLowerCase().includes(item),
    );
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
  readonly allowed = new Set([
    "react",
    "react-dom",
    "react-router-dom",
    "lucide-react",
    "framer-motion",
    "vite",
    "typescript",
    "@vitejs/plugin-react",
    "@types/react",
    "@types/react-dom",
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
    for (const path of ["package.json", "index.html", "src/main.tsx"])
      if (!(await execution.fileExists(environmentId, path)))
        throw new ApplicationError("VALIDATION_FAILED", `Generated project is missing ${path}`);
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
