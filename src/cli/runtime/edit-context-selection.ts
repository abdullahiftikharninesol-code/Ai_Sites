import {
  containsRenameLiteral,
  isEditableRequirementPath,
  parseEditRequirements,
  suppliedEditRequirementContext,
  type EditRequirementContext,
  type EditRequirementName,
  type EditRequirements,
} from "./edit-requirements.js";

export interface EditContextFile {
  readonly path: string;
  readonly content: string;
}

export interface EditContextSelection {
  readonly selected: readonly EditContextFile[];
  readonly excluded: readonly string[];
  /** Why these files: useful in the context accounting log. */
  readonly reason: "matched" | "style" | "fallback";
  readonly styleIntent: boolean;
}

export interface EditRepairContextSelection {
  readonly files: readonly EditContextFile[];
  readonly text: string;
  readonly requirementContext: EditRequirementContext;
}

/** The Sites-owned baseline stylesheet: large, and only worth sending for style work. */
export const BASELINE_STYLESHEET = "src/styles.css";

/** Whole-app behavior requests cannot fit safely into a few exact-text patches. */
export function isBroadFunctionalEdit(instruction: string): boolean {
  // Preservation is a constraint, not permission to rewrite the application.
  // Keep functional intent and its scope in the same clause; otherwise a hero
  // edit plus "preserve all functionality" incorrectly selects a file bundle.
  const clauses = instruction.split(/[.;\n]+|\b(?:and|but|while)\s+(?=(?:please\s+)?(?:keep|preserve|retain|maintain|leave|make|implement|enable|fix|add|ensure|do not|don't)\b)/i);
  return clauses.some((clause) => {
    const requested = clause.replace(/\b(?:keep|preserve|retain|maintain|leave|without (?:changing|altering|breaking))\b.*$/i, "");
    return !/\b(?:do not|don't|must not|should not|never)\b/i.test(requested) &&
      /\b(functional(?:ity)?|working|interactive|clickable|work)\b/i.test(requested) &&
      /\b(all|whole|entire|every|pages?|screens?|buttons?|links?|navigation|features?|site|website|dashboard|app)\b/i.test(requested);
  });
}

/** "Preserve the styling" is not permission to rewrite a stylesheet. */
export function broadFunctionalEditChangesStyle(instruction: string): boolean {
  return parseEditRequirements(instruction).style || /\b(redesign|restyle|retheme|change (?:the )?(?:style|styling|theme|colors?|colours?|palette)|update (?:the )?(?:style|styling|theme|colors?|colours?|palette))\b/i.test(instruction);
}

const STYLE_INTENT =
  /\b(colou?rs?|theme|dark|light|palette|visual|visuals|font|fonts|typograph\w*|spacing|style|styles|styling|css|background|accent|uppercase|lowercase|capitali[sz]\w*|bold|italic|round\w*|shadow|border|margin|padding|size|sizes|larger|smaller|contrast)\b/i;

/**
 * The verbatim `:root` rule blocks of a stylesheet too large to send whole: they
 * hold the design tokens a colour or theme edit must change, and every byte is
 * copied from the file so a patch written against them still matches exactly.
 */
export function designTokenExcerpt(css: string, maxChars = 4_000): string | undefined {
  const blocks = [...css.matchAll(/:root\s*\{[^{}]*\}/g)].map((match) => match[0]);
  const excerpt = blocks.reduce(
    (text, block) => (text.length + block.length + 2 <= maxChars ? (text ? `${text}\n\n${block}` : block) : text),
    "",
  );
  return excerpt || undefined;
}

export function patchableStyleExcerpt(file: EditContextFile): string {
  return `--- ${file.path}\nEXACT PATCHABLE EXCERPT (verbatim source below; patch this real file; labels/line numbers are not source; no full-file rewrite):\n${file.content}`;
}

/**
 * Selects only the candidate source needed to repair deterministic requirement
 * failures. This deliberately bypasses normal relevance ranking: style gets
 * current style tokens/source, while rename gets only files that still contain
 * the old literal (case-insensitively).
 */
export function selectEditRepairContext(
  requirements: EditRequirements,
  missingRequirements: readonly EditRequirementName[],
  candidate: ReadonlyMap<string, string>,
  initialContext: EditRequirementContext,
  options: { readonly maxFileBytes?: number } = {},
): EditRepairContextSelection {
  const maxFileBytes = options.maxFileBytes ?? 16_000;
  const selected = new Map<string, EditContextFile>();
  const add = (path: string, content: string) => {
    if (isEditableRequirementPath(path) && !selected.has(path)) selected.set(path, { path, content });
  };

  if (missingRequirements.includes("rename") && requirements.rename) {
    for (const [path, content] of candidate)
      if (isEditableRequirementPath(path) && containsRenameLiteral(content, requirements.rename.oldLiteral))
        add(path, content);
  }

  if (missingRequirements.includes("style")) {
    const supplied = initialContext.stylePaths.filter((path) => candidate.has(path));
    const fallback = [...candidate.keys()].filter((path) => path.endsWith(".css"));
    const paths = supplied.some((path) => path.endsWith(".css"))
      ? supplied.filter((path) => path.endsWith(".css"))
      : supplied.length ? supplied : fallback;
    for (const path of paths.slice(0, 3)) {
      const content = candidate.get(path)!;
      const excerpt = Buffer.byteLength(content) > maxFileBytes && path.endsWith(".css")
        ? designTokenExcerpt(content)
        : undefined;
      add(path, excerpt ?? content);
    }
  }

  const files = Object.freeze([...selected.values()].sort((left, right) => left.path.localeCompare(right.path)));
  const missing = new Set(missingRequirements);
  const repairRequirements: EditRequirements = {
    ...(missing.has("rename") && requirements.rename ? { rename: requirements.rename } : {}),
    style: missing.has("style"),
  };
  const requirementContext = suppliedEditRequirementContext(repairRequirements, files);
  const text = files.map((file) =>
    missing.has("style") && requirementContext.stylePaths.includes(file.path)
      ? patchableStyleExcerpt(file)
      : `--- ${file.path}\n${file.content}`,
  ).join("\n\n");
  return { files, text, requirementContext };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "make", "change", "update",
  "please", "can", "you", "add", "set", "use", "all", "our", "its", "it's", "was", "are",
  "should", "would", "want", "need", "new", "old", "text", "page", "site", "website", "instead",
  "more", "less", "but", "not", "put", "give", "look", "feel", "some", "any", "every", "each",
]);

/** Quoted phrases carry intent directly ("Ember & Grain" -> "Abdullah's Cafe"). */
function phrasesFrom(instruction: string): string[] {
  return [...instruction.matchAll(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/g)]
    .map(([, phrase]) => phrase!.trim())
    .filter(Boolean);
}

function termsFrom(instruction: string): string[] {
  return [
    ...new Set(
      instruction
        .toLowerCase()
        .split(/[^a-z0-9'&]+/)
        .map((word) => word.replace(/^'+|'+$/g, ""))
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  ];
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Picks the editable files a targeted edit plausibly needs, by inspecting the
 * instruction against the actual source. Deterministic on purpose: no model call
 * decides what the model gets to see. When nothing scores, the whole editable
 * application set is sent rather than risking an edit that cannot be performed.
 */
export function selectEditContextFiles(
  instruction: string,
  files: readonly EditContextFile[],
  options: { readonly entryPath?: string; readonly maxFiles?: number; readonly includeAllEditable?: boolean } = {},
): EditContextSelection {
  const entryPath = options.entryPath ?? "src/App.tsx";
  const maxFiles = options.maxFiles ?? 8;
  const styleIntent = STYLE_INTENT.test(instruction) &&
    (!options.includeAllEditable || broadFunctionalEditChangesStyle(instruction));
  const phrases = phrasesFrom(instruction);
  const terms = termsFrom(instruction);

  // The Sites baseline stylesheet names nearly every UI concept (.button, .hero,
  // .card), so term matching always drags it in — at several thousand tokens.
  // It earns its place only on explicit style intent; otherwise the compact
  // design-system summary tells the model what the tokens are.
  const candidates = files.filter((file) => file.path !== BASELINE_STYLESHEET);

  const scored = candidates.map((file) => {
    const haystack = file.content.toLowerCase();
    let score = 0;
    for (const phrase of phrases) score += occurrences(haystack, phrase.toLowerCase()) * 10;
    for (const term of terms) {
      score += Math.min(occurrences(haystack, term), 4);
      if (file.path.toLowerCase().includes(term)) score += 3;
    }
    return { file, score };
  });

  const matched = scored.filter((entry) => entry.score > 0);
  const isStylesheet = (path: string) => path.endsWith(".css");
  const keep = new Map<string, EditContextFile>();
  const add = (file?: EditContextFile) => {
    if (file && isEditableRequirementPath(file.path) && !keep.has(file.path)) keep.set(file.path, file);
  };

  const reason: EditContextSelection["reason"] =
    matched.length > 0 ? "matched" : styleIntent ? "style" : "fallback";

  if (options.includeAllEditable) {
    for (const file of candidates) add(file);
  } else if (matched.length > 0) {
    for (const entry of [...matched].sort((a, b) => b.score - a.score).slice(0, maxFiles))
      add(entry.file);
  } else if (!styleIntent) {
    // Nothing matched and no style signal: send the editable set rather than guess.
    for (const file of candidates) add(file);
  }

  // The entry component orients any edit and is cheap.
  add(files.find((file) => file.path === entryPath));

  // Style work needs the stylesheets, including the Sites baseline that holds the tokens.
  if (styleIntent) for (const file of files) if (isStylesheet(file.path)) add(file);

  // Explicit literal rename coverage (including casing variants) may exceed the ranked-file limit.
  const rename = parseEditRequirements(instruction).rename;
  if (rename) for (const file of files)
    if (isEditableRequirementPath(file.path) && containsRenameLiteral(file.content, rename.oldLiteral)) add(file);

  const selected = files.filter((file) => keep.has(file.path));
  return {
    selected,
    excluded: files.filter((file) => !keep.has(file.path)).map((file) => file.path),
    reason,
    styleIntent,
  };
}
