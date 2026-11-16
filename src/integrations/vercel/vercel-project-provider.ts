import { randomUUID } from "node:crypto";
import type { Connection } from "mongoose";
import { PublishingError, accountMismatchError, type PublishingErrorCode } from "../../publishing/publishing-errors.js";
import { VercelIntegrationError, type VercelConnectionService, type VercelCredentials } from "./vercel-connection-service.js";
import {
  MongoVercelProjectLinkRepository,
  type VercelProjectLinkRepository,
} from "./vercel-project-link-repository.js";
import { classifyVercelApiError } from "./vercel-api-errors.js";
import { MongoVercelPublishRepository } from "../../publishing/vercel-publish-repository.js";
import {
  VercelApiError,
  createVercelProjectsClient,
  type VercelAuth,
  type VercelConfigurationInfo,
  type VercelProjectInfo,
  type VercelProjectsClient,
} from "./vercel-projects-client.js";

export const VERCEL_PROJECT_LEASE_MS = 60_000;

export interface LinkedVercelProject {
  readonly projectId: string;
  readonly projectName: string;
  /** The team ID, or the Vercel user ID for a personal installation. */
  readonly accountId: string;
  readonly configurationId: string;
  readonly outcome: "REUSED" | "ADOPTED" | "CREATED";
}

/** Deterministic, collision-free Vercel project name for a site (lowercase, ≤ 100 chars). */
export const vercelProjectNameFor = (siteId: string) => {
  const id = siteId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  if (!id) throw new PublishingError("PUBLISH_PREPARATION_FAILED", "Site identifier cannot be used as a project name");
  return `ai-sites-${id}`;
};

/** The project a published site is pinned to: it is reused, never replaced by a second project. */
export interface PublishedProjectPin {
  readonly projectId: string;
  readonly accountId: string;
  /** Verified display name of the account (for the mismatch explanation only). */
  readonly accountLabel?: string;
}

const UNAVAILABLE_GUIDANCE =
  "AI Sites can't reach the Vercel project this website is published to. It may have been deleted, or the integration lost access to it. " +
  "AI Sites won't create a second project for a published website: restore access to that project in Vercel, then try again.";

const RESTRICTED_GUIDANCE =
  "The AI Sites integration only has access to selected Vercel projects, so it cannot create a project for this site. " +
  "In Vercel, open Integrations → AI Sites → Manage and grant access to All Projects, then publish again. AI Sites never broadens this permission itself.";

/**
 * Creates or reuses the Vercel project a site publishes to, always inside the
 * account the user authorized (their team when installed on a team, else
 * their personal account) and never with the integration owner's own token.
 *
 * Idempotency: one link record per site; creation runs under a lease, the
 * project name is deterministic, a 409 or an existing project with that name
 * in the authorized account is adopted, and every returned project is checked
 * to belong to that account.
 *
 * Once a site is published, it is pinned to the published project: only
 * that project (looked up by ID, in the same account) is reused, and a
 * missing or inaccessible one fails instead of creating a second project.
 */
export class VercelProjectProvider {
  constructor(
    private readonly connections: Pick<VercelConnectionService, "credentials">,
    private readonly links: VercelProjectLinkRepository,
    private readonly client: VercelProjectsClient = createVercelProjectsClient(),
    private readonly now: () => Date = () => new Date(),
    private readonly publishedProject: (siteId: string) => Promise<PublishedProjectPin | undefined> = () => Promise.resolve(undefined),
  ) {}

  async ensureProject(ownerId: string, siteId: string): Promise<LinkedVercelProject> {
    const credentials = await this.#credentials(ownerId);
    const auth: VercelAuth = { accessToken: credentials.accessToken, teamId: credentials.teamId };
    const accountId = credentials.teamId ?? credentials.vercelUserId;
    const projectName = vercelProjectNameFor(siteId);

    const link = await this.links.find(siteId);
    if (link && link.ownerId !== ownerId)
      throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "This site is linked to a Vercel project of another account.");
    const pin = await this.publishedProject(siteId);
    if (pin && pin.accountId !== accountId) throw accountMismatchError(pin);
    if (
      link?.status === "LINKED" && link.projectId && link.configurationId === credentials.configurationId && link.accountId === accountId &&
      (!pin || link.projectId === pin.projectId)
    ) {
      const existing = await this.#vercel(() => this.client.findProject(auth, link.projectId!));
      if (existing) {
        this.#assertAccount(existing, accountId);
        return { projectId: existing.id, projectName: existing.name, accountId, configurationId: credentials.configurationId, outcome: "REUSED" };
      }
      // Removed on Vercel: relink (never resurrect silently into another account).
      if (pin) throw new PublishingError("VERCEL_PROJECT_UNAVAILABLE", UNAVAILABLE_GUIDANCE, { metadata: { projectId: pin.projectId } });
      await this.links.markStale(siteId, link.projectId, this.now());
    }

    const leaseId = randomUUID();
    const now = this.now();
    const claimed = await this.links.claimCreation({
      siteId, ownerId, configurationId: credentials.configurationId, accountId, teamId: credentials.teamId,
      projectName, leaseId, now, leaseExpiresAt: new Date(now.getTime() + VERCEL_PROJECT_LEASE_MS),
    });
    if (!claimed) {
      const current = await this.links.find(siteId);
      if (current?.status === "LINKED" && current.projectId && current.configurationId === credentials.configurationId && current.accountId === accountId && (!pin || current.projectId === pin.projectId))
        return { projectId: current.projectId, projectName: current.projectName, accountId, configurationId: credentials.configurationId, outcome: "REUSED" };
      throw new PublishingError("VERCEL_PROJECT_LINK_IN_PROGRESS", "A Vercel project is already being set up for this site. Try again in a minute.");
    }

