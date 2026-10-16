import { copyFile, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "previews",
]);
const EXCLUDED_FILES = new Set([".DS_Store", "template.zip"]);

export interface ValidatedTemplateSource {
  readonly directory: string;
  readonly packageFiles: readonly string[];
}

function unsafe(message: string, cause?: unknown): ApplicationError {
  return new ApplicationError(
    "UNSAFE_TEMPLATE_SOURCE",
    message,
    cause === undefined ? {} : { cause },
  );
}

function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /^service-account.*\.json$/i.test(name) ||
    /^credentials.*\.json$/i.test(name) ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key")
  );
}

function safeRelative(root: string, target: string): string {
  const value = relative(root, target);
  if (!value || value === ".") return "";
  if (value.startsWith(`..${sep}`) || value === ".." || isAbsolute(value))
    throw unsafe("Template source traversal escaped the template root");
  return value.split(sep).join("/");
}

async function walkSource(root: string, directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const info = await lstat(absolute);
    const relativePath = safeRelative(root, absolute);
    if (info.isSymbolicLink()) throw unsafe(`Symbolic links are not allowed: ${relativePath}`);
    if (isSecretFile(entry.name)) throw unsafe(`Private file is not allowed: ${relativePath}`);
    if (info.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walkSource(root, absolute, files);
      continue;
    }
    if (!info.isFile()) throw unsafe(`Unsupported source entry: ${relativePath}`);
    if (!EXCLUDED_FILES.has(entry.name)) files.push(relativePath);
  }
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch (error) {
    throw new ApplicationError("MANIFEST_INVALID", `${label} is required`, { cause: error });
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new ApplicationError("MANIFEST_INVALID", `${label} directory is required`, {
      cause: error,
    });
  }
}

export async function validateTemplateSource(directory: string): Promise<ValidatedTemplateSource> {
  const root = resolve(directory);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw new ApplicationError("MANIFEST_INVALID", "Template directory does not exist", {
      cause: error,
    });
  }
  if (rootInfo.isSymbolicLink()) throw unsafe("Template root must not be a symbolic link");
  if (!rootInfo.isDirectory())
    throw new ApplicationError("MANIFEST_INVALID", "Template path must be a directory");
  await requireFile(join(root, "site-template.json"), "site-template.json");
  await requireFile(join(root, "package.json"), "package.json");
  await requireDirectory(join(root, "src"), "src");
  const packageFiles: string[] = [];
  await walkSource(root, root, packageFiles);
  return { directory: root, packageFiles };
}

export async function copyCleanTemplateSource(
  source: ValidatedTemplateSource,
  destination: string,
): Promise<void> {
  for (const relativePath of source.packageFiles) {
    const target = join(destination, ...relativePath.split("/"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(join(source.directory, ...relativePath.split("/")), target);
  }
}
