import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const source = resolve(projectRoot, "src", "sites", "assets", "default-car-fallback.png");
const destination = resolve(projectRoot, "dist", "sites", "assets", "default-car-fallback.png");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);

console.log(`[build] copied ${source} -> ${destination}`);
