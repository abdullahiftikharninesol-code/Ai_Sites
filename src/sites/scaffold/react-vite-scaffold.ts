import type { ExecutionProvider } from "../../execution/execution-provider.js";
import {
  buildResolvedDependencyManifest,
  materializePackageJson,
} from "../generation/resolved-dependency-manifest.js";
import { SITE_V1_TECHNICAL_PROFILE } from "../../cli/runtime/site-technical-profile.js";
import { SITE_CAPABILITY_REGISTRY_VERSION } from "../generation/capability-registry.js";

const DEFAULT_DEPENDENCY_MANIFEST = buildResolvedDependencyManifest(SITE_V1_TECHNICAL_PROFILE, {
  profileId: SITE_V1_TECHNICAL_PROFILE.id,
  profileVersion: SITE_V1_TECHNICAL_PROFILE.version,
  capabilityRegistryVersion: SITE_CAPABILITY_REGISTRY_VERSION,
  capabilities: [{ id: "core-web", version: 1 }],
});

export const DEFAULT_PACKAGE_JSON = materializePackageJson(DEFAULT_DEPENDENCY_MANIFEST, {
  name: "react-vite-site",
});

export const DEFAULT_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;

export const DEFAULT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      useDefineForClassFields: true,
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: "force",
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
      noFallthroughCasesInSwitch: true,
    },
    include: ["src"],
  },
  null,
  2,
);

export const DEFAULT_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Generated Site</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

export const DEFAULT_MAIN_TSX = `import { StrictMode, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import * as appModule from "./App";
import "./styles.css";

type Theme = "light" | "dark";
const themeStorageKey = "sites-theme:" + document.title;

function readStoredTheme(): Theme | undefined {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return stored === "light" || stored === "dark" ? stored : undefined;
  } catch {
    return undefined;
  }
}

// Every site ships both themes. Start from the design's light baseline instead
// of inheriting the viewer's OS dark setting; remember explicit visitor choices.
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => readStoredTheme() ?? "light",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Private browsing: the theme still applies for this visit.
    }
  }, [theme]);

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M20.5 14.2A8.4 8.4 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// main.tsx is Sites-managed and the generated entry component is not, so accept
// either export style rather than failing the build on \`export default App\`.
const exported = appModule as unknown as {
  readonly default?: ComponentType;
  readonly App?: ComponentType;
};
const App = exported.default ?? exported.App;
if (!App)
  throw new Error("src/App.tsx must export an App component (default export or named \`App\`).");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <ThemeToggle />
  </StrictMode>,
);
`;

export const DEFAULT_VITE_ENV_D_TS = `/// <reference types="vite/client" />
`;

/**
 * Grounded baseline so generated sites start from a designed foundation rather
 * than inventing an entire visual language per request. Warm neutrals, one
 * restrained accent, a real type scale, hairline borders over heavy shadows.
 * Local font stacks only: remote font loading is stripped before build.
 */
