import type { SiteSpec } from "../../sites/domain/site-spec.js";
import type { WorkflowState } from "../../sites/domain/workflow.js";

export interface SitesAgentContextInput {
  readonly operation: "GENERATE" | "EDIT" | "REPAIR";
  readonly userRequest: string;
  readonly siteSpec?: SiteSpec;
  readonly projectSummary?: string;
  readonly knownFiles?: readonly string[];
  readonly buildError?: string;
  readonly workflowState: WorkflowState;
}
export class SitesAgentContextBuilder {
  build(input: SitesAgentContextInput): string {
    const stable = [`Operation: ${input.operation}`, `Workflow state: ${input.workflowState}`];
    if (input.siteSpec) stable.push(`SiteSpec: ${JSON.stringify(input.siteSpec)}`);
    if (input.projectSummary) stable.push(`Project summary: ${input.projectSummary}`);
    if (input.knownFiles?.length) stable.push(`Known files: ${input.knownFiles.join(", ")}`);
    stable.push(`User request: ${input.userRequest}`);
    if (input.buildError) stable.push(`Latest build error: ${input.buildError}`);
    return stable.join("\n");
  }
}
