import type { ExecutionProvider } from "../../execution/execution-provider.js";

export const DEFAULT_PACKAGE_JSON = JSON.stringify(
  {
    name: "react-vite-site",
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: {
      dev: "vite",
      build: "tsc -b && vite build",
      preview: "vite preview",
    },
    dependencies: {
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    devDependencies: {
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      "@vitejs/plugin-react": "^4.3.4",
      typescript: "^5.7.3",
      vite: "^6.2.0",
    },
  },
  null,
  2,
);

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
      noUnusedLocals: true,
      noUnusedParameters: true,
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

export const DEFAULT_MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

export const DEFAULT_VITE_ENV_D_TS = `/// <reference types="vite/client" />
`;

export const DEFAULT_STYLES_CSS = `* {
  box-sizing: border-box;
}
:root {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  line-height: 1.5;
  color: #111827;
  background-color: #ffffff;
}
body {
  margin: 0;
  min-height: 100vh;
}
`;

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
}

export async function scaffoldDeterministicReactVite(
  execution: ExecutionProvider,
  environmentId: string,
  options: ScaffoldOptions = {},
): Promise<{ filesScaffolded: string[] }> {
  const existingFiles = new Set(
    (await execution.listFiles(environmentId))
      .filter((f) => f.type === "FILE")
      .map((f) => f.path),
  );

  const filesScaffolded: string[] = [];

  const ensureFile = async (path: string, defaultContent: string) => {
    if (!existingFiles.has(path)) {
      await execution.writeFile(environmentId, path, defaultContent);
      filesScaffolded.push(path);
    }
  };

  const indexHtml = options.projectName
    ? DEFAULT_INDEX_HTML.replace("<title>AI Generated Site</title>", `<title>${options.projectName}</title>`)
    : DEFAULT_INDEX_HTML;

  await ensureFile("package.json", DEFAULT_PACKAGE_JSON);
  await ensureFile("vite.config.ts", DEFAULT_VITE_CONFIG);
  await ensureFile("tsconfig.json", DEFAULT_TSCONFIG);
  await ensureFile("index.html", indexHtml);
  await ensureFile("src/main.tsx", DEFAULT_MAIN_TSX);
  await ensureFile("src/vite-env.d.ts", DEFAULT_VITE_ENV_D_TS);
  await ensureFile("src/styles.css", DEFAULT_STYLES_CSS);
  await ensureFile("src/App.tsx", DEFAULT_APP_TSX);

  return { filesScaffolded };
}
