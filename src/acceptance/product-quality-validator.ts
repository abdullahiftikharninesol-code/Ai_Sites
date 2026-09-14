import { SitePackageValidator } from "../sites/generation/site-policies.js";
export interface InternalLinkValidation {
  readonly links: readonly string[];
  readonly missingRoutes: readonly string[];
  readonly malformedLinks: readonly string[];
}
export class ProductQualityValidator {
  readonly #packages = new SitePackageValidator();
  validateDependencies(packageJson: string): void {
    this.#packages.validate(packageJson);
  }
  validateInternalLinks(source: string, routes: readonly string[]): InternalLinkValidation {
    const links = [...source.matchAll(/(?:href|to)\s*=\s*["']([^"']+)["']/g)]
      .map((match) => match[1]!)
      .filter((link) => !/^(?:https?:|mailto:|tel:|#)/i.test(link));
    const malformedLinks = links.filter((link) => !link.startsWith("/") || link.includes(".."));
    const known = new Set(routes);
    const missingRoutes = links.filter((link) => link.startsWith("/") && !known.has(link));
    return {
      links,
      missingRoutes: [...new Set(missingRoutes)],
      malformedLinks: [...new Set(malformedLinks)],
    };
  }
}
