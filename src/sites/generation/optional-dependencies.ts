import { ApplicationError } from "../../app/errors/application-error.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { collectImportedPackageRoots } from "./import-validator.js";

export interface ApprovedUiPackage {
  readonly name: string;
  /** Exact version: the dependency policy forbids ranges. */
  readonly version: string;
  readonly purpose: string;
}

/**
 * Optional, approved UI packages. They are never preinstalled: a generated site
 * receives one only when its own source imports it, so a site that uses none
 * installs and builds exactly as it did before these were approved.
 */
export const APPROVED_UI_PACKAGES: readonly ApprovedUiPackage[] = [
  { name: "lucide-react", version: "1.47.0", purpose: "interface icons" },
  { name: "radix-ui", version: "1.6.7", purpose: "accessible interactive primitives" },
  { name: "recharts", version: "3.10.1", purpose: "data visualisation" },
  { name: "sonner", version: "2.0.8", purpose: "transient action feedback" },
];

export const APPROVED_UI_PACKAGE_VERSIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(APPROVED_UI_PACKAGES.map((entry) => [entry.name, entry.version])),
);

export interface OptionalDependencyResult {
  readonly added: readonly string[];
}

/**
 * Adds the approved packages the generated source actually imports to the
 * project's package.json. The platform owns package.json, so the model never
 * writes dependencies itself. Returns the packages added, empty when the site
 * uses none — in which case nothing is written and no install is required.
 */
export async function materializeOptionalDependencies(
  execution: Pick<ExecutionProvider, "listFiles" | "readFile" | "writeFile">,
  environmentId: string,
  approved: Readonly<Record<string, string>> = APPROVED_UI_PACKAGE_VERSIONS,
): Promise<OptionalDependencyResult> {
  const imported = await collectImportedPackageRoots(execution as ExecutionProvider, environmentId);
  const used = Object.keys(approved)
    .filter((name) => imported.has(name))
    .sort();
  if (!used.length) return { added: [] };

  const raw = await execution.readFile(environmentId, "package.json");
  let manifest: { dependencies?: Record<string, string> } & Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch (cause) {
    throw new ApplicationError("PACKAGE_MANIFEST_MISMATCH", "Generated package.json is not valid JSON", {
      cause,
    });
  }

  const dependencies = { ...(manifest.dependencies ?? {}) };
  const added: string[] = [];
  for (const name of used) {
    if (dependencies[name] === approved[name]) continue;
    dependencies[name] = approved[name]!;
    added.push(name);
  }
  if (!added.length) return { added: [] };

  const next = { ...manifest, dependencies: sortKeys(dependencies) };
  await execution.writeFile(environmentId, "package.json", `${JSON.stringify(next, null, 2)}\n`);
  return { added };
}

function sortKeys(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
