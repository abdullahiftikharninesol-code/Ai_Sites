import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import mongoose, { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthUser, type AuthenticatedRequest } from "../src/auth/auth-user.js";
import {
  MongoIdentityRepository,
  SITES_ADMIN_IDENTITY_PROJECTION,
  SITES_USER_IDENTITY_PROJECTION,
} from "../src/auth/identity-repository.js";
import { ownerIdOf } from "../src/auth/owner-id.js";
import { isSitesSubscriptionEligible } from "../src/auth/sites-subscription.js";
import { PlaygroundHttpServer } from "../src/dev-server/playground-http-server.js";
import {
  PlaygroundService,
  loadPlaygroundConfig,
  type PlaygroundConfig,
} from "../src/dev-server/playground-service.js";
import { MongoConnectionManager } from "../src/persistence/mongodb/mongo-connection.js";
import { InMemorySiteProjectRepository } from "../src/persistence/in-memory-repositories.js";
import { SiteQueries } from "../src/sites/application/site-queries.js";
import { PLACEHOLDER_PNG } from "../src/sites/assets/media-store.js";
import type { SiteProject } from "../src/sites/domain/entities.js";
import type { SiteId, UserId, VersionId } from "../src/shared/types.js";
import {
  FakeIdentityRepository,
  TEST_JWT_KEY,
  bearer,
  testAuthUser,
  tokenFor,
} from "./support/auth-test-support.js";

process.env.SITES_DEV_AGENT_PROVIDER = "mock";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Group A — token authentication (GetChatly authUser parity)
// ---------------------------------------------------------------------------

const invoke = async (middleware: ReturnType<typeof createAuthUser>, authorization?: string) => {
  const req = {
    headers: authorization === undefined ? {} : { authorization },
  } as AuthenticatedRequest;
  const response: { status?: number; body?: unknown; ended?: boolean } = {};
  const res = {
    headersSent: false,
    get writableEnded() {
      return response.ended === true;
    },
    writeHead(status: number) {
      response.status = status;
      return res;
    },
    end(body: string) {
      response.body = JSON.parse(body);
      response.ended = true;
    },
  } as unknown as ServerResponse;
  const next = vi.fn();
  await middleware(req, res, next);
  return { status: response.status, body: response.body, next, req };
};

