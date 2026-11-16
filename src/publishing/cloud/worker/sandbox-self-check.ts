import { connect } from "node:net";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { SandboxSelfCheck } from "../cloud-build-protocol.js";

/**
 * Runs INSIDE a Cloud Run sandbox, before any site code, with the same flags
 * the build uses. Prints one JSON SandboxSelfCheck to stdout. Uses only Node
 * built-ins. It observes; it never assumes: every field is a real attempt.
 *
 * argv[2] (tests only) may override probe targets as JSON:
 *   { "metadata": [[host, port]], "egress": [[host, port]], "marker": "…" }
 */
export const DEFAULT_PROBE_TARGETS = {
  // The metadata server (by IP and by name): the job's credentials live behind it.
  metadata: [["169.254.169.254", 80], ["metadata.google.internal", 80]] as [string, number][],
  // Public internet and the npm registry: builds must have no network at all.
  egress: [["registry.npmjs.org", 443], ["1.1.1.1", 443], ["storage.googleapis.com", 443]] as [string, number][],
  // Present only in the worker's own environment (signed URLs).
  marker: "SITES_BUILD_RESULT_URL",
  // Paths on the (read-only) root that must reject writes.
  writeTargets: ["/.ai-sites-sandbox-probe", "/app/.ai-sites-sandbox-probe", "/usr/.ai-sites-sandbox-probe"],
  // Credential locations that must not exist inside a sandbox.
  credentialFiles: [
    "/var/run/secrets", "/root/.config/gcloud", "/root/.npmrc", "/root/.docker/config.json", "/home/node/.npmrc",
    "/app/.env", "/workspace/.env", "/etc/sites", "/run/secrets",
  ],
};

const SUSPICIOUS_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|JWT|MONGO|VERCEL|GOOGLE|GCLOUD|AWS_|AZURE|SITES_|DATABASE|_URL$|_URI$/i;

const reachable = (host: string, port: number, timeoutMs = 2_500) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hostEnvironReadable(marker: string) {
  let entries: string[] = [];
  try {
    entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).slice(0, 512);
  } catch {
    return false;
  }
  for (const pid of entries) {
    try {
      if ((await readFile(`/proc/${pid}/environ`, "utf8")).includes(marker)) return true;
    } catch {
      /* not readable: as intended */
    }
  }
  return false;
}

async function rootWritable(targets: readonly string[]) {
  for (const target of targets) {
    try {
      await writeFile(target, "x");
      return true;
    } catch {
      /* read-only: as intended */
    }
  }
  return false;
}

export async function runSelfCheck(targets = DEFAULT_PROBE_TARGETS, env: NodeJS.ProcessEnv = process.env): Promise<SandboxSelfCheck> {
  const any = async (list: [string, number][]) => (await Promise.all(list.map(([host, port]) => reachable(host, port)))).some(Boolean);
  const [metadataReachable, egressReachable, environ, writable, credentialFilesVisible] = await Promise.all([
    any(targets.metadata),
    any(targets.egress),
    hostEnvironReadable(targets.marker),
    rootWritable(targets.writeTargets),
    Promise.all(targets.credentialFiles.map(exists)).then((found) => found.some(Boolean)),
  ]);
  return {
    metadataReachable,
    egressReachable,
    inheritedEnv: Object.keys(env).filter((name) => SUSPICIOUS_ENV.test(name)).sort().slice(0, 20),
    hostEnvironReadable: environ,
    rootWritable: writable,
    credentialFilesVisible,
  };
}

const invokedDirectly = process.argv[1] && /sandbox-self-check\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const targets = process.argv[2] ? { ...DEFAULT_PROBE_TARGETS, ...(JSON.parse(process.argv[2]) as Partial<typeof DEFAULT_PROBE_TARGETS>) } : DEFAULT_PROBE_TARGETS;
  void runSelfCheck(targets).then((check) => process.stdout.write(`${JSON.stringify(check)}\n`));
}