    try {
      const configuration = await this.#vercel(() => this.client.getConfiguration(auth, credentials.configurationId));
      this.#assertConfiguration(configuration, credentials, accountId);
      let outcome: LinkedVercelProject["outcome"] = "ADOPTED";
      // A published site is looked up by its pinned project ID (it may have been renamed) and never recreated.
      let project = await this.#vercel(() => this.client.findProject(auth, pin?.projectId ?? projectName));
      if (!project && pin) throw new PublishingError("VERCEL_PROJECT_UNAVAILABLE", UNAVAILABLE_GUIDANCE, { metadata: { projectId: pin.projectId } });
      if (!project) {
        if (configuration.projectSelection === "selected")
          throw new PublishingError("VERCEL_PROJECT_ACCESS_RESTRICTED", RESTRICTED_GUIDANCE, {
            metadata: { projectSelection: "selected", projectName },
          });
        const created = await this.#vercel(() => this.client.createProject(auth, { name: projectName }));
        if (created === "CONFLICT") project = await this.#vercel(() => this.client.findProject(auth, projectName));
        else {
          project = created;
          outcome = "CREATED";
        }
        if (!project) throw new PublishingError("VERCEL_REQUEST_REJECTED", "Vercel reported a project conflict but the project could not be found.");
      }
      this.#assertAccount(project, accountId);
      if (pin && project.id !== pin.projectId) throw new PublishingError("VERCEL_PROJECT_UNAVAILABLE", UNAVAILABLE_GUIDANCE, { metadata: { projectId: pin.projectId } });
      if (configuration.projectSelection === "selected" && !configuration.projects?.includes(project.id))
        throw new PublishingError("VERCEL_PROJECT_ACCESS_RESTRICTED", RESTRICTED_GUIDANCE, {
          metadata: { projectSelection: "selected", projectName },
        });
      if (!(await this.links.completeLink(siteId, leaseId, { projectId: project.id, projectName: project.name, accountId, now: this.now() })))
        throw new PublishingError("VERCEL_PROJECT_LINK_IN_PROGRESS", "The Vercel project link changed while it was being saved. Try again.");
      console.info(`[sites][vercel] project ${outcome.toLowerCase()} site=${siteId} configuration=${credentials.configurationId}`);
      return { projectId: project.id, projectName: project.name, accountId, configurationId: credentials.configurationId, outcome };
    } catch (error) {
      await this.links.releaseLease(siteId, leaseId, this.now()).catch(() => undefined);
      throw error;
    }
  }

  async #credentials(ownerId: string): Promise<VercelCredentials> {
    try {
      return await this.connections.credentials(ownerId);
    } catch (error) {
      if (error instanceof VercelIntegrationError) {
        const code: PublishingErrorCode =
          error.code === "VERCEL_INTEGRATION_NOT_CONFIGURED"
            ? "VERCEL_INTEGRATION_NOT_CONFIGURED"
            : error.code === "VERCEL_TOKEN_UNAVAILABLE"
              ? "VERCEL_TOKEN_UNAVAILABLE"
              : "VERCEL_NOT_CONNECTED";
        throw new PublishingError(code, error.message);
      }
      throw error;
    }
  }

  #assertConfiguration(configuration: VercelConfigurationInfo, credentials: VercelCredentials, accountId: string) {
    if (configuration.id !== credentials.configurationId || configuration.teamId !== credentials.teamId || (configuration.ownerId !== undefined && configuration.ownerId !== accountId))
      throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "The Vercel installation does not match the account you authorized. Reconnect Vercel.");
    if (configuration.disabled)
      throw new PublishingError("VERCEL_INTEGRATION_DISABLED", "The AI Sites integration is disabled in this Vercel account. Re-enable or reinstall it in Vercel.");
    // Scope strings look like "read:project" / "read-write:project". Only a
    // recognizable read-only grant blocks; anything else is left to Vercel.
    const project = configuration.scopes.filter((scope) => /(?:^|:)project$/.test(scope));
    if (project.length && !project.some((scope) => scope.startsWith("read-write:")))
      throw new PublishingError("VERCEL_PROJECT_SCOPE_MISSING", "The AI Sites integration can read but not create Vercel projects. Approve the updated permissions in Vercel, then publish again.", {
        metadata: { scopes: project.slice(0, 5) },
      });
  }

  #assertAccount(project: VercelProjectInfo, accountId: string) {
    if (project.accountId !== accountId)
      throw new PublishingError("VERCEL_ACCOUNT_MISMATCH", "Vercel returned a project from a different account than the one you authorized.", {
        metadata: { projectId: project.id },
      });
  }

  async #vercel<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof VercelApiError)) throw error;
      throw classifyVercelApiError(error, "project");
    }
  }
}

export const createVercelProjectProvider = (
  connection: Connection,
  connections: Pick<VercelConnectionService, "credentials">,
) => {
  const publications = new MongoVercelPublishRepository(connection);
  return new VercelProjectProvider(connections, new MongoVercelProjectLinkRepository(connection), createVercelProjectsClient(), () => new Date(), async (siteId) => {
    const publication = await publications.findPublication(siteId);
    return publication ? { projectId: publication.projectId, accountId: publication.accountId, ...(publication.accountLabel ? { accountLabel: publication.accountLabel } : {}) } : undefined;
  });
};
