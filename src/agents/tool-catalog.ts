import type { AgentToolDefinition, AgentToolName } from "./agent-types.js";

const objectSchema = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = (description: string) => ({ type: "string", description });

export const SITES_AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "list_files",
    description: "List files below a project-relative directory.",
    inputSchema: objectSchema(
      { path: { type: ["string", "null"], description: "Directory or null for project root." } },
      ["path"],
    ),
  },
  {
    name: "read_file",
    description:
      "Read one project-relative file. Set encoding to 'base64' to read a binary file (image, font, etc.) without corrupting it; omit it, or use 'utf8', for text files.",
    inputSchema: objectSchema(
      {
        path: string("Project-relative file path."),
        encoding: string("'utf8' (default) or 'base64' for binary files."),
      },
      ["path"],
    ),
  },
  {
    name: "write_file",
    description:
      "Create or replace one project-relative file. Set encoding to 'base64' and provide base64-encoded content for binary files (images, fonts, etc.); omit it, or use 'utf8', for text files.",
    inputSchema: objectSchema(
      {
        path: string("Project-relative file path."),
        content: string("Complete file content: raw text, or base64 when encoding is 'base64'."),
        encoding: string("'utf8' (default) or 'base64' for binary files."),
      },
      ["path", "content"],
    ),
  },
  {
    name: "apply_patch",
    description: "Replace one exact text occurrence in an existing file.",
    inputSchema: objectSchema(
      {
        path: string("Project-relative file path."),
        find: string("Exact existing text."),
        replace: string("Replacement text."),
      },
      ["path", "find", "replace"],
    ),
  },
  {
    name: "search_files",
    description: "Find project text files containing an exact query.",
    inputSchema: objectSchema({ query: string("Exact text query.") }, ["query"]),
  },
  {
    name: "run_build",
    description: "Run the controlled project build and return structured output.",
    inputSchema: objectSchema({}, []),
  },
  {
    name: "start_preview",
    description: "Start the controlled project preview on a requested port.",
    inputSchema: objectSchema({ port: { type: "number", description: "Preview port." } }, ["port"]),
  },
  {
    name: "read_logs",
    description: "Read available controlled execution logs.",
    inputSchema: objectSchema({}, []),
  },
] as const;

export function createFinalizeGenerationTool(requirements?: {
  readonly requiredPages?: readonly string[] | undefined;
  readonly requiredSections?: readonly string[] | undefined;
}): AgentToolDefinition {
  const pageEnum = requirements?.requiredPages?.length
    ? { enum: [...requirements.requiredPages] }
    : {};
  const sectionEnum = requirements?.requiredSections?.length
    ? { enum: [...requirements.requiredSections] }
    : {};

  return {
    name: "finalize_generation",
    description:
      "Claim completion of the initial website generation after implementing all required files, pages, sections, and structural markers. Must include the completion manifest.",
    inputSchema: objectSchema(
      {
        filesImplemented: {
          type: "array",
          items: { type: "string" },
          description: "List of project-relative file paths created or updated (e.g. ['src/App.tsx', 'src/styles.css']).",
        },
        pagesImplemented: {
          type: "array",
          items: { type: "string", ...pageEnum },
          description: "List of canonical page identifiers implemented.",
        },
        sectionsImplemented: {
          type: "array",
          items: { type: "string", ...sectionEnum },
          description: "List of canonical section identifiers implemented.",
        },
        navigationImplemented: {
          type: "boolean",
          description: "Whether navigation between pages/sections is implemented.",
        },
        responsiveImplementationCompleted: {
          type: "boolean",
          description: "Whether responsive styles for mobile, tablet, and desktop are completed.",
        },
      },
      [
        "filesImplemented",
        "pagesImplemented",
        "sectionsImplemented",
        "navigationImplemented",
        "responsiveImplementationCompleted",
      ],
    ),
  };
}