describe("authUser token authentication", () => {
  it("A1 accepts a GetChatly JWT, hydrates req.user from the identity store and calls next()", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser();
    const result = await invoke(testAuthUser(identities), `Bearer ${tokenFor(user.id)}`);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).toBeUndefined();
    expect(result.req.user).toBe(user);
    expect(ownerIdOf(result.req)).toBe(user._id.toString());
  });

  it("checks the admin collection before the user collection", async () => {
    const identities = new FakeIdentityRepository();
    const admin = identities.addAdmin();
    const findActiveUser = vi.spyOn(identities, "findActiveUser");
    const result = await invoke(testAuthUser(identities), `Bearer ${tokenFor(admin.id)}`);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.req.user).toBe(admin);
    expect(findActiveUser).not.toHaveBeenCalled();
  });

  it("A2 rejects a missing Authorization header", async () => {
    const result = await invoke(testAuthUser(new FakeIdentityRepository()));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "No Token. Access Denied", status: false });
    expect(result.next).not.toHaveBeenCalled();
  });

  it.each(["Bearer", "Bearer ", ""])("A3 rejects an empty bearer token %j", async (header) => {
    const result = await invoke(testAuthUser(new FakeIdentityRepository()), header);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "No Token. Access Denied", status: false });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("A4 rejects tampered, foreign-key and unprefixed tokens", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser();
    const valid = tokenFor(user.id);
    const [header, , signature] = valid.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ userId: new Types.ObjectId().toString(), type: "user" }),
    ).toString("base64url");
    const candidates = [
      `${header}.${forgedPayload}.${signature}`,
      `${valid.slice(0, -2)}${valid.endsWith("AA") ? "BB" : "AA"}`,
      tokenFor(user.id, { key: "another-key" }),
      "not-a-jwt",
    ];
    for (const token of candidates) {
      const result = await invoke(testAuthUser(identities), `Bearer ${token}`);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        message: "Invalid Authorization. Access Denied",
        status: false,
      });
      expect(result.next).not.toHaveBeenCalled();
    }
    // GetChatly slices positionally, so a raw token loses its first 7 characters.
    const raw = await invoke(testAuthUser(identities), valid);
    expect(raw.body).toEqual({ message: "Invalid Authorization. Access Denied", status: false });
  });

  it("A5 rejects an expired JWT", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser();
    const expired = jwt.sign(
      { userId: user.id, type: "user", exp: Math.floor(Date.now() / 1000) - 60 },
      TEST_JWT_KEY,
    );
    const result = await invoke(testAuthUser(identities), `Bearer ${expired}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "Invalid Authorization. Access Denied", status: false });
  });

  it("A6 rejects a valid JWT for a user that does not exist", async () => {
    const result = await invoke(
      testAuthUser(new FakeIdentityRepository()),
      `Bearer ${tokenFor(new Types.ObjectId().toString())}`,
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "Authentication Failed!", status: false });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("A6 rejects a token without a userId claim", async () => {
    const token = jwt.sign({ type: "user" }, TEST_JWT_KEY);
    const result = await invoke(testAuthUser(new FakeIdentityRepository()), `Bearer ${token}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "Authentication Failed!", status: false });
  });

  it("A7 rejects a soft-deleted user", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser({ is_deleted: true });
    const result = await invoke(testAuthUser(identities), `Bearer ${tokenFor(user.id)}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ message: "Authentication Failed!", status: false });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("A8 rejects a blocked user", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser({ status: "blocked" });
    const result = await invoke(testAuthUser(identities), `Bearer ${tokenFor(user.id)}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      message: "Account blocked. Authentication Failed!",
      status: false,
    });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("A9 fails closed when JWTKEY is missing and accepts no fallback secret", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser();
    const previous = process.env.JWTKEY;
    cleanups.push(() => {
      if (previous === undefined) delete process.env.JWTKEY;
      else process.env.JWTKEY = previous;
    });
    delete process.env.JWTKEY;
    const middleware = createAuthUser({ identities });
    for (const key of [TEST_JWT_KEY, "fallback_secret", "development-secret"]) {
      const result = await invoke(middleware, `Bearer ${tokenFor(user.id, { key })}`);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({ message: "Internal Server Error", status: false });
      expect(result.next).not.toHaveBeenCalled();
    }
    // Configured: only the real JWTKEY verifies.
    process.env.JWTKEY = TEST_JWT_KEY;
    for (const key of ["fallback_secret", "development-secret"]) {
      const result = await invoke(middleware, `Bearer ${tokenFor(user.id, { key })}`);
      expect(result.status).toBe(401);
    }
    expect((await invoke(middleware, `Bearer ${tokenFor(user.id)}`)).next).toHaveBeenCalledOnce();
  });

  it("returns 500 Internal Server Error when the identity lookup fails", async () => {
    const identities = new FakeIdentityRepository();
    const user = identities.addUser();
    identities.failWith = new Error("database offline");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await invoke(testAuthUser(identities), `Bearer ${tokenFor(user.id)}`);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ message: "Internal Server Error", status: false });
    expect(result.next).not.toHaveBeenCalled();
  });
});

describe("GetChatly identity repository", () => {
  it("reads the GetChatly users/adminusers collections with the userService/adminUserService filters", async () => {
    const connection = mongoose.createConnection();
    cleanups.push(() => connection.close());
    const identities = new MongoIdentityRepository(connection);
    const users = connection.models.GetChatlyUser!;
    const admins = connection.models.GetChatlyAdminUser!;
    expect(users.collection.collectionName).toBe("users");
    expect(admins.collection.collectionName).toBe("adminusers");
    const document = { _id: new Types.ObjectId(), status: "active" };
    const userSelect = vi.fn(() => ({ exec: async () => document }));
    const adminSelect = vi.fn(() => ({ exec: async () => null }));
    const userFind = vi.spyOn(users, "findOne").mockReturnValue({ select: userSelect } as never);
    const adminFind = vi.spyOn(admins, "findOne").mockReturnValue({ select: adminSelect } as never);
    const id = document._id.toString();
    await expect(identities.findAdmin(id)).resolves.toBeNull();
    await expect(identities.findActiveUser(id)).resolves.toBe(document);
    expect(adminFind).toHaveBeenCalledWith({ _id: id });
    expect(adminSelect).toHaveBeenCalledWith(SITES_ADMIN_IDENTITY_PROJECTION);
    expect(userFind).toHaveBeenCalledWith({ _id: id, is_deleted: false });
    expect(userSelect).toHaveBeenCalledWith(SITES_USER_IDENTITY_PROJECTION);
    expect(SITES_USER_IDENTITY_PROJECTION).toEqual({
      _id: 1,
      is_deleted: 1,
      status: 1,
      "subscription.plan_type": 1,
      "subscription.payment_status": 1,
      "subscription.is_active": 1,
      chat_count: 1,
    });
  });

  it("never queries for identifiers that cannot be GetChatly ObjectIds", async () => {
    const connection = mongoose.createConnection();
    cleanups.push(() => connection.close());
    const identities = new MongoIdentityRepository(connection);
    const userFind = vi.spyOn(connection.models.GetChatlyUser!, "findOne");
    await expect(identities.findActiveUser("local-playground-user")).resolves.toBeNull();
    await expect(identities.findAdmin('{"$ne":null}')).resolves.toBeNull();
    expect(userFind).not.toHaveBeenCalled();
  });
});

