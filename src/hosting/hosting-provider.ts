export interface PublishRequest {
  readonly siteId: string;
  readonly versionId: string;
  readonly buildArtifactRef: string;
  readonly hostname?: string;
}
export interface HostedDeployment {
  readonly providerDeploymentId: string;
  readonly url: string;
  readonly status: "PENDING" | "ACTIVE" | "FAILED";
}
export interface HostingProvider {
  readonly id: string;
  publish(request: PublishRequest): Promise<HostedDeployment>;
  resolve(providerDeploymentId: string): Promise<HostedDeployment>;
  rollback(providerDeploymentId: string, targetVersionId: string): Promise<HostedDeployment>;
  unpublish(providerDeploymentId: string): Promise<void>;
}
