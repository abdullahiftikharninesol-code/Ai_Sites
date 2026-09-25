const STOPWORDS = new Set([
  "a", "an", "the", "for", "with", "and", "that", "this", "into", "make", "build", "create",
  "please", "can", "you", "add", "want", "need", "new", "website", "site", "page", "pages",
  "webpage", "web", "app", "landing", "modern", "responsive", "simple", "clean", "beautiful",
  "professional", "my", "our", "me", "us", "it", "called", "named", "about", "using", "some",
  "attached", "attach", "image", "reference", "generate",
]);

const TITLE_EXCEPTIONS = new Set(["a", "an", "the", "of", "and", "for", "to", "in", "on"]);
const GENERIC_NAMES = new Set([
  "attached reference", "have attached image", "attached image", "generate website",
  "create website", "use this image", "reference image", "generated site",
  "generated website", "website", "site",
]);

const titleCase = (value: string): string =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((word, index) =>
      index > 0 && TITLE_EXCEPTIONS.has(word.toLocaleLowerCase())
        ? word.toLocaleLowerCase()
        : /\p{Lu}/u.test(word.slice(1))
          ? word
          : word.charAt(0).toLocaleUpperCase() + word.slice(1),
    )
    .join(" ");

const genericKey = (value: string): string =>
  value.toLocaleLowerCase().replace(/[“”"'’`.,;:!?_-]+/gu, " ").replace(/\s+/gu, " ").trim();

/** Returns a safe one-line display name, or undefined when the candidate is not a site identity. */
export function validateSiteNameCandidate(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\r\n\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const candidate = value.trim().replace(/[ \t]+/gu, " ").replace(/[.,;:!?]+$/gu, "");
  if (candidate.length < 1 || candidate.length > 60 || GENERIC_NAMES.has(genericKey(candidate)))
    return undefined;
  if (
    /[\\/]/u.test(candidate) || /^[A-Za-z]:/u.test(candidate) ||
    /^(?:https?:|file:|data:)/iu.test(candidate) || /<[^>]*>|[{}]/u.test(candidate) ||
    /\.(?:tsx?|jsx?|css|html?|json|png|jpe?g|gif|webp|svg)$/iu.test(candidate)
  ) return undefined;
  return candidate;
}

/** Extracts a name the user explicitly supplied, without inventing one. */
export function extractExplicitSiteName(prompt: string): string | undefined {
  const text = prompt.trim();
  if (!text) return undefined;
  const patterns = [
    /\b(?:called|named)\s+["'“”]?([^"'“”\n,.!?]{1,60}?)["'“”]?(?=\s*(?:[,.!?]|\b(?:with|using|for|that|which)\b|$))/iu,
    /\bfor\s+["'“]([^"'”\n]{1,60})["'”]/iu,
    /["'“]([^"'”\n]{1,60})["'”]/u,
    /\bfor\s+([\p{L}\p{N}][\p{L}\p{N}'’&.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’&.-]*){0,3})(?=\s*(?:,|\b(?:an?|the|with|using|that|which)\b|$))/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = validateSiteNameCandidate(match?.[1]?.replace(/\s+and\s+/iu, " & "));
    if (candidate) return titleCase(candidate);
  }
  return undefined;
}

/** Creates a deterministic local fallback and never promotes attachment instructions into names. */
export function deriveSiteName(prompt: string, existingName?: string): string {
  const provided = validateSiteNameCandidate(existingName);
  if (provided) return provided;
  const explicit = extractExplicitSiteName(prompt);
  if (explicit) return explicit;
  const words = prompt
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}'’&]+/u)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .slice(0, 3);
  return validateSiteNameCandidate(titleCase(words.join(" "))) ?? "Untitled site";
}

export interface SiteNameResolutionInput {
  readonly prompt: string;
  readonly requestedProjectName?: string | undefined;
  readonly structuredSiteName?: string | undefined;
  readonly documentTitle?: string | undefined;
}

/** Canonical naming order for a successfully generated initial version. */
export function resolveGeneratedSiteName(input: SiteNameResolutionInput): string {
  return validateSiteNameCandidate(input.requestedProjectName) ??
    extractExplicitSiteName(input.prompt) ??
    validateSiteNameCandidate(input.structuredSiteName) ??
    validateSiteNameCandidate(input.documentTitle) ??
    deriveSiteName(input.prompt);
}
