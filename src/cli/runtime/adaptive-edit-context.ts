import { ApplicationError } from "../../app/errors/application-error.js";
import { estimateTokensConservative } from "../../agents/budget/token-estimator.js";
import { mapEditRepository, renderEditRepositoryMap, type EditMappedFile, type EditSourceRegion } from "./edit-repository-map.js";
import { BASELINE_STYLESHEET, designTokenExcerpt, isBroadFunctionalEdit, selectEditContextFiles, type EditContextFile } from "./edit-context-selection.js";
import { parseEditRequirements } from "./edit-requirements.js";

export const EDIT_CONTEXT_POLICY = Object.freeze({ fullFilePreferenceBytes: 128 * 1024, defaultInputTokens: 32_000,
  maximumInputTokens: 64_000, sourceFraction: .7, repositoryMapMaxBytes: 6_000, defaultContextBytes: 64_000 });

export interface AdaptiveEditContext {
  readonly repositoryMap: string;
  readonly files: readonly (EditContextFile & { readonly full: boolean; readonly ranges: readonly { start: number; end: number }[]; readonly ownerSignatures?: readonly string[] })[];
  readonly relevantPaths: readonly string[];
  readonly estimatedTokens: number;
  readonly parseHits: number;
  readonly parseMisses: number;
  readonly usesRegions: boolean;
  readonly styleIntent: boolean;
}
export function editContextFailure(reason: string, paths: readonly string[], limit: number): ApplicationError {
  return new ApplicationError("AGENT_RUN_BUDGET_EXCEEDED",
    `Required edit context could not be assembled safely (${reason}). Simplify the request or split the affected module; no AI request was sent.`,
    { metadata: { failureStage: "REQUEST_VALIDATION", validationCheck: "edit.context", reason, paths, ...(paths.length === 1 ? { path: paths[0] } : {}), maxContextBytes: limit } });
}
const words = (text: string) => [...new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
  .filter(word => !new Set(["the", "and", "for", "with", "this", "that", "all", "change", "update", "add", "make", "please", "website", "site", "preserve", "existing", "only"]).has(word))
  .map(word => word.endsWith("ies") ? word.slice(0, -3) + "y" : word.endsWith("s") ? word.slice(0, -1) : word);
function relevance(text: string, terms: readonly string[]): number {
  const normalized = words(text);
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}
function syntaxRegions(file: EditMappedFile): EditSourceRegion[] { return file.regions.filter(region => region.kind !== "ImportDeclaration"); }

export function selectAdaptiveEditContext(input: {
  readonly files: readonly EditContextFile[];
  readonly instruction: string;
  readonly existingPaths?: readonly string[];
  readonly maxBytes: number;
  readonly maxInputTokens?: number;
  readonly explicitMaxFileBytes?: number;
  readonly maxFiles?: number;
}): AdaptiveEditContext {
  const budget = Math.min(input.maxBytes, (input.maxInputTokens ?? EDIT_CONTEXT_POLICY.defaultInputTokens) * 3);
  const map = mapEditRepository(input.files, input.existingPaths);
  const byPath = new Map(map.files.map(file => [file.path, file]));
  const terms = words(input.instruction), requirements = parseEditRequirements(input.instruction);
  const broad = isBroadFunctionalEdit(input.instruction);
  const selection = selectEditContextFiles(input.instruction, input.files, { maxFiles: input.maxFiles ?? 8, includeAllEditable: broad });
  const nonBaseline = map.files.filter(file => file.path !== BASELINE_STYLESHEET);
  const small = nonBaseline.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) <= 24_000;
  let roots = (small ? nonBaseline : selection.selected.map(file => byPath.get(file.path)!)).filter(Boolean);
  if (selection.styleIntent) roots = [...new Set([...roots, ...map.files.filter(file => file.path.endsWith(".css"))])];
  if (requirements.rename) roots = [...new Set([...roots, ...map.files.filter(file => file.content.toLowerCase().includes(requirements.rename!.oldLiteral.toLowerCase()))])];
  const functional = requirements.scope?.functional || broad || /\b(?:calculat\w*|pric\w*|discount\w*|compar\w*|logic|state|routes?|navigation|components?)\b/i.test(input.instruction);
  if (functional && !roots.some(file => /\.[jt]sx?$/.test(file.path))) {
    const code = nonBaseline.filter(file => /\.[jt]sx?$/.test(file.path));
    if (!code.length) throw editContextFailure("APPLICATION_SOURCE_MISSING", [], budget);
    roots.push(...code.sort((a, b) => relevance(b.path + " " + b.content, terms) - relevance(a.path + " " + a.content, terms)).slice(0, 3));
  }
  // Imports and direct consumers are deterministic supporting context, not an
  // assumption that all generated projects share an App/pages/store layout.
  const needed = new Set(roots.map(file => file.path));
  if (functional) for (const file of nonBaseline) if (file.imports.some(item => item.target && needed.has(item.target))) needed.add(file.path);
  const queue = [...needed];
  // Data, state, types, hooks and styles are followed transitively. Sibling
  // view modules (e.g. every page a router imports) are followed only when the
  // request names them; the repository map still lists their exports.
  const unrelatedView = (target: string) => !small && !broad && /\.[jt]sx$/.test(target) &&
    relevance(`${target} ${byPath.get(target)!.exports.join(" ")}`, terms) === 0;
  for (let i = 0; i < queue.length; i++) {
    const file = byPath.get(queue[i]!)!;
    for (const item of file.imports) {
      if (item.specifier.startsWith(".") && !item.target) throw editContextFailure("LOCAL_IMPORT_SOURCE_MISSING", [file.path, item.specifier], budget);
      if (item.target?.endsWith(".css") && !selection.styleIntent && !requirements.rename) continue;
      if (item.target && byPath.has(item.target) && unrelatedView(item.target)) continue;
      if (item.target && byPath.has(item.target) && !needed.has(item.target)) { needed.add(item.target); queue.push(item.target); }
    }
  }
  const requiredFiles = map.files.filter(file => needed.has(file.path));
  const repositoryMap = renderEditRepositoryMap(map, Math.min(EDIT_CONTEXT_POLICY.repositoryMapMaxBytes, Math.max(500, Math.floor(budget * .12))), [...needed]);
  const available = budget - Buffer.byteLength(repositoryMap) - 1_200;
  if (available <= 0) throw editContextFailure("EDIT_CONTEXT_EXCEEDS_LIMIT", [...needed], budget);

  const complete = requiredFiles.map(file => ({ path: file.path, content: file.content, full: true,
    ranges: [{ start: 0, end: file.content.length }] }));
  // The 128-KiB preference is not an exclusion. Large files can still be sent
  // whole when an explicitly permitted context budget fits them.
  const allFit = complete.reduce((bytes, file) => bytes + Buffer.byteLength(file.content) + file.path.length + 20, 0) <= available;
  const explicitLimit = input.explicitMaxFileBytes;
  const compactStyles = new Set(requiredFiles.filter(file => file.path.endsWith(".css") && Buffer.byteLength(file.content) > 16_000 &&
    !requirements.rename && Boolean(designTokenExcerpt(file.content))).map(file => file.path));
  const preferRegions = new Set(requiredFiles.filter(file => Buffer.byteLength(file.content) > EDIT_CONTEXT_POLICY.fullFilePreferenceBytes).map(file => file.path));
  const fullAllowed = allFit && !compactStyles.size && !preferRegions.size && requiredFiles.every(file => explicitLimit === undefined || Buffer.byteLength(file.content) <= explicitLimit);
  let files: AdaptiveEditContext["files"] = complete;
  if (!fullAllowed) {
    const selected = new Map<string, Set<EditSourceRegion>>();
    const add = (file: EditMappedFile, region: EditSourceRegion) => {
      const set = selected.get(file.path) ?? new Set<EditSourceRegion>(); set.add(region); selected.set(file.path, set);
    };
    for (const file of requiredFiles) {
      if (!compactStyles.has(file.path) && !preferRegions.has(file.path) && Buffer.byteLength(file.content) <= (allFit ? available : available / requiredFiles.length) &&
        (explicitLimit === undefined || Buffer.byteLength(file.content) <= explicitLimit)) {
        add(file, { name: file.path, kind: "source", start: 0, end: file.content.length, declares: [], references: [] }); continue;
      }
      if (file.parseErrors) throw editContextFailure("SOURCE_STRUCTURE_UNCERTAIN", [file.path], budget);
      const candidates = syntaxRegions(file);
      if (file.path.endsWith(".css")) {
        const tokens = designTokenExcerpt(file.content);
        const matched = candidates.filter(region => relevance(region.name, terms) > 0 || requirements.rename && file.content.slice(region.start, region.end).includes(requirements.rename.oldLiteral));
        const chosen = matched.length ? matched : candidates.filter(region => /:root/.test(region.name));
        if (!chosen.length && selection.styleIntent && !tokens) throw editContextFailure("STYLE_SOURCE_UNCERTAIN", [file.path], budget);
        for (const region of chosen) add(file, region);
        continue;
      }
      if (!candidates.length) {
        if (Buffer.byteLength(file.content) > available) throw editContextFailure("REQUIRED_SOURCE_EXCEEDS_CONTEXT_LIMIT", [file.path], budget);
        add(file, { name: file.path, kind: "source", start: 0, end: file.content.length, declares: [], references: [] }); continue;
      }
      const scored = candidates.map(region => ({ region, score: relevance(region.name, terms) * 8 + relevance(file.content.slice(region.start, region.end), terms) }));
      const best = Math.max(...scored.map(item => item.score));
      let chosen = scored.filter(item => item.score > 0 && (item.score === best || item.region.kind === "VariableStatement" && !item.region.owner)).map(item => item.region);
      if (requirements.rename) chosen = candidates.filter(region => file.content.slice(region.start, region.end).toLowerCase().includes(requirements.rename!.oldLiteral.toLowerCase()));
      if (!chosen.length) chosen = candidates.filter(region => !region.owner);
      for (const region of chosen) {
        if (Buffer.byteLength(file.content.slice(region.start, region.end)) > available) {
          const nested = scored.filter(item => item.region.owner === region.name && item.score > 0 && item.region !== region &&
            Buffer.byteLength(file.content.slice(item.region.start, item.region.end)) <= available);
          if (!nested.length) throw editContextFailure("REQUIRED_SOURCE_EXCEEDS_CONTEXT_LIMIT", [file.path], budget);
          const max = Math.max(...nested.map(item => item.score));
          for (const item of nested.filter(item => item.score === max)) add(file, item.region);
        } else add(file, region);
      }
    }
    // Include complete imports, lexical definitions, types, state and handlers
    // used by a selected region. Never trim a required declaration to fit.
    for (const file of requiredFiles) {
      const set = selected.get(file.path);
      if (!set) continue;
      for (const region of [...set]) if (region.owner) {
        // The owner signature is map context; its entire body is not falsely
        // advertised as patchable. Referenced local declarations follow below.
        for (const binding of file.regions.filter(item => item.owner === region.owner && item.kind === "VariableStatement" && item.references.some(name => /^use[A-Z]/.test(name)))) add(file, binding);
        const signature = file.signatures[region.owner];
        if (signature) for (const definition of file.regions.filter(item => !item.owner && item.declares.some(name =>
          (signature.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []).some(value => value === name)) && item.name !== region.owner)) add(file, definition);
      }
      let grew = true;
      while (grew) {
        const before = set.size;
        for (const region of [...set]) for (const name of region.references) {
          const declaration = file.regions.find(candidate => candidate !== region && candidate.declares.includes(name) && candidate.owner === region.owner) ??
            file.regions.find(candidate => candidate !== region && candidate.declares.includes(name) && !candidate.owner);
          if (declaration && !(declaration.start <= region.start && declaration.end >= region.end)) add(file, declaration);
        }
        grew = set.size > before;
      }
      for (const region of file.regions.filter(item => item.kind === "ImportDeclaration")) add(file, region);
    }
    files = requiredFiles.flatMap(file => {
      const regions = [...(selected.get(file.path) ?? [])].sort((a, b) => a.start - b.start || b.end - a.end);
      const ranges = regions.filter((region, index) => !regions.slice(0, index).some(parent => parent.start <= region.start && parent.end >= region.end));
      if (!ranges.length) return [];
      return [{ path: file.path, content: ranges.map(region => file.content.slice(region.start, region.end)).join("\n\n"), full: ranges.length === 1 && ranges[0]!.start === 0 && ranges[0]!.end === file.content.length,
        ownerSignatures: [...new Set(regions.flatMap(region => region.owner && file.signatures[region.owner] ? [file.signatures[region.owner]!] : []))],
        ranges: ranges.map(({ start, end }) => ({ start, end })) }];
    });
  }
  const sourceBytes = files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content) + file.path.length + file.ranges.length * 100 + 100 +
    Buffer.byteLength(file.ownerSignatures?.join("\n") ?? ""), 0);
  if (files.some(file => explicitLimit !== undefined && Buffer.byteLength(file.content) > explicitLimit))
    throw editContextFailure("REQUIRED_SOURCE_EXCEEDS_FILE_LIMIT", files.filter(file => explicitLimit !== undefined && Buffer.byteLength(file.content) > explicitLimit).map(file => file.path), budget);
  if (sourceBytes > available)
    throw editContextFailure("REQUIRED_SOURCE_EXCEEDS_CONTEXT_LIMIT", files.map(file => file.path), budget);
  if (functional && !files.some(file => /\.[jt]sx?$/.test(file.path))) throw editContextFailure("APPLICATION_SOURCE_MISSING", [...needed], budget);
  return { repositoryMap, files, relevantPaths: [...needed], estimatedTokens: estimateTokensConservative(repositoryMap + files.map(file => file.content).join("\n")),
    parseHits: map.parseHits, parseMisses: map.parseMisses, usesRegions: files.some(file => !file.full), styleIntent: selection.styleIntent };
}
