import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LocalExecutionProvider } from "../../execution/local/local-execution.provider.js";
export async function bootstrapLocalProject(
  execution: LocalExecutionProvider,
  environmentId: string,
  templateRoot: string,
): Promise<number> {
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        await execution.writeFile(
          environmentId,
          relative(templateRoot, full).replaceAll("\\", "/"),
          await readFile(full, "utf8"),
        );
        count += 1;
      }
    }
  };
  await walk(templateRoot);
  return count;
}
