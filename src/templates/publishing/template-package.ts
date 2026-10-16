import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ApplicationError } from "../../app/errors/application-error.js";
import type { ValidatedTemplateSource } from "./template-source.js";

export interface TemplateSourcePackage {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly entries: readonly string[];
}

export async function packageTemplateSource(
  source: ValidatedTemplateSource,
): Promise<TemplateSourcePackage> {
  const entries: Zippable = {};
  const stableZipTimestamp = new Date(1980, 0, 1, 0, 0, 0, 0);
  const names = [...source.packageFiles].sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    if (isAbsolute(name) || name === ".." || name.startsWith("../") || name.includes("/../"))
      throw new ApplicationError("UNSAFE_TEMPLATE_SOURCE", `Unsafe ZIP entry: ${name}`);
    entries[name] = [
      new Uint8Array(await readFile(join(source.directory, ...name.split("/")))),
      { mtime: stableZipTimestamp },
    ];
  }
  const bytes = zipSync(entries, { level: 9 });
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    entries: names,
  };
}
