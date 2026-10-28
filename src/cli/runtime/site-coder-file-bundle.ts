import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { GenerationCompletionManifest, GenerationCompletionRequirements } from "../../agents/validation/generation-completion.js";
import { GenerationCompletionValidator } from "../../agents/validation/generation-completion.js";
import { validateSiteNameCandidate } from "../../sites/generation/site-name.js";
import { editTextDigest, exactMatchOffsets, explicitlyAuthorizedGlobalRename, patchIntendedOperation, patchLocations, uniqueContextualOffset,
  type SiteEditPatchContext, type SiteEditPatchDiagnostic } from "./site-edit-patch-resolver.js";
import { parseEditRequirements, validateEditRequirements } from "./edit-requirements.js";
import { explicitlyAuthorizedProtectedPatch, independentScopedPatches, protectedEditValues, scopeError, validateEditScopeCompletion, validateProtectedEditValues } from "./edit-scope.js";
import { applyValidatedBuildRepairPatches, type BuildRepairPatchDiagnostic } from "./build-repair-patch-resolver.js";
import type { BuildRepairSourceSnapshot } from "./build-repair-source.js";

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
  function invalid(path: string, detail: string, managed = false): never {
    throw new ApplicationError(managed ? "MANAGED_FILE_MODIFICATION" : "VALIDATION_FAILED",
      `SiteEditPatchBundle ${path}: ${detail}`, { metadata: { validationPath: path, validationCategory: managed ? "DISALLOWED_PATH" : "SCHEMA_MISMATCH" } });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("$", "expected an object");
  if (!Array.isArray((value as { patches?: unknown }).patches)) invalid("$.patches", "required array is missing or invalid");
  if (Object.keys(value).some(key => key !== "patches")) invalid("$", "unexpected fields; expected only patches");
  const patches = (value as { patches: readonly unknown[] }).patches;
  if (patches.length === 0 || patches.length > 8)
    invalid("$.patches", "expected between 1 and 8 patches");
  // Several patches may target one file: "change the headline and the CTA" is a
  // single ordinary edit, and each patch is applied against freshly read content.
  return Object.freeze({ patches: Object.freeze(patches.map((item, index) => {
    const at = `$.patches[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid(at, "expected an object");
    if (Object.keys(item).some(key => !["path", "find", "replace", "mode"].includes(key))) invalid(at, "unexpected patch fields");
    const patch = item as { path?: unknown; find?: unknown; replace?: unknown; mode?: unknown };
    if (typeof patch.path !== "string") invalid(`${at}.path`, "required string is missing or invalid");
    if (typeof patch.find !== "string" || !patch.find) invalid(`${at}.find`, "required non-empty string is missing or invalid");
    if (typeof patch.replace !== "string") invalid(`${at}.replace`, "required string is missing or invalid");
    if (!isEditableSiteEditPath(patch.path)) invalid(`${at}.path`, "disallowed path", true);
    if (patch.mode !== undefined && patch.mode !== "unique" && patch.mode !== "all")
      invalid(`${at}.mode`, 'mode must be "unique" or "all"');
    // Providers without strict schema support may omit the mode; unique is the safe default.
    const mode: SiteEditPatchMode = patch.mode === "all" ? "all" : "unique";
    return Object.freeze({ path: patch.path, find: patch.find, replace: patch.replace, mode });
  })) });
}

export async function applySiteEditPatchBundle(
  execution: Pick<ExecutionProvider, "readFile" | "writeFile">,
  environmentId: string,
  bundle: SiteEditPatchBundle,
  context?: SiteEditPatchContext & {
    readonly requirementSource?: ReadonlyMap<string, string> | undefined;
    readonly onScopeExclusion?: (count: number) => void;
  },
): Promise<readonly string[]> {
  const changed: string[] = [];
  const requirements = context ? parseEditRequirements(context.instruction) : undefined;
  const scope = requirements?.scope;
  const original = new Map<string, string>();
  for (const path of new Set([...bundle.patches.map(patch => patch.path), ...(context?.requirementSource?.keys() ?? [])]))
    original.set(path, await execution.readFile(environmentId, path));
  const scoped = scope ? independentScopedPatches(bundle.patches, original, scope) : { patches: bundle.patches, excluded: [] };
  // Every find is written against the source the model was shown, but patches
  // apply in order. A later find overlapping text an earlier patch to the same
  // file already rewrote (a brand rename inside the hero being rewritten) is
  // rebased by applying those earlier patches to the find text itself, then
  // matched exactly again under the same uniqueness rules.
  const shown = new Map<string, string>();
  const staged = new Map<string, string>();
  const inserted = new Map<string, { start: number; end: number }[]>();
  const diagnostics: SiteEditPatchDiagnostic[] = [];
  const applied: SiteEditPatch[] = [];
  for (const patch of scoped.patches) {
    const source = staged.get(patch.path) ?? original.get(patch.path)!;
    if (!shown.has(patch.path)) shown.set(patch.path, source);
    let find = patch.find;
    let offsets = exactMatchOffsets(source, find);
    let matches = offsets.length;
    let rebased = false;
    const shownMatches = countOccurrences(shown.get(patch.path)!, patch.find);
    if (matches === 0 && (patch.mode === "all" ? shownMatches > 0 : shownMatches === 1)) {
      find = applied
        .filter((earlier) => earlier.path === patch.path)
        .reduce((text, earlier) => rewriteFindText(text, earlier), patch.find);
      matches = find === patch.find ? 0 : countOccurrences(source, find);
      offsets = exactMatchOffsets(source, find);
      rebased = find !== patch.find;
    }
    const diagnostic = (resolution: string, reason: string, operation = patchIntendedOperation(patch, context)): SiteEditPatchDiagnostic => ({
      path: patch.path, findDigest: editTextDigest(patch.find), replacementDigest: editTextDigest(patch.replace),
      matchCount: matches, locations: patchLocations(source, offsets), requestedMode: patch.mode,
      resolution, intendedOperation: operation, rebased, reason,
    });
    const reject = (reason: string, resolution: string, message: string): never => {
      const detail = diagnostic(resolution, reason);
      throw new ApplicationError(
        "VALIDATION_FAILED", message,
        { metadata: { path: patch.path, mode: patch.mode, matches, matchesInShownSource: shownMatches,
          failureStage: "PATCH_APPLICATION", validationCheck: "edit.patch-resolution",
          findDigest: detail.findDigest, patchDiagnostics: [...diagnostics, detail],
          diagnostics: `Patch resolution rejected: ${reason}; find digest ${detail.findDigest}` } },
      );
    };
    if (matches === 0) reject("EXACT_SOURCE_NOT_FOUND", "REJECTED_MISSING_ANCHOR",
      `Edit find text was not found in ${patch.path}. It must match the file byte-for-byte.`);
    // A prior replacement must not silently manufacture new targets for a later
    // patch written against the original source (including mode all).
    if (!rebased && shownMatches > 0 && offsets.some(offset => (inserted.get(patch.path) ?? [])
      .some(range => range.start === range.end ? range.start > offset && range.start < offset + find.length
        : range.start < offset + find.length && range.end > offset)))
      reject("EARLIER_PATCH_INTRODUCED_MATCH", "REJECTED_CASCADE",
        `Edit find text matched ${matches} times in ${patch.path}, including text introduced by an earlier patch; an independent unique source anchor is required.`);
    let targets = offsets;
    let resolution = rebased ? "REBASED_UNIQUE" : patch.mode === "all" ? "REQUESTED_ALL" : "EXACT_UNIQUE";
    let operation = "EXACT_PATCH";
    if (patch.mode === "unique" && matches > 1) {
      if (explicitlyAuthorizedGlobalRename(patch, context)) {
        resolution = "SCOPED_GLOBAL_RENAME"; operation = "GLOBAL_RENAME";
      } else {
        const scoped = uniqueContextualOffset(source, offsets, { ...patch, find }, context);
        if (!scoped) reject("NO_UNIQUE_AUTHORIZED_CONTEXT", "REJECTED_AMBIGUITY",
          `Edit find text matched ${matches} times in ${patch.path}; a unique patch needs more surrounding source context as an anchor, or mode "all" when every occurrence is meant. No unique authorized component/section or explicit global rename could be verified.`);
        targets = [scoped!.offset]; operation = scoped!.operation; resolution = "SCOPED_CONTEXT";
      }
    } else if (patch.mode === "unique") targets = [offsets[0]!];
    // A proved global display-brand rename never includes a protected destination,
    // even if its brand substring happens to match the same exact find.
    if (scope && explicitlyAuthorizedGlobalRename(patch, context) && !explicitlyAuthorizedProtectedPatch(patch, scope)) {
      const protectedValues = protectedEditValues(source);
      targets = targets.filter(start => !protectedValues.some(value => value.start < start + find.length && value.end > start));
      if (!targets.length) throw scopeError(patch.path, "NO_AUTHORIZED_DISPLAY_RENAME_TARGET", patch);
    }
    let next = source;
    let ranges = inserted.get(patch.path) ?? [];
    // Reverse offsets keep every target anchored in the same pre-patch source.
    for (const start of [...targets].reverse()) {
      const end = start + find.length, delta = patch.replace.length - find.length;
      next = next.slice(0, start) + patch.replace + next.slice(end);
      ranges = ranges.flatMap(range => range.end <= start ? [range] : range.start >= end
        ? [{ start: range.start + delta, end: range.end + delta }]
        : [...(range.start < start ? [{ start: range.start, end: start }] : []),
          ...(range.end > end ? [{ start: end + delta, end: range.end + delta }] : [])]);
      if (patch.replace !== find) ranges.push({ start, end: start + patch.replace.length });
    }
    inserted.set(patch.path, ranges);
    staged.set(patch.path, next);
    diagnostics.push(diagnostic(resolution, "VERIFIED_EXACT_SCOPE", operation));
    changed.push(patch.path);
    applied.push(targets.length > 1 ? { ...patch, mode: "all" } : patch);
  }
  // Preflight the whole bundle before any write: an unsafe later patch must not
  // leave even the isolated candidate half-edited. Persistence remains unchanged.
  if (scope) {
    const candidate = new Map([...original, ...staged]);
    validateProtectedEditValues(scope, original, candidate);
    if (scoped.excluded.length) {
      validateEditRequirements(requirements, context?.requirementSource ?? original, candidate);
      validateEditScopeCompletion(scope, context?.requirementSource ?? original, candidate);
    }
  }
  for (const [path, content] of staged) await execution.writeFile(environmentId, path, content);
  if (scoped.excluded.length) context?.onScopeExclusion?.(scoped.excluded.length);
  return Object.freeze(changed);
}

/** Applies one earlier patch to a later find text with the same exact-match semantics. */
function rewriteFindText(text: string, earlier: SiteEditPatch): string {
  if (earlier.mode === "all") return text.split(earlier.find).join(earlier.replace);
  return countOccurrences(text, earlier.find) === 1 ? text.replace(earlier.find, () => earlier.replace) : text;
}

export const BUILD_REPAIR_PATCH_BUNDLE_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object", additionalProperties: false, required: ["patches"],
  properties: { patches: { type: "array", maxItems: 8, items: {
    type: "object", additionalProperties: false, required: ["path", "find", "replace"],
    properties: { path: { type: "string" }, find: { type: "string", minLength: 1 }, replace: { type: "string" } },
  } } },
});

export function validateBuildRepairPatchBundle(value: unknown): BuildRepairPatchBundle {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "patches") || !Array.isArray((value as { patches?: unknown }).patches))
    throw new ApplicationError("VALIDATION_FAILED", "BuildRepairPatchBundle must contain a patches array");
  const patches = (value as { patches: readonly unknown[] }).patches;
  if (patches.length > 8) throw new ApplicationError("VALIDATION_FAILED", "Too many build repair patches");
  return Object.freeze({ patches: Object.freeze(patches.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["path", "find", "replace"].includes(key))) throw new ApplicationError("VALIDATION_FAILED", "Invalid build repair patch");
    const patch = item as { path?: unknown; find?: unknown; replace?: unknown };
    // Accept relative Windows separators and a leading ./, never guess extensions,
    // case-fold paths, or resolve traversal/absolute/managed destinations.
    const path = typeof patch.path === "string" ? patch.path.replaceAll("\\", "/").replace(/^\.\//, "") : "";
    if (typeof patch.find !== "string" || !patch.find || typeof patch.replace !== "string" || !safePath(path) || path.split("/").some(part => !part || part === ".") || !editableSourcePath(path) || isManagedSitePath(path))
      throw new ApplicationError("MANAGED_FILE_MODIFICATION", `Build repair patch contains a disallowed path: ${String(patch.path)}`);
    return Object.freeze({ path, find: patch.find, replace: patch.replace });
  })) });
}

export async function applyBuildRepairPatchBundle(
  execution: Pick<ExecutionProvider, "readFile" | "writeFile">,
  environmentId: string,
  bundle: BuildRepairPatchBundle,
  snapshot?: BuildRepairSourceSnapshot,
  onDiagnostics?: (diagnostics: readonly BuildRepairPatchDiagnostic[]) => void,
): Promise<void> {
  await applyValidatedBuildRepairPatches(execution, environmentId, validateBuildRepairPatchBundle(bundle), snapshot, onDiagnostics);
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

/** Only targeted patches may edit root HTML; generation/repair keep their managed boundary. */
export function isEditableSiteEditPath(path: string): boolean {
  return path === "index.html" ||
    (safePath(path) && editableSourcePath(path) && !isManagedSitePath(path));
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
