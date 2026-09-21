import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { GeneratedAppProfile } from "../../cli/runtime/site-technical-profile.js";
import type { SiteCapabilityId } from "./capability-registry.js";

export type SitesUiCategory = "primitive" | "component" | "section" | "tokens";

export interface SitesUiRegistryItem {
  readonly id: string;
  readonly version: number;
  readonly category: SitesUiCategory;
  readonly requiredCapabilities: readonly SiteCapabilityId[];
  readonly supportedProfiles: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly importPath: string;
  readonly accessibilityNotes: string;
  readonly markerCompatibility: string;
}

const profile = "react-vite-v1";
const source = (file: string): string => `src/sites-ui/${file}`;

const sources: Readonly<Record<string, string>> = {
  [source("tokens.css")]: `:root {
  --sites-container: 72rem;
  --sites-space-1: 0.25rem;
  --sites-space-2: 0.5rem;
  --sites-space-3: 0.75rem;
  --sites-space-4: 1rem;
  --sites-space-6: 1.5rem;
  --sites-space-8: 2rem;
  --sites-radius-sm: 0.375rem;
  --sites-radius-md: 0.75rem;
  --sites-radius-lg: 1rem;
  --sites-font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --sites-foreground: #172033;
  --sites-background: #ffffff;
  --sites-primary: #2563eb;
  --sites-accent: #7c3aed;
  --sites-muted: #64748b;
  --sites-border: #dbe3ef;
}

.sites-ui-container {
  width: min(100% - 2rem, var(--sites-container));
  margin-inline: auto;
}
`,
  [source("primitives/Button.tsx")]: `export interface ButtonProps {
  readonly children: string;
  readonly type?: "button" | "submit" | "reset";
  readonly className?: string;
  readonly disabled?: boolean;
}

export function Button({ children, type = "button", className = "", disabled = false }: ButtonProps) {
  return (
    <button className={\`sites-ui-button \${className}\`.trim()} type={type} disabled={disabled}>
      {children}
    </button>
  );
}
`,
  [source("primitives/Card.tsx")]: `import type { ReactNode } from "react";

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Card({ children, className = "" }: CardProps) {
  return <article className={\`sites-ui-card \${className}\`.trim()}>{children}</article>;
}
`,
  [source("primitives/FormField.tsx")]: `export interface FormFieldProps {
  readonly id: string;
  readonly label: string;
  readonly type?: "text" | "email" | "tel";
  readonly required?: boolean;
}

export function FormField({ id, label, type = "text", required = false }: FormFieldProps) {
  return (
    <div className="sites-ui-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} type={type} required={required} />
    </div>
  );
}
`,
  [source("components/Navbar.tsx")]: `export interface NavbarItem {
  readonly label: string;
  readonly href: string;
}

export function Navbar({ brand, items }: { readonly brand: string; readonly items: readonly NavbarItem[] }) {
  return (
    <nav aria-label="Primary navigation" className="sites-ui-navbar">
      <a href="/" className="sites-ui-brand">{brand}</a>
      <div className="sites-ui-nav-links">
        {items.map((item) => <a key={item.href} href={item.href}>{item.label}</a>)}
      </div>
    </nav>
  );
}
`,
  [source("components/Footer.tsx")]:
    `export function Footer({ copyright }: { readonly copyright: string }) {
  return <footer className="sites-ui-footer"><small>{copyright}</small></footer>;
}
`,
  [source("sections/Hero.tsx")]: `import type { ReactNode } from "react";

export function Hero({ title, description, action }: { readonly title: string; readonly description: string; readonly action?: ReactNode }) {
  return (
    <section className="sites-ui-hero" data-sites-section="hero">
      <h1>{title}</h1>
      <p>{description}</p>
      {action}
    </section>
  );
}
`,
  [source("sections/FeatureGrid.tsx")]: `import { Card } from "../primitives/Card";

export interface FeatureItem {
  readonly title: string;
  readonly description: string;
}

export function FeatureGrid({ items }: { readonly items: readonly FeatureItem[] }) {
  return (
    <section data-sites-section="features" aria-labelledby="features-title">
      <h2 id="features-title">Features</h2>
      <div className="sites-ui-feature-grid">
        {items.map((item) => <Card key={item.title}><h3>{item.title}</h3><p>{item.description}</p></Card>)}
      </div>
    </section>
  );
}
`,
  [source("sections/ContactSection.tsx")]: `import { Button } from "../primitives/Button";
import { FormField } from "../primitives/FormField";

export function ContactSection() {
  return (
    <section data-sites-section="contact" aria-labelledby="contact-title">
      <h2 id="contact-title">Contact</h2>
      <form>
        <FormField id="name" label="Name" required />
        <FormField id="email" label="Email" type="email" required />
        <Button type="submit">Send message</Button>
      </form>
    </section>
  );
}
`,
};

