import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteJob, SiteProject, SiteVersion } from "./entities.js";

const fail = (message: string): never => {
  throw new ApplicationError("VALIDATION_FAILED", message);
};

export function assertSiteProject(project: SiteProject): void {
  if (!project.name.trim()) fail("Site project name is required");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)) fail("Site slug is invalid");
  if (project.updatedAt < project.createdAt) fail("updatedAt cannot precede createdAt");
}

export function assertSiteVersion(version: SiteVersion): void {
  if (!Number.isInteger(version.versionNumber) || version.versionNumber < 1)
    fail("Version number must be a positive integer");
  if (!version.sourceArtifactRef.trim()) fail("Source artifact reference is required");
}

export function assertSiteJob(job: SiteJob): void {
  for (const [label, value] of [
    ["logicalCalls", job.logicalCalls],
    ["physicalRequests", job.physicalRequests],
    ["retries", job.retries],
  ] as const)
    if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  if (job.updatedAt < job.createdAt) fail("updatedAt cannot precede createdAt");
}
