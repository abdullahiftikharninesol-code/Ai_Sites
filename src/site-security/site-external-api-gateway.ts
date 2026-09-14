import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ApplicationError } from "../app/errors/application-error.js";
import type { SiteId } from "../shared/types.js";
import type { SiteUser } from "./site-auth-provider.js";
import type { SiteSecretStore } from "./site-secret-store.js";
import { pinnedRequest } from "./pinned-request.js";

export type ActionAccess = "PUBLIC" | "AUTHENTICATED";
export interface SiteExternalAction {
  readonly name: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly access: ActionAccess;
  readonly allowedInputs: readonly string[];
  readonly secretHeaders?: Readonly<Record<string, string>>;
}
export interface ExternalActionResult {
  readonly status: number;
  readonly body: unknown;
}

export class SiteExternalApiGateway {
  readonly #actions = new Map<string, SiteExternalAction>();
  constructor(
    private readonly secrets: SiteSecretStore,
    actions: readonly SiteExternalAction[],
    private readonly fetcher: typeof fetch = fetch,
    private readonly resolveHost: (host: string) => Promise<readonly string[]> = async (host) =>
      (await lookup(host, { all: true })).map((item) => item.address),
    private readonly timeoutMs = 5_000,
    private readonly maxResponseBytes = 256_000,
  ) {
    for (const action of actions) this.#actions.set(action.name, action);
  }

  async execute(
    siteId: SiteId,
    name: string,
    input: Readonly<Record<string, unknown>>,
    user?: SiteUser,
  ): Promise<ExternalActionResult> {
    const action = this.#actions.get(name);
    if (!action)
      throw new ApplicationError("EXTERNAL_ACTION_NOT_FOUND", "External action was not found");
    if (action.access === "AUTHENTICATED" && (!user || user.siteId !== siteId))
      throw new ApplicationError(
        "EXTERNAL_ACTION_FORBIDDEN",
        "Authentication is required for this action",
      );
    for (const key of Object.keys(input))
      if (!action.allowedInputs.includes(key))
        throw new ApplicationError("RUNTIME_VALIDATION_FAILED", `Unexpected action input: ${key}`);
    const url = new URL(action.url);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new ApplicationError("EXTERNAL_ACTION_FORBIDDEN", "Unsupported outbound protocol");
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolveHost(url.hostname);
    if (!addresses.length || addresses.some(isPrivateAddress))
      throw new ApplicationError(
        "EXTERNAL_ACTION_FORBIDDEN",
        "Private outbound destination is forbidden",
      );
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [header, secretName] of Object.entries(action.secretHeaders ?? {})) {
      const value = await this.secrets.getSecret(siteId, secretName);
      if (!value)
        throw new ApplicationError(
          "SITE_SECRET_NOT_CONFIGURED",
          `Required secret ${secretName} is not configured`,
        );
      headers[header] = value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method: action.method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(action.method === "POST" ? { body: JSON.stringify(input) } : {}),
      };
      const response =
        this.fetcher === fetch
          ? await pinnedRequest(url, addresses[0]!, init)
          : await this.fetcher(url, init);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ApplicationError("EXTERNAL_ACTION_FORBIDDEN", "Outbound redirects are forbidden");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      try {
        if (reader)
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > this.maxResponseBytes) {
              await reader.cancel();
              throw new ApplicationError(
                "EXTERNAL_ACTION_FAILED",
                "External response exceeded the size limit",
              );
            }
            chunks.push(item.value);
          }
      } finally {
        reader?.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      const text = new TextDecoder().decode(bytes);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* safe text response */
      }
      return { status: response.status, body };
    } catch (cause) {
      if (cause instanceof ApplicationError) throw cause;
      throw new ApplicationError("EXTERNAL_ACTION_FAILED", "External action failed", { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  )
    return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127)
  );
}
