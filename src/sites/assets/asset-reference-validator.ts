import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { isVisualReferenceAsset, type AssetManifest } from "./asset-domain.js";

export interface AssetReferenceDiagnostic {
  readonly path: string;
  readonly reference: string;
  readonly kind: "REMOTE_URL" | "DATA_URI" | "UNKNOWN_MANAGED_ASSET" | "MISSING_LOCAL_ASSET";
}

export interface AssetReferenceValidationOptions {
  /** Missing local references already present before this run (for example in an edited parent version). */
  readonly tolerateMissingLocal?: ReadonlySet<string>;
}

const mediaAttribute = /(?:src|poster|image|backgroundImage)\s*=\s*["']([^"']+)["']/gi;
const cssUrl = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const cssImport = /@import\s+(?:url\(\s*)?(["']?)(https?:\/\/[^\s"')]+)\1\s*\)?[^;]*;/gi;
const stylesheetLink = /<link\b[^>]*>/gi;

function invalid(diagnostic: AssetReferenceDiagnostic): never {
  throw new ApplicationError(
    "ASSET_REFERENCE_INVALID",
    `Asset reference is not allowed: ${diagnostic.reference}`,
    { metadata: { ...diagnostic } },
  );
}

function checkReference(path: string, reference: string, allowed: ReadonlySet<string>): void {
  const value = reference.trim();
  if (/^https?:\/\//i.test(value)) invalid({ path, reference: value, kind: "REMOTE_URL" });
  if (/^data:image\//i.test(value)) invalid({ path, reference: value.slice(0, 80), kind: "DATA_URI" });
  if (value.startsWith("/__sites/assets/") && !allowed.has(value)) invalid({ path, reference: value, kind: "UNKNOWN_MANAGED_ASSET" });
}

const localMediaExtension = /\.(?:png|jpe?g|webp|gif|svg|avif|ico|bmp|mp4|webm)$/i;
const scriptSource = /\.(?:[cm]?[jt]sx?)$/i;

/**
 * The public/ file a browser would request for a local media reference, or
 * undefined when the reference is not a plain local media file. Root-relative
 * references are served from public/ (Vite leaves missing ones untouched);
 * relative string literals in script source resolve against the page URL at
 * runtime. Relative CSS/HTML references are resolved, and failed, by the build.
 */
function publicFileFor(sourcePath: string, reference: string): string | undefined {
  const value = reference.trim().split(/[?#]/, 1)[0] ?? "";
  if (!value || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/__sites/assets/")) return undefined;
  if (!localMediaExtension.test(value) || /[\s{}$`<>]/.test(value)) return undefined;
  if (!value.startsWith("/") && !scriptSource.test(sourcePath)) return undefined;
  let decoded: string;
  try { decoded = decodeURI(value); } catch { return undefined; }
  const segments = decoded.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.includes("..")) return undefined;
  return `public/${segments.join("/")}`;
}

/**
 * Local image/video references whose file does not exist, e.g. a fabricated
 * `src="/image.png"`. The browser would receive a 404 or the SPA's index.html.
 */
export async function missingLocalAssetReferences(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile">,
  environmentId: string,
): Promise<readonly AssetReferenceDiagnostic[]> {
  const entries = (await execution.listFiles(environmentId)).filter((entry) => entry.type === "FILE");
  const publicFiles = new Set(entries.filter((entry) => entry.path.startsWith("public/")).map((entry) => entry.path));
  const missing: AssetReferenceDiagnostic[] = [];
  for (const entry of entries) {
    if (!(entry.path === "index.html" || entry.path.startsWith("src/"))) continue;
    const content = await execution.readFile(environmentId, entry.path);
    for (const matcher of [mediaAttribute, cssUrl]) {
      matcher.lastIndex = 0;
      for (let match = matcher.exec(content); match; match = matcher.exec(content)) {
        const file = match[1] ? publicFileFor(entry.path, match[1]) : undefined;
        if (file && !publicFiles.has(file)) missing.push({ path: entry.path, reference: match[1]!.trim(), kind: "MISSING_LOCAL_ASSET" });
      }
    }
  }
  return missing;
}

/**
 * Checks generated text for provider URLs/data images, unknown Sites-managed
 * asset paths and local media files that do not exist (a fabricated path such
 * as `/image.png` would render as a broken image). Relative CSS/HTML assets
 * remain under the existing Vite/import resolution rules.
 */
export async function validateAssetReferences(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile">,
  environmentId: string,
  manifest?: AssetManifest,
  options: AssetReferenceValidationOptions = {},
): Promise<readonly AssetReferenceDiagnostic[]> {
  const allowed = new Set((manifest?.assets ?? []).flatMap((asset) => asset.publicPath && !isVisualReferenceAsset(asset) ? [asset.publicPath] : []));
  const diagnostics: AssetReferenceDiagnostic[] = [];
  for (const entry of await execution.listFiles(environmentId)) {
    if (entry.type !== "FILE" || !(entry.path === "index.html" || entry.path.startsWith("src/") || entry.path.startsWith("public/"))) continue;
    const content = await execution.readFile(environmentId, entry.path);
    for (const matcher of [mediaAttribute, cssUrl, cssImport]) {
      matcher.lastIndex = 0;
      for (let match = matcher.exec(content); match; match = matcher.exec(content)) {
        const reference = matcher === cssImport ? match[2] : match[1];
        if (!reference) continue;
        try {
          checkReference(entry.path, reference, allowed);
        } catch (error) {
          if (error instanceof ApplicationError && error.code === "ASSET_REFERENCE_INVALID") {
            diagnostics.push(error.metadata as unknown as AssetReferenceDiagnostic);
            throw error;
          }
          throw error;
        }
      }
    }
    stylesheetLink.lastIndex = 0;
    for (let match = stylesheetLink.exec(content); match; match = stylesheetLink.exec(content)) {
      const link = match[0];
      const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(link)?.[1];
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(link)?.[1];
      if (href && rel?.toLowerCase().split(/\s+/).includes("stylesheet")) checkReference(entry.path, href, allowed);
    }
  }
  const missing = (await missingLocalAssetReferences(execution, environmentId))
    .find((diagnostic) => !options.tolerateMissingLocal?.has(diagnostic.reference));
  if (missing) throw new ApplicationError(
    "ASSET_REFERENCE_INVALID",
    `Image file does not exist in the website: ${missing.reference} (${missing.path}). Use a listed asset path or remove the image.`,
    { metadata: { ...missing } },
  );
  return diagnostics;
}

/** Every accepted user upload is required to appear in generated source. */
export async function validateRequiredUserAssetReferences(execution: Pick<ExecutionProvider, "listFiles" | "readFile">, environmentId: string, manifest?: AssetManifest): Promise<void> {
  const required = (manifest?.assets ?? []).filter((asset) => asset.sourceType === "USER_UPLOAD" && !isVisualReferenceAsset(asset) && asset.publicPath);
  if (!required.length) return;
  const source = await Promise.all((await execution.listFiles(environmentId)).filter((entry) => entry.type === "FILE" && (entry.path === "index.html" || entry.path.startsWith("src/"))).map((entry) => execution.readFile(environmentId, entry.path)));
  const missing = required.find((asset) => !source.some((content) => content.includes(asset.publicPath!)));
  if (missing) throw new ApplicationError("USER_ASSET_NOT_REFERENCED", `Required user image was not referenced: ${missing.provenance.userUploadName ?? missing.assetId}`, { metadata: { assetId: missing.assetId, originalName: missing.provenance.userUploadName } });
}
