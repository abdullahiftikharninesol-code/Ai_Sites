import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { AssetManifest } from "./asset-domain.js";

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
  const allowed = new Set((manifest?.assets ?? []).flatMap((asset) => asset.publicPath ? [asset.publicPath] : []));
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
