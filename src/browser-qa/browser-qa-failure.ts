import type { BrowserQAFailureKind } from "./browser-qa-domain.js";

/** Only a failed behavioral assertion, not an arbitrary checker exception,
 * can establish a functional defect eligible for the existing repair path. */
export class FunctionalValidationError extends Error {
  constructor(message: string) { super(message); this.name = "FunctionalValidationError"; }
}

/** A timeout proves an action was not validated, not that the model omitted it. */
export function classifyBrowserQAFailure(error: unknown, checkId: string): BrowserQAFailureKind {
  if (!(error instanceof Error)) return "CHECK_EXECUTION_ERROR";
  if (error.name === "BrowserQATimeoutError") return "CHECK_TIMEOUT";
  if (/strict mode violation|browser.*(?:closed|launch|disconnected)|target (?:page|closed)|context.*closed/i.test(error.message)) return "QA_INFRASTRUCTURE_FAILURE";
  if (/page\.goto|navigation (?:failed|timeout)|route failed to load/i.test(error.message)) return "NAVIGATION_FAILURE";
  if (error.name === "TimeoutError") return /(?:locator|elementHandle)\.(?:hover|click|tap|check|fill|focus|selectOption|scrollIntoViewIfNeeded)/.test(error.message) ? "ACTIONABILITY_TIMEOUT" : "READINESS_TIMEOUT";
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) return "QA_INFRASTRUCTURE_FAILURE";
  return error instanceof FunctionalValidationError ? checkId === "functional.navigation" ? "NAVIGATION_FAILURE" : "FUNCTIONAL_FAILURE" : "CHECK_EXECUTION_ERROR";
}
