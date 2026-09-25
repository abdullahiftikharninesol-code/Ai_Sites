import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { GenerationCompletionManifest, GenerationCompletionRequirements } from "../../agents/validation/generation-completion.js";
import { GenerationCompletionValidator } from "../../agents/validation/generation-completion.js";
import { validateSiteNameCandidate } from "../../sites/generation/site-name.js";

export interface SiteCoderFileBundleFile {
  readonly path: string;
  readonly content: string;
}

export interface SiteCoderFileBundle {
  readonly siteName?: string | undefined;
  readonly files: readonly SiteCoderFileBundleFile[];
}

export interface BuildRepairPatchBundle {
  readonly patches: readonly { readonly path: string; readonly find: string; readonly replace: string }[];
}

/** "unique" must match exactly once; "all" replaces every exact occurrence. */
export type SiteEditPatchMode = "unique" | "all";

export interface SiteEditPatch {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly mode: SiteEditPatchMode;
}

export interface SiteEditPatchBundle {
  readonly patches: readonly SiteEditPatch[];
}

export const SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object", additionalProperties: false, required: ["patches"],
  properties: { patches: { type: "array", minItems: 1, maxItems: 8, items: {
    type: "object", additionalProperties: false, required: ["path", "find", "replace", "mode"],
    properties: {
      path: { type: "string" },
      find: { type: "string", minLength: 1 },
      replace: { type: "string" },
      mode: {
        type: "string",
        enum: ["unique", "all"],
        description:
          "unique: 'find' must occur exactly once, so include surrounding source context. all: replace every exact occurrence, for deliberate repeated renames.",
      },
    },
  } } },
});

export function validateSiteEditPatchBundle(value: unknown): SiteEditPatchBundle {
  if (!value || typeof value !== "object" || !Array.isArray((value as { patches?: unknown }).patches))
    throw new ApplicationError("VALIDATION_FAILED", "SiteEditPatchBundle must contain a patches array");
  const patches = (value as { patches: readonly unknown[] }).patches;
  if (patches.length === 0 || patches.length > 8)
    throw new ApplicationError("VALIDATION_FAILED", "Site edit patch count is outside the allowed range");
  // Several patches may target one file: "change the headline and the CTA" is a
  // single ordinary edit, and each patch is applied against freshly read content.
  return Object.freeze({ patches: Object.freeze(patches.map((item) => {
    if (!item || typeof item !== "object") throw new ApplicationError("VALIDATION_FAILED", "Invalid site edit patch");
    const patch = item as { path?: unknown; find?: unknown; replace?: unknown; mode?: unknown };
    if (typeof patch.path !== "string" || typeof patch.find !== "string" || !patch.find ||
      typeof patch.replace !== "string" || !safePath(patch.path) || !editableSourcePath(patch.path) ||
      isManagedSitePath(patch.path))
      throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Site edit patch contains a disallowed path: ${String(patch.path)}`);
    if (patch.mode !== undefined && patch.mode !== "unique" && patch.mode !== "all")
      throw new ApplicationError("VALIDATION_FAILED", `Site edit patch mode must be "unique" or "all": ${String(patch.mode)}`);
    // Providers without strict schema support may omit the mode; unique is the safe default.
    const mode: SiteEditPatchMode = patch.mode === "all" ? "all" : "unique";
    return Object.freeze({ path: patch.path, find: patch.find, replace: patch.replace, mode });
  })) });
}

export async function applySiteEditPatchBundle(
  execution: Pick<ExecutionProvider, "readFile" | "writeFile">,
  environmentId: string,
  bundle: SiteEditPatchBundle,
): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const patch of bundle.patches) {
    const source = await execution.readFile(environmentId, patch.path);
    const matches = countOccurrences(source, patch.find);
    if (matches === 0)
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Edit find text was not found in ${patch.path}. It must match the file byte-for-byte.`,
        { metadata: { path: patch.path, mode: patch.mode, matches: 0 } },
      );
    // Ambiguity stays an error rather than a guess: picking an occurrence would
    // silently edit the wrong place.
    if (patch.mode === "unique" && matches > 1)
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Edit find text matched ${matches} times in ${patch.path}; a unique patch needs more surrounding source context as an anchor, or mode "all" when every occurrence is meant.`,
        { metadata: { path: patch.path, mode: patch.mode, matches } },
      );
    const first = source.indexOf(patch.find);
    const next =
      patch.mode === "all"
        ? source.split(patch.find).join(patch.replace)
        : source.slice(0, first) + patch.replace + source.slice(first + patch.find.length);
    await execution.writeFile(environmentId, patch.path, next);
    changed.push(patch.path);
  }
  return Object.freeze(changed);
}

export const BUILD_REPAIR_PATCH_BUNDLE_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object", additionalProperties: false, required: ["patches"],
  properties: { patches: { type: "array", maxItems: 8, items: {
    type: "object", additionalProperties: false, required: ["path", "find", "replace"],
    properties: { path: { type: "string" }, find: { type: "string", minLength: 1 }, replace: { type: "string" } },
  } } },
});

export function validateBuildRepairPatchBundle(value: unknown): BuildRepairPatchBundle {
  if (!value || typeof value !== "object" || !Array.isArray((value as { patches?: unknown }).patches))
    throw new ApplicationError("VALIDATION_FAILED", "BuildRepairPatchBundle must contain a patches array");
  const patches = (value as { patches: readonly unknown[] }).patches;
  if (patches.length > 8) throw new ApplicationError("VALIDATION_FAILED", "Too many build repair patches");
  return Object.freeze({ patches: Object.freeze(patches.map((item) => {
    if (!item || typeof item !== "object") throw new ApplicationError("VALIDATION_FAILED", "Invalid build repair patch");
    const patch = item as { path?: unknown; find?: unknown; replace?: unknown };
    if (typeof patch.path !== "string" || typeof patch.find !== "string" || !patch.find || typeof patch.replace !== "string" || !safePath(patch.path) || !editableSourcePath(patch.path) || isManagedSitePath(patch.path))
      throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Build repair patch contains a disallowed path: ${String(patch.path)}`);
    return Object.freeze({ path: patch.path, find: patch.find, replace: patch.replace });
  })) });
}

