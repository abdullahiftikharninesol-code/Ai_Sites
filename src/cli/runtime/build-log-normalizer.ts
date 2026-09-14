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
  /\b(?:ghp_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z\-_]{35})\b/g,
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

  // Bounded byte size from tail (where compiler errors usually live)
  if (Buffer.byteLength(result, "utf8") <= maxBytes) {
    return result;
  }

  // Slice from end if too long
  return `[...earlier logs omitted...]\n${result.slice(-maxBytes)}`;
}
