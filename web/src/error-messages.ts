import type { JobStatus } from "./api-client.js";

export function friendlyError(
  job?: JobStatus,
  fallback = "Something went wrong while working on the site.",
): string {
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
    return "We couldn't finish generating this website.";
  if (/BUILD|REPAIR_LIMIT_REACHED/.test(code))
    return "The website was generated, but it couldn't be built successfully.";
  if (/BROWSER|QA/.test(code))
    return "The website was generated, but a browser check found an issue.";
  return fallback;
}
