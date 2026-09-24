import type { Config } from "tailwindcss";

const config: Config = {
  content: {
    relative: true,
    files: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./src/**/*.{js,ts,jsx,tsx,mdx}"],
  },
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        gc: {
          page: "var(--gc-page)",
          surface: "var(--gc-surface)",
          elevated: "var(--gc-surface-elevated)",
          border: "var(--gc-border)",
          text: "var(--gc-text-primary)",
          muted: "var(--gc-text-muted)",
          accent: "var(--gc-accent)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
