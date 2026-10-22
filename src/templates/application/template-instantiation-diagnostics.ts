import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TemplateInstantiationStage =
  | "AUTH" | "TEMPLATE_RESOLUTION" | "GCS_DOWNLOAD" | "SHA_VALIDATION"
  | "EXTRACTION" | "SOURCE_VALIDATION" | "BUILD" | "BROWSER_QA"
  | "PERSISTENCE" | "PREVIEW_INITIALIZATION";

interface DiagnosticContext {
  readonly requestId: string;
  readonly templateKey: string;
  stage: TemplateInstantiationStage;
  details?: string;
}
const context = new AsyncLocalStorage<DiagnosticContext>();

/** Whitelisted diagnostics only: never log headers, source, prompts or error objects. */
const sanitize = (value: string): string => {
  let result = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 6 && /TOKEN|SECRET|PASSWORD|API_?KEY|JWTKEY|DATABASE|REDIS_URL/i.test(key))
      result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|token|key|signature|X-Goog-Signature|X-Goog-Credential)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b[0-9a-f]{24}\b/gi, "[REDACTED_ACCOUNT_ID]");
};

export function markTemplateInstantiationStage(
  stage: TemplateInstantiationStage,
  details?: Readonly<Record<string, unknown>>,
): void {
  const current = context.getStore();
  if (!current) return;
  current.stage = stage;
  if (details) current.details = sanitize(JSON.stringify(details)).slice(0, 4000);
  else delete current.details;
}

function report(error: unknown, current: DiagnosticContext): void {
  try {
    const chain = [];
    const seen = new Set<unknown>();
    let cause = error;
    while (cause && !seen.has(cause) && chain.length < 6) {
      seen.add(cause);
      if (!(cause instanceof Error)) break;
      const code: unknown = (cause as Error & { code?: unknown }).code;
      chain.push({
        name: sanitize(cause.name),
        code: typeof code === "string" || typeof code === "number" ? code : undefined,
        message: sanitize(cause.message).slice(0, 2000),
        frames: cause.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 10).map(sanitize),
      });
      cause = cause.cause;
    }
    console.error("[sites][template-instantiation]", JSON.stringify({
      timestamp: new Date().toISOString(), requestId: current.requestId,
      templateKey: current.templateKey, stage: current.stage,
      details: current.details, exceptions: chain,
    }));
  } catch { /* Diagnostics must never change the operation's result. */ }
}

export async function withTemplateInstantiationDiagnostics<T>(
  templateKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current: DiagnosticContext = { requestId: randomUUID(), templateKey, stage: "TEMPLATE_RESOLUTION" };
  return context.run(current, async () => {
    try { return await operation(); }
    catch (error) { report(error, current); throw error; }
  });
}

export function reportTemplatePreviewFailure(templateKey: string, error: unknown): void {
  report(error, { requestId: randomUUID(), templateKey, stage: "PREVIEW_INITIALIZATION" });
}

export function reportTemplateAuthenticationFailure(status: number): void {
  try {
    console.error("[sites][template-instantiation]", JSON.stringify({ stage: "AUTH", status }));
  } catch { /* Logging is not an authentication decision. */ }
}