export function getStageAgentTools(
  stage?: string | undefined,
  requirements?: {
    readonly requiredPages?: readonly string[] | undefined;
    readonly requiredSections?: readonly string[] | undefined;
  } | undefined,
): readonly AgentToolDefinition[] {
  const toolMap = new Map(SITES_AGENT_TOOLS.map((tool) => [tool.name, tool]));

  if (stage === "SITE_PLANNING" || stage === "EDIT_PLANNING") {
    return [];
  }

  if (stage === "GENERATE_SITE") {
    return [
      toolMap.get("write_file")!,
      toolMap.get("read_file")!,
      toolMap.get("apply_patch")!,
      createFinalizeGenerationTool(requirements),
    ];
  }

  if (stage === "BUILD_REPAIR" || stage === "VISUAL_REPAIR") {
    return [
      toolMap.get("read_file")!,
      toolMap.get("write_file")!,
      toolMap.get("apply_patch")!,
      toolMap.get("search_files")!,
    ];
  }

  if (stage === "TARGETED_EDIT") {
    return [
      toolMap.get("read_file")!,
      toolMap.get("write_file")!,
      toolMap.get("apply_patch")!,
      toolMap.get("search_files")!,
      toolMap.get("list_files")!,
    ];
  }

  return SITES_AGENT_TOOLS;
}

const toolsByName = new Map(SITES_AGENT_TOOLS.map((tool) => [tool.name, tool]));
export function isApprovedAgentTool(name: string): name is AgentToolName {
  return toolsByName.has(name as AgentToolName) || name === "finalize_generation";
}

export function validateToolArguments(
  name: AgentToolName,
  args: unknown,
): Readonly<Record<string, unknown>> {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Tool arguments must be an object");
  const value = args as Record<string, unknown>;

  if (name === "finalize_generation") {
    const requiredKeys = [
      "filesImplemented",
      "pagesImplemented",
      "sectionsImplemented",
      "navigationImplemented",
      "responsiveImplementationCompleted",
    ];
    for (const key of requiredKeys) {
      if (!(key in value)) {
        throw new Error(`Tool argument '${key}' is required for finalize_generation`);
      }
    }
    for (const key of Object.keys(value)) {
      if (!requiredKeys.includes(key)) {
        throw new Error(`Unexpected tool argument '${key}'`);
      }
    }
    if (!Array.isArray(value["filesImplemented"]) || !value["filesImplemented"].every((x) => typeof x === "string")) {
      throw new Error("Tool argument 'filesImplemented' must be an array of strings");
    }
    if (!Array.isArray(value["pagesImplemented"]) || !value["pagesImplemented"].every((x) => typeof x === "string")) {
      throw new Error("Tool argument 'pagesImplemented' must be an array of strings");
    }
    if (!Array.isArray(value["sectionsImplemented"]) || !value["sectionsImplemented"].every((x) => typeof x === "string")) {
      throw new Error("Tool argument 'sectionsImplemented' must be an array of strings");
    }
    if (typeof value["navigationImplemented"] !== "boolean") {
      throw new Error("Tool argument 'navigationImplemented' must be boolean");
    }
    if (typeof value["responsiveImplementationCompleted"] !== "boolean") {
      throw new Error("Tool argument 'responsiveImplementationCompleted' must be boolean");
    }
    return value;
  }

  type ArgType = "string" | "number" | "nullable-string" | "optional-string";
  const allowed: Partial<Record<AgentToolName, Readonly<Record<string, ArgType>>>> = {
    list_files: { path: "nullable-string" },
    read_file: { path: "string", encoding: "optional-string" },
    write_file: { path: "string", content: "string", encoding: "optional-string" },
    apply_patch: { path: "string", find: "string", replace: "string" },
    search_files: { query: "string" },
    run_build: {},
    start_preview: { port: "number" },
    read_logs: {},
  };
  const shape = allowed[name];
  if (!shape) throw new Error(`Tool '${name}' is not available to the Sites agent`);
  for (const key of Object.keys(value))
    if (!(key in shape)) throw new Error(`Unexpected tool argument '${key}'`);
  for (const [key, type] of Object.entries(shape)) {
    if (type === "optional-string" && !(key in value)) continue;
    const item = value[key];
    if (
      type === "nullable-string"
        ? item !== null && typeof item !== "string"
        : type === "optional-string"
          ? typeof item !== "string"
          : typeof item !== type
    )
      throw new Error(`Tool argument '${key}' must be ${type}`);
  }
  return value;
}
