import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { posix } from "node:path";
import { resolveLocalImportPath } from "./import-validator.js";

export interface DeterministicAutofixEvidence {
  readonly id: string;
  readonly filesChanged: readonly string[];
  readonly reason: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface DeterministicAutofixResult {
  readonly changed: boolean;
  readonly fixes: readonly DeterministicAutofixEvidence[];
}

function isGoogleFontUrl(reference: string): boolean {
  try {
    const url = new URL(reference.replaceAll("&amp;", "&"));
    return (url.protocol === "https:" || url.protocol === "http:") &&
      (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com");
  } catch {
    return false;
  }
}

/** Remove only known Google font loading statements; unrelated URLs stay untouched. */
export function stripRemoteGoogleFontLoads(source: string): string {
  const cssImport = /@import\s+(?:url\(\s*)?(["']?)(https?:\/\/[^\s"')]+)\1\s*\)?[^;]*;/gi;
  const fontFace = /@font-face\s*\{[^{}]*\}/gi;
  const htmlLink = /<link\b[^>]*>/gi;
  return source
    .replace(cssImport, (statement, _quote: string, url: string) => isGoogleFontUrl(url) ? "" : statement)
    .replace(fontFace, (statement) => {
      const references = [...statement.matchAll(/url\(\s*["']?(https?:\/\/[^\s"')]+)["']?\s*\)/gi)];
      return references.length > 0 && references.every((match) => isGoogleFontUrl(match[1]!))
        ? ""
        : statement;
    })
    .replace(htmlLink, (statement) => {
      const href = /\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/i.exec(statement)?.[1];
      const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(statement)?.[1];
      return href && rel?.toLowerCase().split(/\s+/).includes("stylesheet") && isGoogleFontUrl(href)
        ? ""
        : statement;
    });
}

/**
 * Deliberately narrow, idempotent fix boundary. New transforms require an
 * exact evidence rule and a regression test; unknown failures remain failures.
 */
export async function applyDeterministicAutofix(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile" | "writeFile">,
  environmentId: string,
): Promise<DeterministicAutofixResult> {
  const entries = await execution.listFiles(environmentId);
  const files = new Set(entries.filter((entry) => entry.type === "FILE").map((entry) => entry.path.replaceAll("\\", "/")));
  const changed: string[] = [];
  const beforeEvidence: string[] = [];
  const afterEvidence: string[] = [];
  const fixes: DeterministicAutofixEvidence[] = [];
  const fontFiles: string[] = [];
  for (const path of files) {
    if (!(path === "index.html" || /^src\/.+\.(?:css|html|tsx?|jsx?)$/i.test(path))) continue;
    const source = await execution.readFile(environmentId, path);
    const cleaned = stripRemoteGoogleFontLoads(source);
    if (cleaned === source) continue;
    await execution.writeFile(environmentId, path, cleaned);
    changed.push(path);
    fontFiles.push(path);
  }
  if (fontFiles.length) fixes.push(Object.freeze({
    id: "REMOTE_GOOGLE_FONT_CLEANUP",
    filesChanged: Object.freeze(fontFiles),
    reason: "Removed known remote Google font loading statements while preserving local font fallbacks",
    before: Object.freeze(fontFiles.map((path) => `${path}:remote-google-font-load`)),
    after: Object.freeze(fontFiles.map((path) => `${path}:remote-google-font-load-removed`)),
  }));
  for (const path of files) {
    if (!path.startsWith("src/") || !/\.(?:tsx?|jsx?)$/i.test(posix.extname(path))) continue;
    const source = await execution.readFile(environmentId, path);
    const normalized = source.replace(/((?:\bfrom\s*|\bimport\s*\(|\bexport\s+[^;]*?\bfrom\s*)["'])(\.[^"']+?\.js)(["'])/g, (whole, prefix: string, specifier: string, suffix: string) => {
      const resolved = resolveLocalImportPath(path, specifier, files);
      if (!resolved || resolved === posix.normalize(posix.join(posix.dirname(path), specifier))) return whole;
      // Keep the runtime specifier extensionless. Rewriting to `.ts/.tsx`
      // would violate the project's `allowImportingTsExtensions: false`
      // compiler setting even though the source resolver accepts it.
      const canonical = specifier.slice(0, -3);
      beforeEvidence.push(`${path}:${specifier}`);
      afterEvidence.push(`${path}:${canonical}`);
      return `${prefix}${canonical}${suffix}`;
    });
    if (normalized !== source) {
      await execution.writeFile(environmentId, path, normalized);
      changed.push(path);
    }
  }

  const stylesPath = "src/styles.css";
  if (files.has(stylesPath)) {
    const source = await execution.readFile(environmentId, stylesPath);
    const marker = "/* Sites deterministic responsive safety guard */";
    if (!source.includes(marker)) {
      const guard = `

${marker}
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { max-width: 100%; min-width: 0; }
#root { overflow-x: clip; }
img, video, canvas, iframe { display: block; max-width: 100%; height: auto; }
@media (max-width: 768px) {
  body { overflow-x: clip; }
  header, nav, main, section, article, footer, .container, [class*="container"] {
    max-width: 100%;
    min-width: 0;
  }
  header, nav, [class*="header"], [class*="nav"] { flex-wrap: wrap; }
  [class*="grid"] { grid-template-columns: minmax(0, 1fr) !important; }
  [class*="row"] { flex-wrap: wrap; }
  nav a { white-space: normal; }
  h1, h2, h3, h4, p, a, button { overflow-wrap: anywhere; }
}
`;
      await execution.writeFile(environmentId, stylesPath, source + guard);
      changed.push(stylesPath);
      fixes.push(Object.freeze({
        id: "RESPONSIVE_LAYOUT_SAFETY_GUARD",
        filesChanged: Object.freeze([stylesPath]),
        reason: "Added bounded mobile layout constraints for generated content and media",
        before: Object.freeze([`${stylesPath}:missing-responsive-safety-guard`]),
        after: Object.freeze([`${stylesPath}:${marker}`]),
      }));
    }
  }

  if (beforeEvidence.length > 0) {
    fixes.unshift(Object.freeze({
      id: "IMPORT_SPECIFIER_NORMALIZATION",
      filesChanged: Object.freeze(changed.filter((path) => path !== "src/styles.css")),
      reason: "Canonicalized unambiguous TypeScript/Vite .js source specifiers",
      before: Object.freeze(beforeEvidence),
      after: Object.freeze(afterEvidence),
    }));
  }
  return Object.freeze({
    changed: changed.length > 0,
    fixes: Object.freeze(fixes),
  });
}

/**
 * Build-stage entry point. The registry is intentionally shared with the
 * pre-build autofix pass so a known fix cannot diverge by call site.
 */
export async function applyDeterministicBuildRepair(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile" | "writeFile">,
  environmentId: string,
): Promise<DeterministicAutofixResult> {
  return applyDeterministicAutofix(execution, environmentId);
}
