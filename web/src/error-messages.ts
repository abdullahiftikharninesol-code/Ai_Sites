import type { JobStatus } from "./api-client.js";

export function friendlyError(
  job?: JobStatus,
  fallback = "Something went wrong while working on the site.",
  operation: "GENERATE" | "EDIT" = "GENERATE",
): string {
  const noun = operation === "EDIT" ? "applying this change" : "generating this website";
  const code = job?.error?.code ?? "";
  const providerDetail = `${code} ${job?.error?.message ?? ""}`;
  if (/quota|billing/i.test(providerDetail))
    return job?.error?.message ?? "The AI account has no available quota.";
  if (
    job?.error?.status === 429 ||
    job?.error?.status === 503 ||
    /rate|temporarily unavailable|service unavailable/i.test(providerDetail)
  )
    return "The AI service is temporarily busy. Please try again shortly.";
  if (/STRUCTURED_RESPONSE|MODEL_OUTPUT_TRUNCATED|GENERATION_INCOMPLETE/.test(code))
    return `We couldn't finish ${noun}.`;
  if (/BUILD|REPAIR_LIMIT_REACHED/.test(code))
    return operation === "EDIT"
      ? "That change was applied, but the website no longer builds successfully."
      : "The website was generated, but it couldn't be built successfully.";
  if (/BROWSER|QA/.test(code))
    return operation === "EDIT"
      ? "That change was applied, but a browser check found an issue."
      : "The website was generated, but a browser check found an issue.";
  return job?.error?.message || fallback;
}
