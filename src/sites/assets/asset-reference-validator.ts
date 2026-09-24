import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { isVisualReferenceAsset, type AssetManifest } from "./asset-domain.js";

export interface AssetReferenceDiagnostic {
  readonly path: string;
  readonly reference: string;
  readonly kind: "REMOTE_URL" | "DATA_URI" | "UNKNOWN_MANAGED_ASSET";
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

/**
 * Checks generated text for provider URLs/data images and unknown Sites-managed
 * asset paths. Relative source/CSS assets remain under the existing Vite/import
 * resolution rules; only the managed asset namespace is owned here.
 */
export async function validateAssetReferences(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile">,
  environmentId: string,
  manifest?: AssetManifest,
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
