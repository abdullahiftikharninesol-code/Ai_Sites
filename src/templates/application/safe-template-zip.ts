import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { unzipSync } from "fflate";
import { ApplicationError } from "../../app/errors/application-error.js";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const MAX_ENTRY_COUNT = 10_000;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

interface InspectedZipEntry {
  readonly name: string;
  readonly directory: boolean;
}

const unsafe = (message: string, cause?: unknown) =>
  new ApplicationError("UNSAFE_TEMPLATE_SOURCE", message, cause === undefined ? {} : { cause });

function safeEntryName(name: string): void {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.startsWith("//") ||
    /^[a-zA-Z]:/.test(name)
  )
    throw unsafe(`Unsafe ZIP entry path: ${name || "<empty>"}`);
  const parts = name.split("/");
  const pathParts = name.endsWith("/") ? parts.slice(0, -1) : parts;
  if (pathParts.some((part) => !part || part === "." || part === ".."))
    throw unsafe(`Unsafe ZIP entry path: ${name}`);
  const normalized = posix.normalize(name);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/"))
    throw unsafe(`Unsafe ZIP entry path: ${name}`);
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset--)
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  throw unsafe("Template ZIP central directory is missing");
}

/**
 * Inspects central-directory metadata before decompression. fflate intentionally
 * exposes file bytes only, so this guard rejects Unix links and special files
 * before extraction as well as unsafe cross-platform paths.
 */
export function inspectTemplateZip(bytes: Uint8Array): readonly InspectedZipEntry[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEndOfCentralDirectory(view);
    const entryCount = view.getUint16(end + 10, true);
    const centralSize = view.getUint32(end + 12, true);
    let offset = view.getUint32(end + 16, true);
    if (entryCount > MAX_ENTRY_COUNT || offset + centralSize > bytes.byteLength)
      throw unsafe("Template ZIP exceeds extraction limits");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const entries: InspectedZipEntry[] = [];
    const names = new Set<string>();
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE)
        throw unsafe("Template ZIP central directory is invalid");
      const versionMadeBy = view.getUint16(offset + 4, true);
      const flags = view.getUint16(offset + 8, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const externalAttributes = view.getUint32(offset + 38, true);
      const nameStart = offset + 46;
      const next = nameStart + nameLength + extraLength + commentLength;
      if (next > bytes.byteLength || (flags & 1) !== 0)
        throw unsafe("Encrypted or truncated template ZIP entries are not allowed");
      const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      safeEntryName(name);
      if (names.has(name)) throw unsafe(`Duplicate ZIP entry is not allowed: ${name}`);
      names.add(name);
      const directory = name.endsWith("/");
      if ((versionMadeBy >>> 8) === 3) {
        const fileType = (externalAttributes >>> 16) & 0o170000;
        if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000)
          throw unsafe(`Links and special ZIP entries are not allowed: ${name}`);
        if (fileType === 0o040000 && !directory)
          throw unsafe(`Invalid ZIP directory entry: ${name}`);
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES)
        throw unsafe("Template ZIP exceeds extraction limits");
      entries.push({ name, directory });
      offset = next;
    }
    return entries;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unsafe("Template ZIP metadata is invalid", error);
  }
}

export async function extractTemplateZip(bytes: Uint8Array, destination: string): Promise<void> {
  const inspected = inspectTemplateZip(bytes);
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes);
  } catch (cause) {
    throw unsafe("Template ZIP could not be extracted", cause);
  }
  const expectedFiles = inspected.filter((entry) => !entry.directory).map((entry) => entry.name).sort();
  const actualFiles = Object.keys(extracted).filter((name) => !name.endsWith("/")).sort();
  if (expectedFiles.length !== actualFiles.length || expectedFiles.some((name, i) => name !== actualFiles[i]))
    throw unsafe("Template ZIP entries changed during extraction");
  for (const name of actualFiles) {
    safeEntryName(name);
    const target = join(destination, ...name.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, extracted[name]!);
  }
}