export const DEFAULT_STYLES_CSS = `*,
*::before,
*::after {
  box-sizing: border-box;
}
:root {
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-display: Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --surface: #fbfaf9;
  --surface-raised: #ffffff;
  --surface-sunken: #f3f1ee;
  --ink: #1a1a18;
  --ink-soft: #55534e;
  --ink-faint: #85827c;
  --line: #e4e1dc;
  --accent: #1f3a5f;
  --accent-hover: #162c48;
  --accent-ink: #ffffff;
  --accent-wash: #eef1f6;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: 4rem;
  --space-9: 6rem;

  --radius-sm: 0.375rem;
  --radius: 0.625rem;
  --radius-lg: 1rem;
  --shadow: 0 1px 2px rgba(26, 26, 24, 0.04), 0 12px 32px -20px rgba(26, 26, 24, 0.25);
  --dot-grid: rgba(26, 26, 24, 0.07);
  /* Splashes tint rather than smudge: a dark accent blurred over a light
     surface reads as grey mud, so light mode stays restrained. */
  --splash-color: var(--accent);
  --splash-strength: 0.22;
  --measure: 68ch;
  --container: 70rem;

  color-scheme: light dark;

  font-family: var(--font-sans);
  line-height: 1.6;
  color: var(--ink);
  background-color: var(--surface);
  -webkit-font-smoothing: antialiased;
}
body {
  margin: 0;
  min-height: 100vh;
  font-size: 1rem;
}
h1,
h2,
h3,
h4 {
  font-family: var(--font-display);
  font-weight: 600;
  line-height: 1.12;
  letter-spacing: -0.015em;
  margin: 0 0 var(--space-4);
  text-wrap: balance;
}
h1 {
  font-size: clamp(2.25rem, 5vw, 3.5rem);
}
h2 {
  font-size: clamp(1.625rem, 3.5vw, 2.25rem);
}
h3 {
  font-size: clamp(1.125rem, 2vw, 1.375rem);
}
p {
  margin: 0 0 var(--space-4);
  max-width: var(--measure);
  color: var(--ink-soft);
  text-wrap: pretty;
}
a {
  color: var(--accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
}
button {
  font: inherit;
  cursor: pointer;
}
img,
video,
canvas,
svg {
  display: block;
  max-width: 100%;
  height: auto;
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
ul,
ol {
  padding-inline-start: 1.25rem;
}
code,
pre {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
.container,
.sites-ui-container {
  width: min(100% - 2rem, var(--container));
  margin-inline: auto;
}
.section {
  padding-block: clamp(3rem, 8vw, var(--space-9));
}
.section--sunken {
  background: var(--surface-sunken);
}
.stack > * + * {
  margin-top: var(--space-4);
}
.cluster {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
}
.grid {
  display: grid;
  gap: var(--space-5);
  grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
}
.eyebrow {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
  font-family: var(--font-sans);
}
.lede {
  font-size: clamp(1.0625rem, 1.6vw, 1.25rem);
  color: var(--ink-soft);
}
.muted {
  color: var(--ink-faint);
}
.card,
.sites-ui-card {
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-5);
  box-shadow: var(--shadow);
}
.button,
.sites-ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0.7rem 1.25rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 550;
  text-decoration: none;
  transition: background-color 150ms ease;
}
.button:hover,
.sites-ui-button:hover {
  background: var(--accent-hover);
}
.button--ghost {
  background: transparent;
  color: var(--ink);
  border-color: var(--line);
}
.button--ghost:hover {
  background: var(--surface-sunken);
}
.sites-ui-navbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-block: var(--space-4);
  border-bottom: 1px solid var(--line);
}
.sites-ui-brand {
  font-family: var(--font-display);
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}
.sites-ui-nav-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.sites-ui-nav-links a {
  color: var(--ink-soft);
  text-decoration: none;
}
.sites-ui-nav-links a:hover {
  color: var(--ink);
}
.sites-ui-hero {
  padding-block: clamp(3rem, 9vw, var(--space-9));
}
.sites-ui-feature-grid {
  display: grid;
  gap: var(--space-5);
  grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
}
.sites-ui-field {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.sites-ui-field input {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--ink);
}
.sites-ui-footer {
  border-top: 1px solid var(--line);
  padding-block: var(--space-6);
  color: var(--ink-faint);
}
.display {
  font-size: clamp(2.75rem, 7vw, 5rem);
  line-height: 1.02;
  letter-spacing: -0.03em;
}
.hero {
  display: grid;
  gap: clamp(var(--space-6), 5vw, var(--space-8));
  align-items: center;
  grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr));
}
/* A media slot with nothing in it yet should still read as composed, not broken. */
.hero-media {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 18rem;
  border-radius: var(--radius-lg);
  background:
    radial-gradient(currentColor 1px, transparent 1px) 0 0 / 22px 22px,
    var(--accent-wash);
  color: var(--dot-grid);
  overflow: hidden;
}
.hero-media > * {
  color: var(--ink);
}
.media-frame {
  aspect-ratio: 4 / 3;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-sunken);
  overflow: hidden;
}
.media-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 99px;
  background: var(--surface-raised);
  font-size: 0.8125rem;
  color: var(--ink-soft);
}
.stat-value {
  font-family: var(--font-display);
  font-size: clamp(2rem, 4vw, 3rem);
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.stat-label {
  margin: var(--space-2) 0 0;
  font-size: 0.875rem;
  color: var(--ink-faint);
}
.prose {
  max-width: var(--measure);
}
.divider {
  height: 1px;
  margin-block: var(--space-7);
  border: 0;
  background: var(--line);
}
.wash {
  background:
    radial-gradient(60rem 30rem at 15% -10%, var(--accent-wash), transparent 60%),
    var(--surface);
}
.grid--2 {
  grid-template-columns: repeat(auto-fit, minmax(min(24rem, 100%), 1fr));
}
.link-arrow {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 550;
  text-decoration: none;
}
.link-arrow::after {
  content: "→";
}
/* Decorative colour splashes. Purely presentational: they sit behind content,
   never intercept pointer events, and fade with the theme rather than washing
   out a dark surface. */
.splash-stage {
  position: relative;
  isolation: isolate;
  overflow: hidden;
}
.splash {
  position: absolute;
  z-index: -1;
  width: clamp(18rem, 42vw, 34rem);
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, var(--splash-color), transparent 68%);
  opacity: var(--splash-strength);
  filter: blur(60px);
  pointer-events: none;
}
.splash--top-right {
  top: -12rem;
  right: -10rem;
}
.splash--bottom-left {
  bottom: -14rem;
  left: -12rem;
}
.splash--behind {
  top: 50%;
  left: 50%;
  translate: -50% -50%;
}
.splash--soft {
  opacity: calc(var(--splash-strength) * 0.55);
}
.splash--ring {
  background: none;
  border: 1px solid var(--accent);
  opacity: calc(var(--splash-strength) * 0.3);
  filter: none;
}
.theme-toggle {
  position: fixed;
  right: max(1rem, env(safe-area-inset-right, 0px));
  bottom: max(1rem, env(safe-area-inset-bottom, 0px));
  z-index: 50;
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  border: 1px solid var(--line);
  border-radius: 99px;
  background: var(--surface-raised);
  color: var(--ink-soft);
  box-shadow: var(--shadow);
  transition: color 150ms ease, border-color 150ms ease;
}
.theme-toggle:hover {
  color: var(--ink);
  border-color: var(--ink-faint);
}
.theme-toggle svg {
  width: 1.05rem;
  height: 1.05rem;
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

/**
 * Distinct but uniformly professional art directions. A single house style makes
 * every generated site look the same, which is useless as a design reference, so
 * the seed picks one deterministically: the same request always renders the same
 * direction, different requests differ in hue, warmth, shape language and type.
 */
/** Surfaces and ink shared by every direction in dark mode; accents are per-direction. */
const BASE_DARK_TOKENS = `--surface: #121211; --surface-raised: #1a1a19; --surface-sunken: #0d0d0c;
  --ink: #f2f1ee; --ink-soft: #b5b2ab; --ink-faint: #85827b; --line: #2c2c2a;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 14px 34px -22px rgba(0, 0, 0, 0.9);
  --dot-grid: rgba(255, 255, 255, 0.08); --splash-strength: 0.35;`;

export const DESIGN_DIRECTIONS: readonly {
  readonly id: string;
  readonly tokens: string;
  readonly dark: string;
}[] = [
  {
    id: "ink",
    tokens: `--accent: #1f3a5f; --accent-hover: #162c48; --accent-wash: #eef1f6;`,
    dark: `--accent: #8fb4ff; --accent-hover: #a9c6ff; --accent-ink: #0e1a2b;
  --accent-wash: rgba(143, 180, 255, 0.12);`,
  },
  {
    id: "clay",
    tokens: `--surface: #fdf9f5; --surface-sunken: #f5ede5; --line: #e8ddd1;
  --accent: #9a4a2f; --accent-hover: #7d3a23; --accent-wash: #f8ece5;
  --radius: 1rem; --radius-lg: 1.5rem;`,
    dark: `--surface: #16120f; --surface-raised: #1f1915; --surface-sunken: #100d0b; --line: #322820;
  --accent: #e2916d; --accent-hover: #eda684; --accent-ink: #2a140b;
  --accent-wash: rgba(226, 145, 109, 0.12);`,
  },
  {
    id: "forest",
    tokens: `--surface: #f8faf8; --surface-sunken: #eef3ef; --line: #dde6de;
  --accent: #1f4733; --accent-hover: #163526; --accent-wash: #e9f1ec;
  --font-display: var(--font-sans); --radius-sm: 0.25rem; --radius: 0.375rem; --radius-lg: 0.5rem;`,
    dark: `--surface: #0f1411; --surface-raised: #161d19; --surface-sunken: #0b100d; --line: #24302a;
  --accent: #7fc4a0; --accent-hover: #97d4b4; --accent-ink: #0d1f16;
  --accent-wash: rgba(127, 196, 160, 0.12);`,
  },
  {
    id: "graphite",
    tokens: `--surface: #ffffff; --surface-sunken: #f4f4f3; --line: #e2e2e0;
  --ink: #111110; --accent: #111110; --accent-hover: #000000; --accent-wash: #f0f0ef;
  --font-display: var(--font-sans); --radius-sm: 0; --radius: 0; --radius-lg: 0;
  --splash-color: #9aa8bd;`,
    dark: `--surface: #0c0c0b; --surface-raised: #151514; --surface-sunken: #080807; --line: #272725;
  --accent: #f2f1ee; --accent-hover: #ffffff; --accent-ink: #111110;
  --accent-wash: rgba(255, 255, 255, 0.08);`,
  },
  {
    id: "plum",
    tokens: `--surface: #fcfafc; --surface-sunken: #f4eef5; --line: #e7dde9;
  --accent: #4a2b52; --accent-hover: #371f3d; --accent-wash: #f3ebf5;
  --radius: 1.25rem; --radius-lg: 1.75rem;`,
    dark: `--surface: #141017; --surface-raised: #1c161f; --surface-sunken: #0e0b10; --line: #2e2533;
  --accent: #c99ad2; --accent-hover: #d9b0e0; --accent-ink: #1e1022;
  --accent-wash: rgba(201, 154, 210, 0.12);`,
  },
];

