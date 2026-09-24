const STOPWORDS = new Set([
  "a", "an", "the", "for", "with", "and", "that", "this", "into", "make", "build", "create",
  "please", "can", "you", "add", "want", "need", "new", "website", "site", "page", "pages",
  "webpage", "web", "app", "landing", "modern", "responsive", "simple", "clean", "beautiful",
  "professional", "my", "our", "me", "us", "it", "called", "named", "about", "using", "some",
]);

const TITLE_EXCEPTIONS = new Set(["a", "an", "the", "of", "and", "for", "to", "in", "on"]);

const titleCase = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) =>
      index > 0 && TITLE_EXCEPTIONS.has(word.toLowerCase())
        ? word.toLowerCase()
        : /[A-Z]/.test(word.slice(1))
          ? word // Already styled, e.g. NorthSmile or NovaAI.
          : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");

const clean = (value: string): string =>
  value
    .replace(/[.,;:!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/**
 * Derives a human site name from the original prompt. Deterministic and local:
 * naming must never cost a provider call. Falls back to "Untitled Site" rather
 * than inventing something the prompt does not support.
 */
export function deriveSiteName(prompt: string, existingName?: string): string {
  const provided = existingName?.trim();
  if (provided && provided.toLowerCase() !== "generated site") return clean(provided);
  const text = prompt.trim();
  if (!text) return "Untitled Site";

  // "called Ember & Grain", "named NorthSmile Dental", "for NovaAI"
  const introduced =
    /\b(?:called|named)\s+["'“]?([A-Z][\w'’.-]*(?:\s+(?:&|and)\s+|\s+)?(?:[A-Z][\w'’.-]*)?(?:\s+[A-Z][\w'’.-]*)?)/.exec(
      text,
    );
  if (introduced?.[1]) return clean(introduced[1].replace(/\s+and\s+/i, " & "));

  // A quoted name anywhere in the prompt.
  const quoted = /["'“”]([^"'“”]{2,40})["'“”]/.exec(text);
  if (quoted?.[1] && /[A-Za-z]/.test(quoted[1])) return clean(titleCase(quoted[1]));

  // A capitalised brand-like run that is not the opening word of the sentence.
  const branded = /(?:^|[^.!?]\s)([A-Z][a-z0-9]*[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)?)/.exec(text);
  if (branded?.[1]) return clean(branded[1]);

  // Otherwise describe the subject from the prompt's own significant words.
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9'&]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .slice(0, 3);
  return words.length ? clean(titleCase(words.join(" "))) : "Untitled Site";
}