export async function applyBuildRepairPatchBundle(
  execution: Pick<ExecutionProvider, "readFile" | "writeFile">,
  environmentId: string,
  bundle: BuildRepairPatchBundle,
): Promise<void> {
  for (const patch of bundle.patches) {
    const source = await execution.readFile(environmentId, patch.path);
    const index = source.indexOf(patch.find);
    if (index < 0) throw new ApplicationError("VALIDATION_FAILED", `Build repair find text was not found in ${patch.path}`);
    const next = source.slice(0, index) + patch.replace + source.slice(index + patch.find.length);
    await execution.writeFile(environmentId, patch.path, next);
  }
}

export const SITE_CODER_FILE_BUNDLE_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["siteName", "files"],
  properties: {
    siteName: { type: "string", minLength: 1, maxLength: 60 },
    files: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 240 },
          content: { type: "string", maxLength: 250_000 },
        },
      },
    },
  },
});

/** Broad edits reuse the file-bundle shape but must not rename an existing site. */
export const SITE_CODER_EDIT_FILE_BUNDLE_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: (SITE_CODER_FILE_BUNDLE_JSON_SCHEMA.properties as Record<string, unknown>).files,
  },
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.startsWith("\\") &&
    !/^[A-Za-z]:/.test(path) && !path.split("/").includes("..") && !path.includes("\\");
}

export function normalizeSiteCoderPath(input: string): string {
  const replaced = input.replaceAll("\\", "/");
  if (!replaced || replaced.includes("\0") || replaced.startsWith("/") || /^[A-Za-z]:/.test(replaced))
    throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Site coder bundle contains a disallowed path: ${input}`);
  const segments = replaced.split("/");
  while (segments[0] === ".") segments.shift();
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Site coder bundle contains a disallowed path: ${input}`);
  return segments.join("/");
}

const MANAGED_SITE_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "src/main.tsx",
  "src/vite-env.d.ts",
];

/** Sites owns these files; generation, edit, and repair all honour the same boundary. */
export function isManagedSitePath(path: string): boolean {
  return path.startsWith("src/sites-ui/") || MANAGED_SITE_FILES.includes(path);
}