export function pickDesignDirection(seed = ""): (typeof DESIGN_DIRECTIONS)[number] {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return DESIGN_DIRECTIONS[hash % DESIGN_DIRECTIONS.length]!;
}

/**
 * Baseline stylesheet with one art direction layered over it, in both themes.
 * Initial paint stays light until the visitor selects dark; otherwise a dark OS
 * setting can change the reference layout before React mounts.
 */
export function styleSheetForSeed(seed = ""): string {
  const direction = pickDesignDirection(seed);
  const dark = `${BASE_DARK_TOKENS}\n  ${direction.dark}`;
  return `${DEFAULT_STYLES_CSS}
/* Art direction: ${direction.id} */
:root {
  ${direction.tokens}
}
:root[data-theme="dark"] {
  ${dark}
}
`;
}

/**
 * Compact contract sent to the model in place of the full stylesheet. Derived
 * from the CSS itself so the advertised surface cannot drift from reality.
 */
export function summarizeDesignSystem(css: string = DEFAULT_STYLES_CSS, referenceDriven = false): string {
  const tokens = [...new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(([, name]) => name))];
  const classes = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map(([, name]) => `.${name}`))];
  return [
    referenceDriven
      ? "Baseline design system is available in src/styles.css, but the attached visual reference takes priority. Override its typography, colors, spacing, and layout where needed to match the reference."
      : "Baseline design system already applied in src/styles.css (keep it; add a small custom stylesheet for anything extra instead of replacing it).",
    `Design tokens: ${tokens.join(", ")}.`,
    `Utility classes: ${classes.join(", ")}.`,
    referenceDriven
      ? "Recreate the reference's own typography and page rhythm, even if it differs from the baseline display serif and section styling."
      : "Compose with these tokens for color, spacing, radius, and type. Headings already use a display serif and sections already have vertical rhythm.",
  ].join("\n");
}

