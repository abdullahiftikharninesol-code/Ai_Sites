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

/** The Sites-owned baseline stylesheet: large, and only worth sending for style work. */
export const BASELINE_STYLESHEET = "src/styles.css";

/** Whole-app behavior requests cannot fit safely into a few exact-text patches. */
export function isBroadFunctionalEdit(instruction: string): boolean {
  return /\b(functional(?:ity)?|working|interactive|clickable|work)\b/i.test(instruction) &&
    /\b(all|whole|entire|every|pages?|screens?|buttons?|links?|navigation|features?|site|website|dashboard|app)\b/i.test(instruction);
}

/** "Preserve the styling" is not permission to rewrite a stylesheet. */
export function broadFunctionalEditChangesStyle(instruction: string): boolean {
  return /\b(redesign|restyle|retheme|change (?:the )?(?:style|styling|theme|colors?|colours?|palette)|update (?:the )?(?:style|styling|theme|colors?|colours?|palette))\b/i.test(instruction);
}

const STYLE_INTENT =
  /\b(colou?rs?|theme|dark|light|palette|font|fonts|typograph\w*|spacing|style|styles|styling|css|background|accent|uppercase|lowercase|capitali[sz]\w*|bold|italic|round\w*|shadow|border|margin|padding|size|sizes|larger|smaller|contrast)\b/i;

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
    if (file && !keep.has(file.path)) keep.set(file.path, file);
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

  const selected = files.filter((file) => keep.has(file.path));
  return {
    selected,
    excluded: files.filter((file) => !keep.has(file.path)).map((file) => file.path),
    reason,
    styleIntent,
  };
}
