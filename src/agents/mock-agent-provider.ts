import type { AgentProvider } from "./agent-provider.js";
import type { AgentRequest, AgentResponse, AgentToolCall } from "./agent-types.js";
import { measureProviderBoundary } from "./shared/provider-boundary-telemetry.js";

export interface MockAgentProviderOptions {
  readonly generateBrokenSource?: boolean | undefined;
  readonly endlessRepair?: boolean | undefined;
  readonly localCliScenario?: boolean | undefined;
  readonly visualQaScenario?: boolean | undefined;
  readonly securityScenario?: boolean | undefined;
  readonly skipFinalize?: boolean | undefined;
  readonly omitStyles?: boolean | undefined;
  readonly omitMarkers?: boolean | undefined;
  readonly omitPagesInManifest?: boolean | undefined;
  readonly omitSectionsInManifest?: boolean | undefined;
  readonly customResponse?: ((request: AgentRequest) => Promise<AgentResponse> | AgentResponse) | undefined;
  readonly fencedJsonResponse?: boolean | undefined;
  readonly malformedJsonResponse?: boolean | undefined;
  readonly proseJsonResponse?: boolean | undefined;
  readonly emptyResponse?: boolean | undefined;
}
export class MockAgentProvider implements AgentProvider {
  readonly id = "mock-agent";
  readonly #options: MockAgentProviderOptions;
  #responseId = 1;
  #callsCount = 0;
  constructor(options: MockAgentProviderOptions = {}) {
    this.#options = options;
  }
  get callCount(): number {
    return this.#callsCount;
  }
  getCapabilities() {
    return {
      models: ["mock-sites-v1"],
      text: true,
      tools: true,
      vision: true,
      toolCalling: true,
      streaming: false,
      cachedInput: true,
      structuredOutput: true,
      structuredOutputCapability: "NATIVE_SCHEMA" as const,
      maxInputTokens: 8_000,
    };
  }
  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    await request.transportHook?.beforePhysicalAttempt(0);
    this.#callsCount += 1;
    if (this.#options.customResponse) {
      const resp = await this.#options.customResponse(request);
      await request.transportHook?.afterPhysicalAttempt?.(0, undefined, resp);
      return resp;
    }
    const last = request.messages.at(-1);
    const text = last?.content ?? "";
    const task = request.systemInstructions?.match(/SITES_AGENT_TASK:([A-Z_]+)/)?.[1];
    if (task) {
      const resp = this.#intelligenceResponse(request, task, text);
      await request.transportHook?.afterPhysicalAttempt?.(0, undefined, resp);
      return resp;
    }
    let calls: AgentToolCall[] = [];
    const fullText = request.messages.map((m) => m.content).join("\n");
    const hasFinalizeTool = request.tools?.some((t) => t.name === "finalize_generation");
    if (this.#options.localCliScenario) calls = this.#localCliCalls(request);
    else if (
      (hasFinalizeTool || request.messages.some((m) => m.content.includes("finalize_generation"))) &&
      !text.includes("Operation: REPAIR") &&
      !text.includes("Operation: EDIT")
    ) {
      const pages = this.#extractPages(fullText);
      const sections = this.#extractSections(fullText);
      const pageElements = pages
        .map(
          (p) =>
            `<main data-sites-page="${p}" className="hero">${sections.map((s) => `<section data-sites-section="${s}"><h1>AI Sites Generated Hero</h1><p>Welcome to our modern website.</p></section>`).join("")}</main>`,
        )
        .join("");

      const appContent = this.#options.generateBrokenSource
        ? `import "./missing-module";\nexport function App() { return <div className="app">${pageElements}</div>; }\n`
        : `export function App() { return <div className="app">${pageElements}</div>; }\n`;

      const generatedCalls: AgentToolCall[] = [
        {
          id: "mock-write-app",
          name: "write_file",
          arguments: {
            path: "src/App.tsx",
            content: this.#options.omitMarkers
              ? 'export function App() { return <main className="hero"><h1>AI Sites Generated Hero</h1><p>Welcome to our modern website.</p></main>; }\n'
              : appContent,
          },
        },
      ];

      if (!this.#options.omitStyles) {
        generatedCalls.push({
          id: "mock-write-style",
          name: "write_file",
          arguments: {
            path: "src/styles.css",
            content: ':root { font-family: system-ui; }\nbody { margin: 0; }\n.hero { padding: 2rem; }\n',
          },
        });
      }

      if (!this.#options.skipFinalize) {
        generatedCalls.push({
          id: "mock-finalize",
          name: "finalize_generation",
          arguments: {
            filesImplemented: [
              "src/App.tsx",
              ...(!this.#options.omitStyles ? ["src/styles.css"] : []),
            ],
            pagesImplemented: this.#options.omitPagesInManifest ? [] : pages,
            sectionsImplemented: this.#options.omitSectionsInManifest ? [] : sections,
            navigationImplemented: pages.length > 1,
            responsiveImplementationCompleted: true,
          },
        });
      }

      calls = generatedCalls;
    }
    else if (
      last?.role === "user" &&
      text.includes("Operation: REPAIR") &&
      (text.includes("Inspect the referenced files") || text.includes("missing-module") || text.includes("src/App.tsx"))
    )
      calls = [
        {
          id: "mock-repair-app",
          name: "write_file",
          arguments: {
            path: "src/App.tsx",
            content: 'export function App() { return <main className="hero"><h1>AI Sites Generated Hero</h1><p>Welcome to our modern website.</p></main>; }\n',
          },
        },
      ];
    else if (
      last?.role === "user" &&
      (text.startsWith("GENERATE:") || text.includes("Operation: GENERATE"))
    )
      calls = this.#generationCalls();
    else if (
      last?.role === "user" &&
      (text.startsWith("EDIT:") || text.includes("Operation: EDIT"))
    )
      calls = text.includes("src/App.tsx")
        ? [
            {
              id: "edit-react-app",
              name: "apply_patch",
              arguments: {
                path: "src/App.tsx",
                find: "AI Sites Generated Hero",
                replace: "AI Sites Updated Hero",
              },
            },
          ]
        : [
            {
              id: "edit-app",
              name: "apply_patch",
              arguments: { path: "src/app.ts", find: "Welcome", replace: "Updated heading" },
            },
          ];
    else if (
      last?.role === "user" &&
      (text.startsWith("BUILD_FAILED:") || text.includes("Operation: REPAIR"))
    )
      calls = this.#options.endlessRepair
        ? []
        : [
            {
              id: "repair-app",
              name: "apply_patch",
              arguments: { path: "src/app.ts", find: "BROKEN", replace: "fixed" },
            },
          ];
    const resultResponse: AgentResponse = {
      id: `mock-response-${this.#responseId++}`,
      model: request.model,
      message: {
        role: "assistant",
        content: calls.length ? "Applying deterministic fixture operations." : "Done.",
      },
      toolCalls: calls,
      usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 },
      latencyMs: 2,
      finishReason: calls.length ? "tool_calls" : "stop",
    };
    await request.transportHook?.afterPhysicalAttempt?.(0, undefined, resultResponse);
    return resultResponse;
  }
  #intelligenceResponse(request: AgentRequest, task: string, text: string): AgentResponse {
    const normalized = text.toLowerCase();
    const auth =
      !/without login|no login|without forms or login/.test(normalized) &&
      /login|signup|member|protected/.test(normalized);
    const runtime =
      !/without forms|no forms/.test(normalized) &&
      /form|reservation|contact|database|member/.test(normalized);
    const content = (() => {
      if (task === "INTENT_CLASSIFICATION")
        return {
          intent: /edit|change|update/.test(normalized) ? "EDIT_SITE" : "CREATE_SITE",
          confidence: 0.99,
          reason: "Deterministic mock classification",
        };
      if (task === "TARGETED_EDIT")
        return {
          requestedChanges: [text.slice(0, 500)],
          mustPreserve: ["runtime", "auth", "integrations", "unrequested content"],
          likelyAffectedAreas: [/hero|heading/.test(normalized) ? "hero" : "requested component"],
          mutations: { runtime: false, auth: false, integration: false },
        };
      if (task === "VISUAL_REVIEW")
        return {
          overallAssessment: "Mock visual review agrees with deterministic QA.",
          issues: [],
          repairRecommended: false,
        };
      const isDental = /clinic|dental/.test(normalized);
      const siteType = /portfolio/.test(normalized) ? "portfolio" : isDental ? "clinic" : "business";
      const pages = isDental
        ? [
            { name: "Home", path: "/", purpose: "Primary landing page" },
            { name: "Services", path: "/services", purpose: "Our dental services" },
            { name: "About", path: "/about", purpose: "About our dental clinic" },
            { name: "Contact", path: "/contact", purpose: "Contact and appointment booking" },
          ]
        : [{ name: "Home", path: "/", purpose: "Primary landing page" }];
      return {
        intent: {
          type: /edit|change|update/.test(normalized) ? "EDIT_SITE" : "CREATE_SITE",
          confidence: 0.99,
          reason: "Deterministic mock classification",
        },
        site: {
          category: siteType,
          name: isDental ? "Modern Dental Clinic" : "Build something remarkable",
          purpose: isDental
            ? "Comprehensive dental health services for patients of all ages."
            : "A clear and useful experience designed for real visitors.",
          targetAudience: isDental ? "Patients and families" : "General audience",
        },
        implementation: {
          framework: "react-vite",
          language: "typescript",
          stylingStrategy: "plain-css",
        },
        requirements: {
          siteType,
          pages,
          features: [
            ...(runtime ? ["contact form"] : ["static content"]),
            ...(auth ? ["site authentication", "protected dashboard"] : []),
          ],
          responsiveRequirements: ["mobile", "tablet", "desktop"],
          contentRequirements: ["clear heading", "supporting copy", "primary action"],
          sections: ["hero", "features", "contact"],
        },
        design: {
          style: "modern",
          theme: "light",
          colors: { primary: "#2563eb", background: "#ffffff", text: "#111827" },
          typography: { heading: "system-ui", body: "system-ui" },
          spacing: { section: "4rem", content: "1.5rem" },
          layoutDirection: "LTR",
          responsiveStrategy: "mobile-first",
        },
        capabilities: {
          runtime: runtime
            ? {
                enabled: true,
                collections: [
                  {
                    name: "contact_submissions",
                    fields: [
                      { name: "name", type: "string", required: true },
                      { name: "email", type: "email", required: true },
                      { name: "message", type: "text", required: true },
                    ],
                    access: { public: { create: true, read: false, update: false, delete: false } },
                  },
                ],
              }
            : { enabled: false, collections: [] },
          auth: {
            authRequired: auth,
            publicPages: ["/"],
            protectedPages: auth ? ["/dashboard"] : [],
            capabilities: auth ? ["SIGNUP", "LOGIN", "LOGOUT"] : [],
            ownerCollections: [],
          },
          integrations: { actions: [] },
        },
        content: {
          headline: "Build something remarkable",
          subheading: "A clear and useful experience designed for real visitors.",
          primaryCta: "Get started",
          sectionCopy: { hero: "Confident, concise introductory copy." },
          faq: [],
        },
      };
    })();
    let messageContent = JSON.stringify(content);
    if (this.#options.emptyResponse) {
      messageContent = "";
    } else if (this.#options.malformedJsonResponse) {
      messageContent = '{"site": {"name": ';
    } else if (this.#options.proseJsonResponse) {
      messageContent = `Here is your plan:\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\`\nHope this helps.`;
    } else if (this.#options.fencedJsonResponse) {
      messageContent = `\`\`\`json\n${JSON.stringify(content)}\n\`\`\``;
    }
    const boundaryTelemetry = measureProviderBoundary({
      systemInstruction: request.systemInstructions,
      contents: request.messages,
      tools: request.tools,
      responseSchema:
        request.responseContract?.type === "JSON_SCHEMA"
          ? request.responseContract.schema
          : undefined,
    });
    return {
      id: `mock-response-${this.#responseId++}`,
      model: request.model,
      message: { role: "assistant", content: messageContent },
      toolCalls: [],
      usage: { inputTokens: 24, cachedInputTokens: 4, outputTokens: 18 },
      latencyMs: 2,
      finishReason: "stop",
      providerBoundaryTelemetry: boundaryTelemetry,
      ...(request.responseContract?.type === "JSON_SCHEMA"
        ? {
            structuredOutputTelemetry: {
              responseContractType: "JSON_SCHEMA" as const,
              structuredOutputMode: "NATIVE_SCHEMA" as const,
              structuredOutputValidated: true,
              fallbackParserUsed: Boolean(this.#options.fencedJsonResponse),
            },
          }
        : {}),
    };
  }
  #localCliCalls(request: AgentRequest): AgentToolCall[] {
    const last = request.messages.at(-1);
    const text = last?.content ?? "";
    if (last?.role === "user" && text.includes("Operation: GENERATE"))
      return [
        {
          id: "cli-write-broken",
          name: "write_file",
          arguments: {
            path: "src/App.tsx",
            content: this.#options.visualQaScenario
              ? 'import "./missing-module";\nexport function App() { return <main className="visual-qa-hero"><h1>AI Sites Generated Hero</h1></main>; }\n'
              : 'import "./missing-module";\nexport function App() { return <main><h1>AI Sites Generated Hero</h1></main>; }\n',
          },
        },
        ...(this.#options.visualQaScenario
          ? [
              {
                id: "cli-visual-broken",
                name: "write_file",
                arguments: {
                  path: "src/styles.css",
                  content:
                    ":root { font-family: system-ui; }\nbody { margin: 0; }\n.visual-qa-hero { width: 1200px; padding: 2rem; }\n",
                },
              } satisfies AgentToolCall,
            ]
          : []),
        { id: "cli-build-broken", name: "run_build", arguments: {} },
      ];
    if (last?.role === "tool" && last.toolCallId === "cli-build-broken")
      return [
        {
          id: "cli-repair",
          name: "apply_patch",
          arguments: { path: "src/App.tsx", find: 'import "./missing-module";\n', replace: "" },
        },
        { id: "cli-build-fixed", name: "run_build", arguments: {} },
      ];
    if (last?.role === "tool" && last.toolCallId === "cli-build-fixed")
      return [{ id: "cli-preview", name: "start_preview", arguments: { port: 0 } }];
    if (last?.role === "user" && text.includes("Operation: REPAIR"))
      return [
        {
          id: "cli-repair-broken",
          name: "apply_patch",
          arguments: { path: "src/App.tsx", find: 'import "./missing-module";\n', replace: "" },
        },
      ];
    if (
      last?.role === "user" &&
      text.includes("Operation: EDIT") &&
      text.includes("[VISUAL_REPAIR]")
    )
      return [
        {
          id: "cli-visual-repair",
          name: "apply_patch",
          arguments: {
            path: "src/styles.css",
            find: ".visual-qa-hero { width: 1200px; padding: 2rem; }",
            replace:
              ".visual-qa-hero { width: auto; max-width: 1200px; padding: clamp(1rem, 5vw, 2rem); }",
          },
        },
        { id: "cli-visual-build", name: "run_build", arguments: {} },
      ];
    if (last?.role === "tool" && last.toolCallId === "cli-visual-build")
      return [{ id: "cli-visual-preview", name: "start_preview", arguments: { port: 0 } }];
    if (last?.role === "user" && text.includes("Operation: EDIT"))
      return [
        {
          id: "cli-edit",
          name: "apply_patch",
          arguments: {
            path: "src/App.tsx",
            find: "AI Sites Generated Hero",
            replace: "AI Sites Updated Hero",
          },
        },
        { id: "cli-edit-build", name: "run_build", arguments: {} },
      ];
    if (last?.role === "tool" && last.toolCallId === "cli-edit-build")
      return [{ id: "cli-edit-preview", name: "start_preview", arguments: { port: 0 } }];
    return [];
  }
  #generationCalls(): AgentToolCall[] {
    const marker = this.#options.generateBrokenSource ? " BROKEN" : "";
    return [
      {
        id: "write-package",
        name: "write_file",
        arguments: { path: "package.json", content: '{"scripts":{"build":"mock"}}' },
      },
      {
        id: "write-main",
        name: "write_file",
        arguments: { path: "src/main.ts", content: 'import { render } from "./app.js"; render();' },
      },
      {
        id: "write-app",
        name: "write_file",
        arguments: {
          path: "src/app.ts",
          content: this.#options.securityScenario
            ? `export async function render(){const me=await window.sites.auth.me().catch(()=>undefined);document.body.innerHTML=me?'<main><h1>Member notes dashboard</h1><button id="weather">Weather</button></main>':'<main><h1>Login</h1><form aria-label="Sign in"></form></main>';if(me)document.querySelector('#weather')?.addEventListener('click',()=>window.sites.actions.execute('weather',{city:'Lahore'}));}${marker}`
            : `export function render() { document.body.innerHTML = "<h1>Welcome</h1>"; }${marker}`,
        },
      },
      {
        id: "write-style",
        name: "write_file",
        arguments: { path: "src/styles.css", content: "body { font-family: system-ui; }" },
      },
    ];
  }
  #extractPages(text: string): string[] {
    const requiredPagesMatch = text.match(/Required pages:\s*([^\n]+)/);
    if (requiredPagesMatch?.[1]) {
      return requiredPagesMatch[1].split(",").map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter(Boolean);
    }
    const specMatch = text.match(/SiteSpec:\s*(\{.*\})/);
    if (specMatch?.[1]) {
      try {
        const spec = JSON.parse(specMatch[1]);
        if (Array.isArray(spec.requirements?.pages) && spec.requirements.pages.length > 0) {
          return spec.requirements.pages.map((p: any) =>
            String(p.name || p.path || "home").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          );
        }
      } catch {}
    }
    return ["home"];
  }
  #extractSections(text: string): string[] {
    const requiredSectionsMatch = text.match(/Required sections:\s*([^\n]+)/);
    if (requiredSectionsMatch?.[1]) {
      return requiredSectionsMatch[1].split(",").map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter(Boolean);
    }
    const specMatch = text.match(/SiteSpec:\s*(\{.*\})/);
    if (specMatch?.[1]) {
      try {
        const spec = JSON.parse(specMatch[1]);
        if (spec.content?.sectionCopy) {
          const keys = Object.keys(spec.content.sectionCopy);
          if (keys.length > 0) return keys.map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"));
        }
        if (Array.isArray(spec.requirements?.features) && spec.requirements.features.length > 0) {
          return spec.requirements.features.map((s: any) =>
            String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          );
        }
      } catch {}
    }
    return ["hero"];
  }
}
