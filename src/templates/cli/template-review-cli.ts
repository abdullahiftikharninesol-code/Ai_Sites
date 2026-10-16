import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApplicationError } from "../../app/errors/application-error.js";
import { PlaywrightTemplateBrowserQA } from "../publishing/template-browser-qa.js";
import { TrustedInternalTemplateBuildRunner } from "../publishing/template-build.js";
import { loadTemplateManifest } from "../publishing/template-manifest.js";
import {
  copyCleanTemplateSource,
  validateTemplateSource,
} from "../publishing/template-source.js";

interface ReviewOptions {
  readonly directory: string;
  readonly output: string;
}

function parseArguments(args: readonly string[]): ReviewOptions {
  let directory: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--dir") {
      directory = args[index + 1];
      index++;
      continue;
    }
    if (value === "--out") {
      output = args[index + 1];
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${value ?? ""}`);
  }
  if (!directory) throw new Error("--dir is required");
  if (!output) throw new Error("--out is required");
  return { directory: resolve(directory), output: resolve(output) };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sites-template-review-"));
  try {
    const manifest = await loadTemplateManifest(options.directory);
    const source = await validateTemplateSource(options.directory);
    const buildDirectory = join(temporaryRoot, "source");
    await mkdir(buildDirectory, { recursive: true });
    await mkdir(options.output, { recursive: true });
    await copyCleanTemplateSource(source, buildDirectory);
    await new TrustedInternalTemplateBuildRunner().build(buildDirectory);
    const result = await new PlaywrightTemplateBrowserQA().run({
      buildDirectory,
      routes: manifest.routes.map(({ path }) => path),
      previewDirectory: options.output,
    });
    console.info(`Template review:\n${manifest.templateKey}`);
    console.info(`\nBrowser QA:\n${result.report.status}`);
    console.info(`\nRoutes checked:\n${result.routesChecked}`);
    console.info(`\nOutput:\n${options.output}`);
    for (const name of ["desktop", "tablet", "mobile"] as const)
      console.info(`\n${name}.webp:\n${result.previews[name].sizeBytes} bytes`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof ApplicationError ? error.code : "TEMPLATE_REVIEW_FAILED";
  const message = error instanceof Error ? error.message : "Template review export failed";
  console.error(`[sites][templates][review] ${code}: ${message}`);
  process.exitCode = 1;
}
