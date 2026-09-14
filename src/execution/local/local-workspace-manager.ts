import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileEntry } from "../execution-types.js";
export class LocalWorkspaceManager {
  constructor(readonly rootDirectory: string) {}
  environmentDirectory(id: string): string {
    return resolve(this.rootDirectory, id);
  }
  projectDirectory(id: string): string {
    return resolve(this.environmentDirectory(id), "project");
  }
  async create(id: string): Promise<string> {
    const project = this.projectDirectory(id);
    await mkdir(project, { recursive: true });
    return project;
  }
  async destroy(id: string): Promise<void> {
    await rm(this.environmentDirectory(id), {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 125,
    });
  }
  resolvePath(id: string, requested = ""): string {
    if (isAbsolute(requested)) throw new Error(`Unsafe workspace path: ${requested}`);
    const root = this.projectDirectory(id);
    const target = resolve(root, requested || ".");
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`Unsafe workspace path: ${requested}`);
    return target;
  }
  async write(id: string, path: string, content: string | Uint8Array): Promise<void> {
    const target = this.resolvePath(id, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  read(id: string, path: string): Promise<string> {
    return readFile(this.resolvePath(id, path), "utf8");
  }
  readBytes(id: string, path: string): Promise<Buffer> {
    return readFile(this.resolvePath(id, path));
  }
  async list(id: string, path = ""): Promise<readonly FileEntry[]> {
    const root = this.projectDirectory(id);
    const start = this.resolvePath(id, path);
    const output: FileEntry[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (["node_modules", ".git"].includes(entry.name)) continue;
        const full = resolve(directory, entry.name);
        const rel = relative(root, full).split(sep).join("/");
        if (entry.isDirectory()) {
          output.push({ path: rel, type: "DIRECTORY" });
          if (entry.name !== "dist") await walk(full);
        } else {
          const info = await stat(full);
          output.push({ path: rel, type: "FILE", sizeBytes: info.size });
        }
      }
    };
    await walk(start);
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }
}
