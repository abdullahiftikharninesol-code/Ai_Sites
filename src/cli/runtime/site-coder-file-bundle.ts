import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { GenerationCompletionManifest, GenerationCompletionRequirements } from "../../agents/validation/generation-completion.js";
import { GenerationCompletionValidator } from "../../agents/validation/generation-completion.js";

export interface SiteCoderFileBundleFile {
  readonly path: string;
  readonly content: string;
}

export interface SiteCoderFileBundle {
  readonly files: readonly SiteCoderFileBundleFile[];
}

export interface BuildRepairPatchBundle {
  readonly patches: readonly { readonly path: string; readonly find: string; readonly replace: string }[];
}

export interface SiteEditPatchBundle {
  readonly patches: readonly { readonly path: string; readonly find: string; readonly replace: string }[];
}

export const SITE_EDIT_PATCH_BUNDLE_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object", additionalProperties: false, required: ["patches"],
  properties: { patches: { type: "array", minItems: 1, maxItems: 4, items: {
    type: "object", additionalProperties: false, required: ["path", "find", "replace"],
    properties: { path: { type: "string" }, find: { type: "string", minLength: 1 }, replace: { type: "string" } },
  } } },
});

export function validateSiteEditPatchBundle(value: unknown): SiteEditPatchBundle {
  if (!value || typeof value !== "object" || !Array.isArray((value as { patches?: unknown }).patches))
    throw new ApplicationError("VALIDATION_FAILED", "SiteEditPatchBundle must contain a patches array");
  const patches = (value as { patches: readonly unknown[] }).patches;
  if (patches.length === 0 || patches.length > 4)
    throw new ApplicationError("VALIDATION_FAILED", "Site edit patch count is outside the allowed range");
  const paths = new Set<string>();
  return Object.freeze({ patches: Object.freeze(patches.map((item) => {
    if (!item || typeof item !== "object") throw new ApplicationError("VALIDATION_FAILED", "Invalid site edit patch");
    const patch = item as { path?: unknown; find?: unknown; replace?: unknown };
    if (typeof patch.path !== "string" || typeof patch.find !== "string" || !patch.find ||
      typeof patch.replace !== "string" || !safePath(patch.path) || !editableSourcePath(patch.path) ||
      patch.path.startsWith("src/sites-ui/") || paths.has(patch.path))
      throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Site edit patch contains a disallowed or duplicate path: ${String(patch.path)}`);
    paths.add(patch.path);
    return Object.freeze({ path: patch.path, find: patch.find, replace: patch.replace });
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
    const first = source.indexOf(patch.find);
    if (first < 0) throw new ApplicationError("VALIDATION_FAILED", `Edit find text was not found in ${patch.path}`);
    const second = source.indexOf(patch.find, first + patch.find.length);
    if (second >= 0) throw new ApplicationError("VALIDATION_FAILED", `Edit find text is ambiguous in ${patch.path}`);
    await execution.writeFile(environmentId, patch.path, source.slice(0, first) + patch.replace + source.slice(first + patch.find.length));
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
    if (typeof patch.path !== "string" || typeof patch.find !== "string" || !patch.find || typeof patch.replace !== "string" || !safePath(patch.path) || !editableSourcePath(patch.path) || patch.path.startsWith("src/sites-ui/"))
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
  required: ["files"],
  properties: {
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
    if (path.startsWith("src/sites-ui/") || [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "src/main.tsx",
      "src/vite-env.d.ts",
    ].includes(path))
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
  return Object.freeze({ files: Object.freeze(normalized) });
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
