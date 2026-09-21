import { ApplicationError } from "../../app/errors/application-error.js";
import {
  SITE_CAPABILITY_REGISTRY,
  type SiteCapabilityDefinition,
  type SiteCapabilityId,
  type SiteCapabilityRegistry,
} from "./capability-registry.js";
import {
  getDefaultProfile,
  getProfile,
  type GeneratedAppProfile,
} from "../../cli/runtime/site-technical-profile.js";
import type { SiteSpec } from "../domain/site-spec.js";

export interface ResolvedCapability {
  readonly id: SiteCapabilityId;
  readonly version: number;
}

export interface ResolvedCapabilities {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly capabilityRegistryVersion: string;
  readonly capabilities: readonly ResolvedCapability[];
}

export interface CapabilityResolverOptions {
  readonly profile?: GeneratedAppProfile;
  readonly requiredCapabilities?: readonly SiteCapabilityId[];
  /** Original request text used only for deterministic capability evidence. */
  readonly requestText?: string;
}

const formFeatures = new Set([
  "contact form",
  "appointment form",
  "inquiry form",
  "demo request form",
  "reservation form",
]);
const imageFeatures = new Set(["images", "image asset", "image assets", "image gallery"]);
const imageRequestPattern = /\b(?:image|images|photo|photos|photograph|photographs|picture|pictures|illustration|illustrations|imagery|gallery|galleries|logo|logos)\b/i;

/**
 * Detects explicit image/media intent without making package decisions from
 * vague visual adjectives such as "modern" or "colorful".
 */
export function isImageRequested(text: string): boolean {
  return imageRequestPattern.test(text);
}

export class CapabilityResolver {
  constructor(private readonly registry: SiteCapabilityRegistry = SITE_CAPABILITY_REGISTRY) {}

  resolve(siteSpec: SiteSpec, options: CapabilityResolverOptions = {}): ResolvedCapabilities {
    const profile = options.profile ?? this.profileFor(siteSpec);
    const selected = new Set<SiteCapabilityId>();

    const add = (id: SiteCapabilityId): void => {
      if (selected.has(id)) return;
      const capability = this.registry.getCapability(id);
      this.assertCompatible(capability, profile);
      if (capability.status !== "AVAILABLE")
        throw new ApplicationError(
          "UNSUPPORTED_CAPABILITY",
          `Capability '${id}' is ${capability.status.toLowerCase()} for profile '${profile.id}'`,
          { metadata: { capabilityId: id, profileId: profile.id } },
        );
      selected.add(id);
      for (const required of capability.requires) add(required);
    };

    add("core-web");
    if (this.registry.getCapability("ui").status === "AVAILABLE") add("ui");

    const features = new Set(
      siteSpec.requirements.features.map((feature) => feature.trim().toLowerCase()),
    );
    const imageEvidence = [...features, options.requestText ?? ""].join(" ");
    if (
      [...features].some((feature) => formFeatures.has(feature)) ||
      this.hasSubmissionCollection(siteSpec)
    )
      add("forms");
    if ([...features].some((feature) => imageFeatures.has(feature)) || isImageRequested(imageEvidence))
      add("images");
    if (siteSpec.auth?.authRequired || (siteSpec.auth?.protectedPages.length ?? 0) > 0) add("auth");
    if (siteSpec.runtime?.enabled && siteSpec.runtime.collections.length > 0) add("database");
    if (this.hasReadableCollection(siteSpec)) add("server-data");

    for (const required of options.requiredCapabilities ?? []) add(required);
    this.assertNoConflicts([...selected], profile);

    const capabilities = [...selected]
      .map((id) => {
        const item = this.registry.getCapability(id);
        return { id: item.id, version: item.version };
      })
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
    return {
      profileId: profile.id,
      profileVersion: profile.version,
      capabilityRegistryVersion: this.registry.version,
      capabilities,
    };
  }

  serialize(resolved: ResolvedCapabilities): string {
    return JSON.stringify({
      profileId: resolved.profileId,
      profileVersion: resolved.profileVersion,
      capabilityRegistryVersion: resolved.capabilityRegistryVersion,
      capabilities: resolved.capabilities,
    });
  }

  private profileFor(siteSpec: SiteSpec): GeneratedAppProfile {
    return siteSpec.technical.profileId
      ? getProfile(siteSpec.technical.profileId)
      : getDefaultProfile();
  }

  private assertCompatible(
    capability: SiteCapabilityDefinition,
    profile: GeneratedAppProfile,
  ): void {
    if (!capability.supportedProfiles.includes(profile.id))
      throw new ApplicationError(
        "CAPABILITY_PROFILE_MISMATCH",
        `Capability '${capability.id}' does not support profile '${profile.id}'`,
        { metadata: { capabilityId: capability.id, profileId: profile.id } },
      );
  }

  private hasSubmissionCollection(siteSpec: SiteSpec): boolean {
    const submissionNames = new Set([
      "contact_submissions",
      "appointment_requests",
      "reservation_requests",
      "inquiries",
      "demo_requests",
    ]);
    return (
      siteSpec.runtime?.enabled === true &&
      siteSpec.runtime.collections.some((collection) => submissionNames.has(collection.name))
    );
  }

  private hasReadableCollection(siteSpec: SiteSpec): boolean {
    return (
      siteSpec.runtime?.enabled === true &&
      siteSpec.runtime.collections.some((collection) =>
        [
          collection.access?.public,
          collection.access?.authenticated,
          collection.access?.owner,
        ].some((operations) => operations?.read === true),
      )
    );
  }

  private assertNoConflicts(ids: readonly SiteCapabilityId[], profile: GeneratedAppProfile): void {
    const selected = new Set(ids);
    for (const id of ids) {
      const capability = this.registry.getCapability(id);
      this.assertCompatible(capability, profile);
      for (const conflict of capability.conflictsWith)
        if (selected.has(conflict))
          throw new ApplicationError(
            "CAPABILITY_CONFLICT",
            `Capabilities '${id}' and '${conflict}' cannot be selected together`,
            { metadata: { capabilityId: id, conflictWith: conflict } },
          );
    }
  }
}

export const CAPABILITY_RESOLVER = new CapabilityResolver();

export function resolveCapabilities(
  siteSpec: SiteSpec,
  options?: CapabilityResolverOptions,
): ResolvedCapabilities {
  return CAPABILITY_RESOLVER.resolve(siteSpec, options);
}
