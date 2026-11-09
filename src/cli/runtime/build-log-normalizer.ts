/**
 * Deterministic build-log normalization for agent repair contexts.
 * Strips ANSI codes, deduplicates repeated lines, removes noisy npm/Vite boilerplate,
 * safely redacts actual secret values (never harmless path names like src/auth-token.ts),
 * and isolates compiler diagnostics.
 */

// Comprehensive ANSI escape code regex
const ANSI_REGEX =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

// Safe secret patterns that target actual values without corrupting file names
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // Assignment values: KEY=value or "TOKEN": "value"
  /(?<=(\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)\b\s*[:=]\s*["']?))[a-zA-Z0-9_\-.~+/=]{8,}(?=["']?)/gi,
  // Bearer tokens: Bearer abc...
  /(?<=\bBearer\s+)[a-zA-Z0-9_\-.~+/=]{10,}/gi,
  // Common provider key prefixes
  /\b(?:ghp_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z\-_]{35}|npm_[A-Za-z0-9]{36})\b/g,
  // npm registry credentials in .npmrc-style output: //registry/:_authToken=value
  /(?<=_auth(?:Token)?\s*=\s*)[^\s"']+/gi,
  // Credentials embedded in URLs: https://user:password@host
  /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/gi,
];

// Noise lines from npm, Vite, and Rollup that contain no compiler diagnostic information
const NOISE_LINE_PREFIXES: readonly string[] = [
  "> vite build",
  "vite v",
  "npm ERR! A complete log of this run can be found in:",
  "npm ERR! code 1",
  "npm ERR! code ELIFECYCLE",
  "npm ERR! errno 1",
  "npm notice",
  "rendering chunks...",
  "computing gzip size...",
  "transforming...",
];

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Safely redacts credentials without corrupting file paths like `src/auth-token.ts`.
 */
export function safeRedactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export interface NormalizeBuildLogOptions {
  readonly maxBytes?: number | undefined;
}

/**
 * Normalizes build stderr and stdout into a clean, actionable compiler diagnostic summary.
 */
export function normalizeBuildLog(
  stderr: string,
  stdout = "",
  options?: NormalizeBuildLogOptions,
): string {
  const maxBytes = options?.maxBytes ?? 4_000;
  const rawCombined = `${stderr}\n${stdout}`;

  // 1. Strip ANSI
  const cleanAnsi = stripAnsi(rawCombined);

  // 2. Redact sensitive values safely
  const redacted = safeRedactSecrets(cleanAnsi);

  // 3. Filter lines and deduplicate
  const rawLines = redacted.split(/\r?\n/);
  const filteredLines: string[] = [];
  const seenLines = new Set<string>();

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Filter out standard noise prefixes
    if (NOISE_LINE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      continue;
    }

    // Filter module count success indicators
    if (/^\u2713\s+\d+\s+modules\s+transformed/i.test(trimmed)) {
      continue;
    }

    // Deduplicate repeated identical diagnostic lines (e.g. repeated warnings)
    if (seenLines.has(trimmed)) {
      continue;
    }
    seenLines.add(trimmed);

    filteredLines.push(rawLine);
  }

  const result = filteredLines.join("\n").trim();

  if (Buffer.byteLength(result, "utf8") <= maxBytes) {
    return result;
  }

  // The first compiler diagnostics are usually the root cause; later ones are
  // often cascades. Keep the leading located diagnostics (bounded to half the
  // budget), then fill the remainder with whole lines from the tail.
  const primary: string[] = [];
  let primaryBytes = 0;
  for (const line of filteredLines) {
    if (primary.length >= 6 || !PRIMARY_DIAGNOSTIC.test(line)) continue;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (primaryBytes + bytes > maxBytes / 2) break;
    primary.push(line); primaryBytes += bytes;
  }
  const header = primary.length ? `[primary compiler diagnostics]\n${primary.join("\n")}\n` : "";
  const tail: string[] = [];
  let used = Buffer.byteLength(header, "utf8") + 32;
  for (let index = filteredLines.length - 1; index >= 0; index--) {
    const line = filteredLines[index]!;
    if (primary.includes(line)) continue;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (used + bytes > maxBytes) { if (!tail.length) tail.unshift(line.slice(-(maxBytes - used))); break; }
    tail.unshift(line); used += bytes;
  }
  return `${header}[...earlier logs omitted...]\n${tail.join("\n")}`;
}

export interface InstallFailureSummary {
  /** npm error code such as ERESOLVE, E404, EINTEGRITY or ENOTFOUND, when reported. */
  readonly npmErrorCode?: string;
  /** Redacted, bounded npm error lines (or the log tail when npm printed none). */
  readonly output: string;
}

/** Concise, redacted `npm ci` failure evidence. npm prints the cause first
 * (`npm error code …`, conflict/404 detail) and boilerplate last, so error
 * lines are kept from the head; the raw tail is only a fallback. */
export function summarizeInstallFailure(stderr: string, stdout = "", maxBytes = 1_500): InstallFailureSummary {
  const lines = normalizeBuildLog(stderr, stdout, { maxBytes: 64_000 }).split("\n")
    .filter(line => !/A complete log of this run|verbose|^\s*npm (?:ERR!|error)\s*$/i.test(line));
  const errors = lines.filter(line => /^\s*npm (?:ERR!|error)\b/i.test(line));
  const code = errors.map(line => /^\s*npm (?:ERR!|error) code (\S+)/i.exec(line)?.[1]).find(Boolean);
  const selected: string[] = [];
  let used = 0;
  const source = errors.length ? errors : lines.slice(-20);
  for (const line of source) {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (used + bytes > maxBytes) break;
    selected.push(line); used += bytes;
  }
  if (!selected.length && source.length) selected.push(source[0]!.slice(0, maxBytes));
  return { ...(code ? { npmErrorCode: code } : {}), output: selected.join("\n") };
}

/** Located TypeScript / esbuild / Vite diagnostics: `file(line,col): error TS…` or `file:line:col: ERROR`. */
const PRIMARY_DIAGNOSTIC = /\.(?:[cm]?[jt]sx?|css|json)(?:\(\d+,\d+\)|:\d+:\d+)\s*:?\s*(?:error|ERROR)\b|\berror TS\d+:/;
