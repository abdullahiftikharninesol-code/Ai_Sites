import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tests/fixtures/**",
      ".sites-runtime/**",
      "web/dist/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/consistent-type-imports": "error" },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: [
      "src/agents/mock-agent-provider.ts",
      "src/execution/mock-execution-provider.ts",
      "src/persistence/in-memory-repositories.ts",
      "src/planning/planning.ts",
    ],
    rules: { "@typescript-eslint/require-await": "off" },
  },
);