const item = (
  id: string,
  category: SitesUiCategory,
  file: string,
  importPath: string,
): SitesUiRegistryItem => ({
  id,
  version: 1,
  category,
  requiredCapabilities: ["ui"],
  supportedProfiles: [profile],
  sourceFiles: [file],
  importPath,
  accessibilityNotes:
    "Uses semantic HTML and native controls; labels and navigation landmarks are explicit.",
  markerCompatibility:
    "Sections preserve data-sites-section markers; compose inside data-sites-page markup.",
});

const tokenItem: SitesUiRegistryItem = {
  id: "design-tokens",
  version: 1,
  category: "tokens",
  requiredCapabilities: ["ui"],
  supportedProfiles: [profile],
  sourceFiles: [source("tokens.css")],
  importPath: "./sites-ui/tokens.css",
  accessibilityNotes: "Visual tokens only; no interaction semantics.",
  markerCompatibility: "Does not alter structural markers.",
};

export const SITES_UI_REGISTRY_VERSION = "v1";
export const SITES_UI_REGISTRY_ITEMS: readonly SitesUiRegistryItem[] = [
  item("Button", "primitive", source("primitives/Button.tsx"), "./sites-ui/primitives/Button"),
  item("Card", "primitive", source("primitives/Card.tsx"), "./sites-ui/primitives/Card"),
  item(
    "FormField",
    "primitive",
    source("primitives/FormField.tsx"),
    "./sites-ui/primitives/FormField",
  ),
  item("Navbar", "component", source("components/Navbar.tsx"), "./sites-ui/components/Navbar"),
  item("Footer", "component", source("components/Footer.tsx"), "./sites-ui/components/Footer"),
  item("Hero", "section", source("sections/Hero.tsx"), "./sites-ui/sections/Hero"),
  item(
    "FeatureGrid",
    "section",
    source("sections/FeatureGrid.tsx"),
    "./sites-ui/sections/FeatureGrid",
  ),
  item(
    "ContactSection",
    "section",
    source("sections/ContactSection.tsx"),
    "./sites-ui/sections/ContactSection",
  ),
  tokenItem,
].sort((a, b) => a.id.localeCompare(b.id));

export class SitesUiRegistry {
  readonly #items = new Map<string, SitesUiRegistryItem>();
  readonly version: string;

  constructor(
    items: readonly SitesUiRegistryItem[] = SITES_UI_REGISTRY_ITEMS,
    version = SITES_UI_REGISTRY_VERSION,
  ) {
    this.version = version;
    for (const entry of items) this.register(entry);
  }

  register(entry: SitesUiRegistryItem): void {
    const key = `${entry.id}@${entry.version}`;
    if (this.#items.has(key))
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Sites UI item '${key}' is already registered`,
      );
    this.#items.set(key, entry);
  }

  getItem(id: string, version?: number): SitesUiRegistryItem {
    const matches = [...this.#items.values()]
      .filter((entry) => entry.id === id)
      .sort((a, b) => b.version - a.version);
    const result =
      version === undefined ? matches[0] : matches.find((entry) => entry.version === version);
    if (!result)
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Sites UI item '${id}${version === undefined ? "" : `@${version}`}' is not registered`,
      );
    return result;
  }

  listItems(): readonly SitesUiRegistryItem[] {
    return [...this.#items.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || a.version - b.version,
    );
  }

  async materialize(
    execution: ExecutionProvider,
    environmentId: string,
    profile: GeneratedAppProfile,
  ): Promise<readonly string[]> {
    if (!profile.supportsResponsiveDesign || !profile.supportsRouting)
      throw new ApplicationError(
        "CAPABILITY_PROFILE_MISMATCH",
        `Sites UI is not compatible with '${profile.id}'`,
      );
    for (const entry of this.#items.values()) {
      if (!entry.supportedProfiles.includes(profile.id))
        throw new ApplicationError(
          "CAPABILITY_PROFILE_MISMATCH",
          `Sites UI item '${entry.id}' does not support '${profile.id}'`,
        );
      for (const capability of entry.requiredCapabilities)
        if (capability !== "ui")
          throw new ApplicationError(
            "CAPABILITY_REQUIREMENT_UNSATISFIED",
            `Sites UI item '${entry.id}' requires unsupported capability '${capability}'`,
          );
    }
    const materializedSources = Object.entries(sources);
    for (const [path, content] of materializedSources)
      await execution.writeFile(environmentId, path, content);
    return materializedSources.map(([path]) => path).sort();
  }
}

export const SITES_UI_REGISTRY = new SitesUiRegistry();