export const DEFAULT_APP_TSX = `export function App() {
  return (
    <div className="starter-container">
      <h1>AI Sites Local Execution Test</h1>
      <p>Starter scaffold active.</p>
    </div>
  );
}
`;

export interface ScaffoldOptions {
  projectName?: string;
  /** Selects the art direction. Same seed, same look. */
  designSeed?: string;
}

export async function scaffoldDeterministicReactVite(
  execution: ExecutionProvider,
  environmentId: string,
  options: ScaffoldOptions = {},
): Promise<{ filesScaffolded: string[] }> {
  const existingFiles = new Set(
    (await execution.listFiles(environmentId)).filter((f) => f.type === "FILE").map((f) => f.path),
  );

  const filesScaffolded: string[] = [];

  const ensureFile = async (path: string, defaultContent: string) => {
    if (!existingFiles.has(path)) {
      await execution.writeFile(environmentId, path, defaultContent);
      filesScaffolded.push(path);
    }
  };

  const indexHtml = options.projectName
    ? DEFAULT_INDEX_HTML.replace(
        "<title>AI Generated Site</title>",
        `<title>${options.projectName}</title>`,
      )
    : DEFAULT_INDEX_HTML;

  // Sites owns these outright. A starter template that ships its own copy must
  // not silently replace them, and the stylesheet varies per request.
  const writeOwned = async (path: string, content: string) => {
    await execution.writeFile(environmentId, path, content);
    if (!existingFiles.has(path)) filesScaffolded.push(path);
  };

  // package.json stays paired with the template's lockfile for `npm ci`.
  await ensureFile("package.json", DEFAULT_PACKAGE_JSON);
  await writeOwned("vite.config.ts", DEFAULT_VITE_CONFIG);
  await writeOwned("tsconfig.json", DEFAULT_TSCONFIG);
  await writeOwned("index.html", indexHtml);
  await writeOwned("src/main.tsx", DEFAULT_MAIN_TSX);
  await writeOwned("src/vite-env.d.ts", DEFAULT_VITE_ENV_D_TS);
  await writeOwned("src/styles.css", styleSheetForSeed(options.designSeed ?? options.projectName));
  await ensureFile("src/App.tsx", DEFAULT_APP_TSX);

  return { filesScaffolded };
}
