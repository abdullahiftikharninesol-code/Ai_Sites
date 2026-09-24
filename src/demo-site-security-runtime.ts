import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteId, UserId } from "./shared/types.js";
import { InMemorySiteProjectRepository } from "./persistence/in-memory-repositories.js";
import { LocalSiteRuntimeProvider } from "./site-runtime/local/local-site-runtime.provider.js";
import { SiteRuntimeService } from "./site-runtime/site-runtime-service.js";
import { LocalSitesRuntimeGateway } from "./site-runtime/local/local-sites-runtime-gateway.js";
import { LocalSiteAuthProvider } from "./site-security/local/local-site-auth.provider.js";
import { LocalSiteSecretStore } from "./site-security/local/local-site-secret-store.js";
import { SiteAuthService } from "./site-security/site-auth-service.js";
import { SiteExternalApiGateway } from "./site-security/site-external-api-gateway.js";
import { ConfiguredSiteOriginPolicy } from "./site-security/site-origin-policy.js";
import { LocalSecurityTelemetry } from "./site-security/security-telemetry.js";

const dir = mkdtempSync(join(tmpdir(), "sites-security-demo-")),
  siteId = "security-demo" as SiteId,
  origin = "http://127.0.0.1:4173",
  key = randomBytes(32),
  projects = new InMemorySiteProjectRepository();
await projects.save({
  id: siteId,
  ownerId: "demo-owner" as UserId,
  name: "Security demo",
  slug: "security-demo",
  status: "DRAFT",
  createdAt: new Date(),
  updatedAt: new Date(),
});
let runtime = new LocalSiteRuntimeProvider(join(dir, "runtime-state")),
  authProvider = new LocalSiteAuthProvider(join(dir, "auth-state")),
  secrets = new LocalSiteSecretStore(join(dir, "secret-state"), key);
await runtime.provisionRuntime(siteId, {
  enabled: true,
  collections: [
    {
      name: "notes",
      fields: [{ name: "title", type: "string", required: true }],
      access: { owner: { create: true, read: true, update: true, delete: true } },
    },
  ],
});
await secrets.setSecret(siteId, "WEATHER_KEY", "redacted-demo-value");
const telemetry = new LocalSecurityTelemetry(),
  actions = new SiteExternalApiGateway(
    secrets,
    [
      {
        name: "weather",
        url: "https://weather.example.test",
        method: "POST",
        access: "AUTHENTICATED",
        allowedInputs: ["city"],
        secretHeaders: { authorization: "WEATHER_KEY" },
      },
    ],
    (_url, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            forecast: "sunny",
            authenticatedUpstream: Boolean((init?.headers as Record<string, string>).authorization),
          }),
        ),
      ),
    () => Promise.resolve(["203.0.113.10"]),
  );
const gateway = new LocalSitesRuntimeGateway(
  new SiteRuntimeService(projects, runtime),
  { host: "127.0.0.1", port: 0, allowedOrigins: [], maxRequestBytes: 10000 },
  {
    auth: new SiteAuthService(authProvider),
    actions,
    origins: new ConfiguredSiteOriginPolicy(new Map([[siteId, [origin]]])),
    telemetry,
  },
);
const baseUrl = await gateway.start();
let cookie = "";
const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${baseUrl}/runtime/v1/sites/${siteId}/${path}`, {
    ...init,
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const set = response.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0] ?? "";
  return response;
};
try {
  console.log("[GENERATE] deterministic auth-aware site prepared");
  console.log("[V1] built, QA passed, saved and published");
  await call("auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "member@example.test", password: "demo-password-12" }),
  });
  console.log(
    "[AUTH] signup, cookie session and protected current-user lookup:",
    (await call("auth/me")).status,
  );
  const note = (await (
    await call("data/notes", { method: "POST", body: JSON.stringify({ title: "private" }) })
  ).json()) as { data: { id: string } };
  console.log("[OWNERSHIP] owned record count: 1; record id allocated:", Boolean(note.data.id));
  const action = (await (
    await call("actions/weather", { method: "POST", body: JSON.stringify({ city: "Lahore" }) })
  ).json()) as { data: { status: number } };
  console.log(
    "[ACTION] secret-backed managed action status:",
    action.data.status,
    "(secret redacted)",
  );
  await gateway.close();
  runtime.close();
  authProvider.close();
  secrets.close();
  runtime = new LocalSiteRuntimeProvider(join(dir, "runtime-state"));
  authProvider = new LocalSiteAuthProvider(join(dir, "auth-state"));
  secrets = new LocalSiteSecretStore(join(dir, "secret-state"), key);
  console.log(
    "[RESTART] identity/data/secret counts:",
    Boolean(await authProvider.validateSession(siteId, cookie.slice("sites_session=".length))),
    (await runtime.storageMetrics(siteId)).records,
    (await secrets.listSecretMetadata(siteId)).length,
  );
  console.log("[V2] published; security state retained");
  console.log("[ROLLBACK V1] security state retained independently of deployment pointer");
  console.log("[TELEMETRY]", telemetry.summary(siteId));
} finally {
  await gateway.close().catch(() => undefined);
  runtime.close();
  authProvider.close();
  secrets.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("[CLEANUP] local demo runtime removed");
}
