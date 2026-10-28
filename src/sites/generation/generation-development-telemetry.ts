import { createHash } from "node:crypto";
import type { TemplateReferenceSelection } from "../../templates/application/template-design-context.js";
import { safeRedactSecrets } from "../../cli/runtime/build-log-normalizer.js";

export interface GenerationDevelopmentEvent {
  readonly jobId: string;
  readonly templateKey?: string | undefined;
  readonly templateVersion?: number | undefined;
  readonly referenceContextPresent?: boolean | undefined;
  readonly contextBytes?: number | undefined;
  readonly contextDigest?: string | undefined;
  readonly role: "generation" | "sites.site-planner" | "sites.site-coder" | "sites.targeted-edit";
  readonly model?: string | undefined;
  readonly failureStage?: string | undefined;
  readonly candidateDiagnosticPath?: string | undefined;
  readonly provider?: string | undefined;
  readonly responseSchema?: string | undefined;
  readonly responseSchemaVersion?: string | undefined;
  readonly validationCategory?: string | undefined;
  readonly validationPath?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly billingStatus?: string | undefined;
  readonly creditsCharged?: number | undefined;
  readonly excludedOperationCount?: number | undefined;
  readonly outcome?: "SUCCEEDED" | "FAILED" | undefined;
  readonly logicalRequests?: number | undefined;
  readonly physicalRequests?: number | undefined;
  readonly routeCount?: number | undefined;
  readonly requirementCount?: number | undefined;
  readonly failedProbeCount?: number | undefined;
}
export interface GenerationDevelopmentTelemetry { record(event: GenerationDevelopmentEvent): void }

export function referenceContextTelemetry(selection?: TemplateReferenceSelection, context?: string) {
  return {
    ...(selection ? { templateKey: selection.templateKey, templateVersion: selection.version } : {}),
    referenceContextPresent: Boolean(context), contextBytes: context ? Buffer.byteLength(context) : 0,
    ...(context ? { contextDigest: createHash("sha256").update(context).digest("hex") } : {}),
  };
}

/** Explicit metadata whitelist: never serialize the task, prompt, source, request or error object. */
export function createDevelopmentGenerationTelemetry(nodeEnv = process.env.NODE_ENV): GenerationDevelopmentTelemetry | undefined {
  if (nodeEnv === "production") return undefined;
  return { record(event) {
    const secrets = Object.entries(process.env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_?KEY|JWT|DATABASE|REDIS_URL/i.test(key) && value && value.length >= 6).map(([, value]) => value!);
    const metadata: GenerationDevelopmentEvent = {
      jobId: event.jobId, templateKey: event.templateKey, templateVersion: event.templateVersion,
      referenceContextPresent: event.referenceContextPresent, contextBytes: event.contextBytes, contextDigest: event.contextDigest,
      role: event.role, model: event.model, failureStage: event.failureStage, candidateDiagnosticPath: event.candidateDiagnosticPath,
      provider: event.provider, responseSchema: event.responseSchema, responseSchemaVersion: event.responseSchemaVersion,
      validationCategory: event.validationCategory, validationPath: event.validationPath,
      finishReason: event.finishReason, truncated: event.truncated, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
      billingStatus: event.billingStatus, creditsCharged: event.creditsCharged,
      excludedOperationCount: event.excludedOperationCount,
      outcome: event.outcome, logicalRequests: event.logicalRequests, physicalRequests: event.physicalRequests,
      routeCount: event.routeCount, requirementCount: event.requirementCount, failedProbeCount: event.failedProbeCount,
    };
    console.info("[sites][generation-context] " + JSON.stringify(metadata, (_key, value: unknown) => {
      if (typeof value !== "string") return value;
      let text = value;
      for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
      return safeRedactSecrets(text).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]").slice(0, 1000);
    }));
  } };
}

/** Read-only aggregate of existing metadata. Last terminal outcome per job wins;
 * observations never submit work, charge credits or write project records. */
export function summarizeGenerationReliability(events: readonly GenerationDevelopmentEvent[]) {
  const terminal = new Map<string, GenerationDevelopmentEvent>();
  for (const event of events) if (event.role === "generation" && event.outcome) terminal.set(event.jobId, event);
  const jobs = [...terminal.values()], completed = jobs.filter(event => event.outcome === "SUCCEEDED").length;
  const failures: Record<string, number> = {};
  for (const event of jobs.filter(event => event.outcome === "FAILED")) {
    const key = `${event.failureStage ?? "UNKNOWN"}:${event.validationCategory ?? "UNKNOWN"}`;
    failures[key] = (failures[key] ?? 0) + 1;
  }
  return { jobs: jobs.length, completed, completionRate: jobs.length ? completed / jobs.length : 0, failures,
    physicalRequests: jobs.reduce((sum, event) => sum + (event.physicalRequests ?? 0), 0),
    successfulBilling: jobs.filter(event => event.outcome === "SUCCEEDED" && event.billingStatus === "CHARGED").length };
}

export function recordGenerationTelemetry(sink: GenerationDevelopmentTelemetry | undefined, event: GenerationDevelopmentEvent): void {
  try { sink?.record(event); }
  catch { console.warn("[sites] Development generation telemetry unavailable"); }
}