describe("Sites paid subscription eligibility", () => {
  it.each([
    ["monthly active", { plan_type: "monthly", payment_status: "active", is_active: true }],
    ["yearly active", { plan_type: "yearly", payment_status: "active", is_active: true }],
    ["canceled paid", { plan_type: "monthly", payment_status: "canceled", is_active: false }],
  ])("accepts %s", (_label, subscription) => {
    expect(isSitesSubscriptionEligible({ subscription })).toBe(true);
  });

  it.each([
    ["missing subscription", undefined],
    ["missing plan", { payment_status: "active", is_active: true }],
    ["empty plan", { plan_type: "", payment_status: "active", is_active: true }],
    ["free plan", { plan_type: "free", payment_status: "active", is_active: true }],
    [
      "inactive active subscription",
      { plan_type: "monthly", payment_status: "active", is_active: false },
    ],
    [
      "unknown payment status",
      { plan_type: "monthly", payment_status: "past_due", is_active: true },
    ],
  ])("rejects %s", (_label, subscription) => {
    expect(isSitesSubscriptionEligible(subscription ? { subscription } : {})).toBe(false);
  });
});

describe("ownerIdOf", () => {
  it("derives ownership only from req.user", () => {
    const _id = new Types.ObjectId();
    const req = (user: unknown, body?: unknown) =>
      ({
        headers: { "x-owner-id": "header-owner" },
        user,
        body,
      }) as unknown as AuthenticatedRequest;
    expect(ownerIdOf(req({ _id }, { ownerId: "body-owner" }))).toBe(_id.toString());
    expect(ownerIdOf(req({ id: "string-id" }))).toBe("string-id");
    expect(ownerIdOf(req(undefined, { ownerId: "body-owner", userId: "body-user" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP harness: real PlaygroundService and routes, in-memory project store,
// mocked orchestrator (no provider or model is ever invoked).
// ---------------------------------------------------------------------------

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), "sites-auth-"));
  const config: PlaygroundConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigins: loadPlaygroundConfig({}).webOrigins,
    hostingHost: "127.0.0.1",
    hostingPort: 0,
    runtimeHost: "127.0.0.1",
    runtimePort: 0,
    previewIdleTtlMs: 60_000,
    agentProvider: "mock",
    dataRoot,
  };
  const mongo = new MongoConnectionManager();
  mongo.connect = () => Promise.resolve();
  mongo.status = () => ({ provider: "mongodb", connected: true });
  const service = new PlaygroundService(config, mongo);
  expect(service.agentProviderId).toBe("mock");

  const projects = new InMemorySiteProjectRepository();
  const versions = new Map<
    string,
    { id: VersionId; siteId: SiteId; versionNumber: number; createdAt: Date }
  >();
  const versionRepository = {
    getById: async (id: VersionId) => versions.get(id),
    listBySite: async (siteId: SiteId) => ({
      items: [...versions.values()].filter((version) => version.siteId === siteId),
    }),
    save: async () => undefined,
  };
  const product = service.product as unknown as Record<string, unknown>;
  product.projects = projects;
  product.versions = versionRepository;
  product.queries = new SiteQueries(projects, versionRepository as never);
  const deleteSite = vi.fn(async () => undefined);
  product.deleteSite = deleteSite;

  const orchestrator = service.product.orchestrator;
  const generateWebsite = vi
    .spyOn(orchestrator, "generateWebsite")
    .mockImplementation(async (request) => {
      // Mirrors the pipeline: the project is created for request.userId.
      const now = new Date();
      const id = randomUUID() as SiteId;
      await projects.save({
        id,
        ownerId: request.userId,
        name: "Generated",
        slug: `site-${id.slice(0, 8)}`,
        status: "DRAFT",
        createdAt: now,
        updatedAt: now,
      });
      throw Object.assign(new Error("mock provider stopped"), {
        code: "MOCK_STOPPED",
        metadata: { providerCode: "secret-provider-code", requestId: "secret-request-id" },
      });
    });
  const editWebsite = vi
    .spyOn(orchestrator, "editWebsite")
    .mockRejectedValue(Object.assign(new Error("mock edit stopped"), { code: "MOCK_STOPPED" }));
  const jobStart = vi.spyOn(service.jobs, "start");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const identities = new FakeIdentityRepository();
  const userA = identities.addUser();
  const userB = identities.addUser();
  const server = new PlaygroundHttpServer(config, service, testAuthUser(identities));
  const base = await server.start();
  cleanups.push(async () => {
    await server.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  const site = async (ownerId: string, name: string, latestVersionId?: VersionId) => {
    const now = new Date();
    const id = randomUUID() as SiteId;
    const project: SiteProject = {
      id,
      ownerId: ownerId as UserId,
      name,
      slug: `site-${id.slice(0, 8)}`,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
      ...(latestVersionId ? { latestVersionId } : {}),
    };
    await projects.save(project);
    if (latestVersionId)
      versions.set(latestVersionId, {
        id: latestVersionId,
        siteId: id,
        versionNumber: 1,
        createdAt: now,
      });
    return project;
  };
  const request = async (
    path: string,
    init: {
      method?: string;
      as?: { id: string };
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.as ? bearer(init.as.id) : {}),
        ...init.headers,
      },
      ...(init.body !== undefined
        ? {
            body: (init.body instanceof Uint8Array
              ? init.body
              : JSON.stringify(init.body)) as BodyInit,
          }
        : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      headers: response.headers,
    };
  };
  const settle = (jobId: string) =>
    vi.waitFor(() => {
      const status = service.jobs.get(jobId)?.status;
      if (status !== "SUCCEEDED" && status !== "FAILED")
        throw new Error(`job ${jobId} is ${status}`);
    });
  return {
    service,
    projects,
    versions,
    identities,
    userA,
    userB,
    request,
    site,
    settle,
    generateWebsite,
    editWebsite,
    jobStart,
    deleteSite,
  };
}

describe("Sites API CORS", () => {
  it("uses safe development defaults and requires explicit production origins", () => {
    expect(loadPlaygroundConfig({}).webOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
    expect(loadPlaygroundConfig({ NODE_ENV: "production" }).webOrigins).toEqual([]);
    expect(
      loadPlaygroundConfig({
        NODE_ENV: "production",
        SITES_PLAYGROUND_ORIGINS: "https://app.example.com, https://admin.example.com",
      }).webOrigins,
    ).toEqual(["https://app.example.com", "https://admin.example.com"]);
    expect(() =>
      loadPlaygroundConfig({ NODE_ENV: "production", SITES_PLAYGROUND_ORIGINS: "*" }),
    ).toThrow(/wildcard is not allowed/);
  });

  it("answers approved GET and POST preflights without changing authentication", async () => {
    const h = await harness();
    for (const [origin, method] of [
      ["http://localhost:3000", "GET"],
      ["http://127.0.0.1:3000", "GET"],
      ["http://localhost:3001", "POST"],
      ["http://127.0.0.1:3001", "POST"],
    ] as const) {
      const response = await h.request("/api/dev/sites", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")).toContain(method);
      expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        "authorization",
      );
      expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        "content-type",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }

    const rejected = await h.request("/api/dev/sites", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(rejected.status).toBe(204);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();

    const unauthenticated = await h.request("/api/dev/sites", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({ message: "No Token. Access Denied", status: false });
  });
});

describe("HTTP route protection", () => {
  it("keeps health public and requires a GetChatly token on every user-scoped route", async () => {
    const h = await harness();
    const health = await h.request("/api/dev/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "ok", agentProvider: "mock" });
    const routes: Array<[string, string]> = [
      ["POST", "/api/dev/sites"],
      ["GET", "/api/dev/sites"],
      ["GET", "/api/dev/sites/p1"],
      ["PATCH", "/api/dev/sites/p1"],
      ["DELETE", "/api/dev/sites/p1"],
      ["POST", "/api/dev/sites/p1/edit"],
      ["GET", "/api/dev/jobs/j1"],
      ["GET", "/api/dev/jobs/j1/events"],
      ["POST", "/api/dev/assets"],
      ["POST", "/api/dev/persistence/sites"],
      ["GET", "/api/dev/sites/p1/versions"],
      ["GET", "/api/dev/sites/p1/versions/v1/files"],
      ["POST", "/api/dev/sites/p1/versions/v1/preview"],
      ["POST", "/api/dev/sites/p1/versions/v1/publish"],
      ["POST", "/api/dev/sites/p1/rollback"],
      ["POST", "/api/dev/sites/p1/unpublish"],
      ["GET", "/api/dev/sites/p1/runtime"],
      ["GET", "/api/dev/previews/s1"],
      ["DELETE", "/api/dev/previews/s1"],
    ];
    for (const [method, path] of routes) {
      const response = await h.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.body).toEqual({ message: "No Token. Access Denied", status: false });
    }
    const blocked = h.identities.addUser({ status: "blocked" });
    const blockedResponse = await h.request("/api/dev/sites", { as: blocked });
    expect(blockedResponse.status).toBe(401);
    expect(blockedResponse.body).toEqual({
      message: "Account blocked. Authentication Failed!",
      status: false,
    });
    expect(h.generateWebsite).not.toHaveBeenCalled();
  });
});

describe("paid subscription route gate", () => {
  it.each([
    ["monthly", { plan_type: "monthly", payment_status: "active", is_active: true }],
    ["yearly", { plan_type: "yearly", payment_status: "active", is_active: true }],
    ["canceled", { plan_type: "monthly", payment_status: "canceled", is_active: false }],
  ])("allows %s subscribers to start generation", async (_label, subscription) => {
    const h = await harness();
    h.userA.subscription = subscription;
    const response = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userA,
      body: { prompt: "Build a paid site" },
    });
    expect(response.status).toBe(202);
    await h.settle(response.body!.jobId as string);
    expect(h.generateWebsite).toHaveBeenCalledOnce();
  });

  it.each([
    ["free", { plan_type: "free", payment_status: "active", is_active: true }],
    ["active but inactive", { plan_type: "monthly", payment_status: "active", is_active: false }],
    [
      "unknown payment status",
      { plan_type: "monthly", payment_status: "past_due", is_active: true },
    ],
    ["missing subscription", undefined],
  ])("rejects %s users before generation work", async (_label, subscription) => {
    const h = await harness();
    if (subscription) h.userA.subscription = subscription;
    else delete h.userA.subscription;
    const response = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userA,
      body: { prompt: "Build an unpaid site" },
    });
    expect(response.status).toBe(402);
    expect(response.body).toEqual({
      error: {
        code: "SUBSCRIPTION_REQUIRED",
        message: "A paid subscription is required to use Sites.",
      },
    });
    expect(h.jobStart).not.toHaveBeenCalled();
    expect(h.generateWebsite).not.toHaveBeenCalled();
  });

  it("allows a paid edit and rejects a free edit without changing the site", async () => {
    const h = await harness();
    const site = await h.site(h.userA.id, "Paid Site", "paid-site:v1" as VersionId);
    const allowed = await h.request(`/api/dev/sites/${site.id}/edit`, {
      method: "POST",
      as: h.userA,
      body: { prompt: "Change the paid headline" },
    });
    expect(allowed.status).toBe(202);
    await h.settle(allowed.body!.jobId as string);
    expect(h.editWebsite).toHaveBeenCalledOnce();

    h.userA.subscription = { plan_type: "free", payment_status: "active", is_active: true };
    h.jobStart.mockClear();
    h.editWebsite.mockClear();
    const before = await h.projects.getById(site.id);
    const rejected = await h.request(`/api/dev/sites/${site.id}/edit`, {
      method: "POST",
      as: h.userA,
      body: { prompt: "Change the free headline" },
    });
    expect(rejected.status).toBe(402);
    expect(rejected.body).toMatchObject({ error: { code: "SUBSCRIPTION_REQUIRED" } });
    expect(h.jobStart).not.toHaveBeenCalled();
    expect(h.editWebsite).not.toHaveBeenCalled();
    expect(await h.projects.getById(site.id)).toEqual(before);
  });

  it("does not exempt an authenticated admin without subscription data", async () => {
    const h = await harness();
    const admin = h.identities.addAdmin();
    const response = await h.request("/api/dev/sites", {
      method: "POST",
      as: admin,
      body: { prompt: "Build an admin site" },
    });
    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({ error: { code: "SUBSCRIPTION_REQUIRED" } });
    expect(h.jobStart).not.toHaveBeenCalled();
    expect(h.generateWebsite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group B — SiteProject ownership
// ---------------------------------------------------------------------------

describe("SiteProject ownership", () => {
  it("B1-B5 isolates list, get, rename and delete by owner with 404 for cross-user access", async () => {
    const h = await harness();
    const siteA = await h.site(h.userA.id, "Site A");
    const siteB = await h.site(h.userB.id, "Site B");

    const list = await h.request("/api/dev/sites", { as: h.userA });
    expect(list.status).toBe(200);
    expect((list.body!.sites as Array<{ projectId: string }>).map((s) => s.projectId)).toEqual([
      siteA.id,
    ]);
    // Client-supplied ownership in the query string changes nothing.
    const spoofed = await h.request(
      `/api/dev/sites?ownerId=${h.userB.id}&userId=${h.userB.id}&user=${h.userB.id}`,
      {
        as: h.userA,
        headers: { "x-owner-id": h.userB.id, "x-user-id": h.userB.id },
      },
    );
    expect((spoofed.body!.sites as Array<{ projectId: string }>).map((s) => s.projectId)).toEqual([
      siteA.id,
    ]);

    const own = await h.request(`/api/dev/sites/${siteA.id}`, { as: h.userA });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ project: { projectId: siteA.id, name: "Site A" } });

    const notFound = { error: { code: "SITE_NOT_FOUND", message: "Site not found" } };
    const foreign = await h.request(`/api/dev/sites/${siteB.id}`, { as: h.userA });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(notFound);
    expect(foreign.text).not.toContain("Site B");

    const rename = await h.request(`/api/dev/sites/${siteB.id}`, {
      method: "PATCH",
      as: h.userA,
      body: { name: "Hijacked", ownerId: h.userA.id },
    });
    expect(rename.status).toBe(404);
    expect(rename.body).toEqual(notFound);
    expect((await h.projects.getById(siteB.id))?.name).toBe("Site B");
    expect((await h.projects.getById(siteB.id))?.ownerId).toBe(h.userB.id);

    const remove = await h.request(`/api/dev/sites/${siteB.id}`, { method: "DELETE", as: h.userA });
    expect(remove.status).toBe(404);
    expect(remove.body).toEqual(notFound);
    expect(h.deleteSite).not.toHaveBeenCalled();
    expect(await h.projects.getById(siteB.id)).toBeDefined();

    const ownRename = await h.request(`/api/dev/sites/${siteA.id}`, {
      method: "PATCH",
      as: h.userA,
      body: { name: "Renamed A", ownerId: h.userB.id },
    });
    expect(ownRename.status).toBe(200);
    expect(await h.projects.getById(siteA.id)).toMatchObject({
      name: "Renamed A",
      ownerId: h.userA.id,
    });
    const ownDelete = await h.request(`/api/dev/sites/${siteA.id}`, {
      method: "DELETE",
      as: h.userA,
    });
    expect(ownDelete.status).toBe(200);
    expect(h.deleteSite).toHaveBeenCalledWith(siteA.id, h.userA.id);
  });

  it("B6 refuses a targeted edit of another user's site before any job or model call", async () => {
    const h = await harness();
    const siteB = await h.site(h.userB.id, "Site B", "site-b:v1" as VersionId);
    const response = await h.request(`/api/dev/sites/${siteB.id}/edit`, {
      method: "POST",
      as: h.userA,
      body: { prompt: "Change the headline", ownerId: h.userB.id },
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "SITE_NOT_FOUND", message: "Site not found" } });
    expect(h.jobStart).not.toHaveBeenCalled();
    expect(h.editWebsite).not.toHaveBeenCalled();
  });

  it("refuses an edit based on another user's version before any job or model call", async () => {
    const h = await harness();
    const siteA = await h.site(h.userA.id, "Site A", "site-a:v1" as VersionId);
    await h.site(h.userB.id, "Site B", "site-b:v1" as VersionId);
    const response = await h.request(`/api/dev/sites/${siteA.id}/edit`, {
      method: "POST",
      as: h.userA,
      body: { prompt: "Change the headline", baseVersionId: "site-b:v1" },
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "VERSION_NOT_FOUND" } });
    expect(h.jobStart).not.toHaveBeenCalled();
    expect(h.editWebsite).not.toHaveBeenCalled();
  });

  it("starts an owned edit with the authenticated owner", async () => {
    const h = await harness();
    const siteA = await h.site(h.userA.id, "Site A", "site-a:v1" as VersionId);
    const response = await h.request(`/api/dev/sites/${siteA.id}/edit`, {
      method: "POST",
      as: h.userA,
      body: { prompt: "Change the headline", ownerId: h.userB.id, userId: h.userB.id },
    });
    expect(response.status).toBe(202);
    await h.settle(response.body!.jobId as string);
    expect(h.editWebsite).toHaveBeenCalledOnce();
    expect(h.editWebsite.mock.calls[0]![0]).toMatchObject({ userId: h.userA.id, siteId: siteA.id });
  });

  it("scopes version files, preview, publish, rollback, unpublish and runtime to the owner", async () => {
    const h = await harness();
    const siteB = await h.site(h.userB.id, "Site B", "site-b:v1" as VersionId);
    const deployment = h.service.product.deploymentService;
    const deploy = vi.spyOn(deployment, "deploy");
    const rollback = vi.spyOn(deployment, "rollback");
    const unpublish = vi.spyOn(deployment, "unpublish");
    const previewStart = vi.spyOn(h.service.previews, "start");
    const checks: Array<[string, string, unknown?]> = [
      ["GET", `/api/dev/sites/${siteB.id}/versions`],
      ["GET", `/api/dev/sites/${siteB.id}/versions/site-b%3Av1/files`],
      ["GET", `/api/dev/sites/${siteB.id}/versions/site-b%3Av1/files?path=src/App.tsx`],
      ["POST", `/api/dev/sites/${siteB.id}/versions/site-b%3Av1/preview`],
      ["POST", `/api/dev/sites/${siteB.id}/versions/site-b%3Av1/publish`],
      ["POST", `/api/dev/sites/${siteB.id}/rollback`, { deploymentId: "deployment-b" }],
      ["POST", `/api/dev/sites/${siteB.id}/unpublish`],
      ["GET", `/api/dev/sites/${siteB.id}/runtime`],
    ];
    for (const [method, path, body] of checks) {
      const response = await h.request(path, { method, as: h.userA, ...(body ? { body } : {}) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.body).toEqual({
        error: { code: "SITE_NOT_FOUND", message: "Site not found" },
      });
    }
    expect(deploy).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(unpublish).not.toHaveBeenCalled();
    expect(previewStart).not.toHaveBeenCalled();
  });

  it("does not let another user inspect or stop a preview session", async () => {
    const h = await harness();
    const siteA = await h.site(h.userA.id, "Site A", "site-a:v1" as VersionId);
    const now = new Date().toISOString();
    const session = {
      id: "preview-a",
      siteId: siteA.id,
      versionId: "site-a:v1" as VersionId,
      environmentId: "env-a",
      url: "http://127.0.0.1:1/",
      createdAt: now,
      lastAccessedAt: now,
    };
    vi.spyOn(h.service.previews, "list").mockReturnValue([session]);
    vi.spyOn(h.service.previews, "get").mockReturnValue(session);
    const stop = vi.spyOn(h.service.previews, "stop").mockResolvedValue(true);
    const execution = h.service.product.execution;
    vi.spyOn(execution, "readLogs").mockResolvedValue([]);
    vi.spyOn(execution, "getWorkspacePath").mockReturnValue("/workspace");
    vi.spyOn(execution, "ownedProcessCount").mockReturnValue(1);

    const foreignGet = await h.request("/api/dev/previews/preview-a", { as: h.userB });
    expect(foreignGet.body).toEqual({
      error: { code: "INVALID_REQUEST", message: "Preview instance was not found" },
    });
    expect(foreignGet.text).not.toContain("env-a");
    const foreignStop = await h.request("/api/dev/previews/preview-a", {
      method: "DELETE",
      as: h.userB,
    });
    expect(foreignStop.body).toEqual({ stopped: false });
    expect(stop).not.toHaveBeenCalled();

    const ownGet = await h.request("/api/dev/previews/preview-a", { as: h.userA });
    expect(ownGet.status).toBe(200);
    expect(ownGet.body).toMatchObject({ previewSessionId: "preview-a", siteId: siteA.id });
    const ownStop = await h.request("/api/dev/previews/preview-a", {
      method: "DELETE",
      as: h.userA,
    });
    expect(ownStop.body).toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledWith("preview-a");
  });
});

// ---------------------------------------------------------------------------
// Group C — job isolation
// ---------------------------------------------------------------------------

describe("job isolation", () => {
  it("C lets a user poll only their own jobs without leaking another user's metadata", async () => {
    const h = await harness();
    const createA = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userA,
      body: { prompt: "Build site A" },
    });
    expect(createA.status).toBe(202);
    const jobA = createA.body!.jobId as string;
    await h.settle(jobA);
    const createB = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userB,
      body: { prompt: "Build site B" },
    });
    const jobB = createB.body!.jobId as string;
    await h.settle(jobB);

    const own = await h.request(`/api/dev/jobs/${jobA}`, { as: h.userA });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      id: jobA,
      status: "FAILED",
      error: { providerCode: "secret-provider-code" },
    });

    const foreign = await h.request(`/api/dev/jobs/${jobB}`, { as: h.userA });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: { code: "NOT_FOUND", message: "Job not found" } });
    const projectB = h.service.jobs.get(jobB)!.projectId;
    for (const secret of [
      "secret-provider-code",
      "secret-request-id",
      "mock provider stopped",
      "MOCK_STOPPED",
      projectB ?? "unset",
    ])
      expect(foreign.text).not.toContain(secret);

    const foreignEvents = await h.request(`/api/dev/jobs/${jobB}/events`, { as: h.userA });
    expect(foreignEvents.status).toBe(404);
    expect(foreignEvents.text).not.toContain("WORKFLOW");
  });

  it("returns terminal billing fields only to the authenticated job owner", async () => {
    const h = await harness();
    const subscriberQuota = {
      _id: "quota-1",
      user: h.userA.id,
      type: "image",
      count: 4,
      limit: 50_000,
      chat_request_tokens: 29_563,
      chat_response_tokens: 39_101,
      is_credit_implemented: true,
      token_credit: 50_000,
      token_credit_used: 823.968,
      model_credit_list: [],
      is_premium: true,
      chat_count: 7,
    };
    const job = h.service.jobs.start(
      "EDIT",
      async () => ({
        projectId: "site-a",
        versionId: "version-2",
        billingStatus: "CHARGED",
        creditsCharged: 88.032,
        subscriberQuota,
      }),
      h.userA.id,
    );
    await h.settle(job.id);

    const own = await h.request(`/api/dev/jobs/${job.id}`, { as: h.userA });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      id: job.id,
      operation: "EDIT",
      status: "SUCCEEDED",
      currentStage: "COMPLETED",
      billingStatus: "CHARGED",
      creditsCharged: 88.032,
      subscriberQuota: { token_credit: 50_000, token_credit_used: 823.968 },
    });
    expect(own.body).not.toHaveProperty("events");
    expect(own.text).not.toMatch(/JWT|REDIS_URL|MONGO_URI|credentials/i);

    expect((await h.request(`/api/dev/jobs/${job.id}`, { as: h.userB })).status).toBe(404);
    expect((await h.request(`/api/dev/jobs/${job.id}`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Group D — asset ownership
// ---------------------------------------------------------------------------

describe("asset ownership", () => {
  it("D resolves an uploaded image only for the user who uploaded it", async () => {
    const h = await harness();
    const uploaded = await h.request("/api/dev/assets?name=hero.png&mime=image/png", {
      method: "POST",
      as: h.userA,
      body: PLACEHOLDER_PNG,
      headers: { "content-type": "image/png" },
    });
    expect(uploaded.status).toBe(201);
    const assetId = uploaded.body!.id as string;
    expect(assetId).toMatch(/^user-/);

    const ownUse = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userA,
      body: {
        prompt: "Build with my hero image",
        attachments: [assetId],
        referenceAttachments: [assetId],
      },
    });
    expect(ownUse.status).toBe(202);
    await h.settle(ownUse.body!.jobId as string);
    const manifest = h.generateWebsite.mock.calls[0]![0].assetManifest;
    expect(manifest?.assets.map((asset) => asset.logicalAssetId)).toEqual([assetId]);

    const notFound = {
      error: {
        code: "USER_ASSET_NOT_FOUND",
        message: "One or more selected images are no longer available",
      },
    };
    const foreignUse = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userB,
      body: { prompt: "Build with their image", attachments: [assetId] },
    });
    expect(foreignUse.status).toBe(400);
    expect(foreignUse.body).toEqual(notFound);
    const foreignReference = await h.request("/api/dev/sites", {
      method: "POST",
      as: h.userB,
      body: {
        prompt: "Build like their image",
        attachments: [assetId],
        referenceAttachments: [assetId],
      },
    });
    expect(foreignReference.body).toEqual(notFound);
    const siteB = await h.site(h.userB.id, "Site B", "site-b:v1" as VersionId);
    const foreignEdit = await h.request(`/api/dev/sites/${siteB.id}/edit`, {
      method: "POST",
      as: h.userB,
      body: { prompt: "Use their image", attachments: [assetId] },
    });
    expect(foreignEdit.body).toEqual(notFound);
    expect(h.generateWebsite).toHaveBeenCalledOnce();
    expect(h.editWebsite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group E — owner override attacks
// ---------------------------------------------------------------------------

describe("owner override attacks", () => {
  const overrides = (victim: string) => [
    { ownerId: victim },
    { userId: victim },
    { user: victim },
    { createdBy: victim },
    {
      ownerId: victim,
      userId: victim,
      user: victim,
      createdBy: victim,
      role: "super_admin",
      is_admin: true,
      is_premium: true,
      plan_type: "enterprise",
      credits: 1e9,
    },
  ];

  it("E ignores client ownership fields when generating a site", async () => {
    const h = await harness();
    for (const override of overrides(h.userB.id)) {
      const response = await h.request("/api/dev/sites", {
        method: "POST",
        as: h.userA,
        body: { prompt: "Build a site...", ...override },
      });
      expect(response.status).toBe(202);
      await h.settle(response.body!.jobId as string);
      expect(h.generateWebsite.mock.lastCall![0].userId).toBe(h.userA.id);
    }
    expect((await h.projects.listByOwner(h.userB.id)).items).toEqual([]);
    const owned = (await h.projects.listByOwner(h.userA.id)).items;
    expect(owned).toHaveLength(5);
    expect(owned.every((project) => project.ownerId === h.userA.id)).toBe(true);
  });

  it("E ignores client ownership fields when creating a persistence site", async () => {
    const h = await harness();
    for (const override of overrides(h.userB.id)) {
      const response = await h.request("/api/dev/persistence/sites", {
        method: "POST",
        as: h.userA,
        body: { name: "Mine", ...override },
      });
      expect(response.status).toBe(201);
      const project = await h.projects.getById(response.body!.projectId as SiteId);
      expect(project?.ownerId).toBe(h.userA.id);
    }
    expect((await h.projects.listByOwner(h.userB.id)).items).toEqual([]);
    expect((await h.projects.listByOwner("local-playground-user")).items).toEqual([]);
  });
});