function editableSourcePath(path: string): boolean {
  return /^src\/.+\.(?:tsx?|jsx?|css|svg|json)$/i.test(path) || /^public\/.+\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(path);
}

export function validateSiteCoderFileBundle(value: unknown, requirements?: GenerationCompletionRequirements): SiteCoderFileBundle {
  if (!value || typeof value !== "object" || !Array.isArray((value as { files?: unknown }).files))
    throw new ApplicationError("VALIDATION_FAILED", "SiteCoderFileBundle must contain a files array");
  const files = (value as { files: readonly unknown[] }).files;
  if (files.length === 0 || files.length > 16) throw new ApplicationError("VALIDATION_FAILED", "SiteCoderFileBundle file count is outside the allowed range");
  const paths = new Set<string>();
  const normalized: SiteCoderFileBundleFile[] = [];
  let bytes = 0;
  for (const item of files) {
    if (!item || typeof item !== "object") throw new ApplicationError("VALIDATION_FAILED", "Each SiteCoderFileBundle item must be an object");
    const rawPath = (item as { path?: unknown }).path;
    const content = (item as { content?: unknown }).content;
    if (typeof rawPath !== "string" || typeof content !== "string")
      throw new ApplicationError("VALIDATION_FAILED", "Each SiteCoderFileBundle item must contain string path and content fields");
    const path = normalizeSiteCoderPath(rawPath);
    if (!safePath(path) || !editableSourcePath(path))
      throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Site coder bundle contains a disallowed path: ${rawPath}`);
    if (isManagedSitePath(path))
      throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Site coder bundle cannot modify managed file: ${path}`);
    if (paths.has(path)) throw new ApplicationError("VALIDATION_FAILED", `Duplicate SiteCoderFileBundle path: ${path}`);
    paths.add(path);
    bytes += Buffer.byteLength(content);
    if (bytes > 1_000_000) throw new ApplicationError("VALIDATION_FAILED", "SiteCoderFileBundle exceeds the write budget");
    normalized.push(Object.freeze({ path, content }));
  }
  if (requirements) {
    for (const required of requirements.requiredFiles) {
      if (!paths.has(required)) throw new ApplicationError("GENERATION_INCOMPLETE", `Site coder bundle is missing required file: ${required}`);
    }
  }
  const siteName = validateSiteNameCandidate((value as { siteName?: unknown }).siteName);
  return Object.freeze({ ...(siteName ? { siteName } : {}), files: Object.freeze(normalized) });
}

export async function materializeSiteCoderFileBundle(
  execution: Pick<ExecutionProvider, "writeFile">,
  environmentId: string,
  bundle: SiteCoderFileBundle,
): Promise<void> {
  for (const file of bundle.files) await execution.writeFile(environmentId, file.path, file.content);
}

export function completionManifestForBundle(bundle: SiteCoderFileBundle, requirements: GenerationCompletionRequirements): GenerationCompletionManifest {
  return {
    filesImplemented: bundle.files.map(({ path }) => path),
    pagesImplemented: requirements.requiredPages,
    sectionsImplemented: requirements.requiredSections,
    navigationImplemented: requirements.requireNavigation,
    responsiveImplementationCompleted: requirements.requireResponsiveImplementation,
  };
}

export async function validateSiteCoderBundleCompletion(
  execution: ExecutionProvider,
  environmentId: string,
  bundle: SiteCoderFileBundle,
  requirements: GenerationCompletionRequirements,
) {
  // The structured bundle is the active completion contract. Legacy DOM markers
  // and model-authored page/section declarations are optional metadata; build
  // and Browser QA validate the resulting application later in the pipeline.
  return new GenerationCompletionValidator(execution).validate(
    environmentId,
    {
      ...requirements,
      requiredPages: [],
      requiredSections: [],
      requireNavigation: false,
      requireResponsiveImplementation: false,
    },
    {
      filesImplemented: bundle.files.map(({ path }) => path),
      pagesImplemented: [],
      sectionsImplemented: [],
      navigationImplemented: false,
      responsiveImplementationCompleted: false,
    },
  );
}
