import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH, TEST_SECRET } from "./internal-auth-support.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  projectWorkspaceId: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {},
  syncStandardPrices: vi.fn(async () => {}),
  calculateCost: vi.fn(async () => 0),
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("../session.js", () => ({
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  getSessionMessages: mocks.getSessionMessages,
  listSessions: mocks.listSessions,
  deleteSession: mocks.deleteSession,
  updateSessionTitle: vi.fn(),
  executionBelongsToProject: vi.fn(),
  projectWorkspaceId: mocks.projectWorkspaceId,
}));
vi.mock("../agent.js", () => ({
  getOrCreateAgent: vi.fn(),
  runAgent: vi.fn(),
  removeAgent: vi.fn(),
  abortSessionRun: vi.fn(),
  invalidateProviderCache: mocks.invalidateProviderCache,
}));
vi.mock("../executors/index.js", () => ({ createExecutor: vi.fn() }));
vi.mock("../tools/index.js", () => ({ createTools: vi.fn(() => []) }));
vi.mock("../prompts/system.js", () => ({ getSystemPrompt: vi.fn(() => "") }));

import { app } from "../index.js";
import { assertInternalSecretConfigured } from "../internal-auth.js";

const P = "/api/v1/projects/p1";
const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.projectWorkspaceId.mockResolvedValue("w1");
  mocks.createSession.mockResolvedValue({ id: "new" });
  vi.stubEnv("INTERNAL_API_SECRET", TEST_SECRET);
});

function noStoreTouched() {
  for (const m of Object.values(mocks)) {
    if (m === mocks.projectWorkspaceId) continue;
    expect(m).not.toHaveBeenCalled();
  }
}

describe("requests without the internal credential", () => {
  const routes: Array<[string, string]> = [
    ["POST", `${P}/sessions`],
    ["GET", `${P}/sessions`],
    ["GET", `${P}/sessions/s1`],
    ["GET", `${P}/sessions/s1/messages`],
    ["DELETE", `${P}/sessions/s1`],
    ["POST", `${P}/sessions/s1/messages`],
    ["POST", `${P}/sessions/s1/decisions`],
    ["POST", "/api/v1/cache/invalidate-provider"],
  ];

  it("covers every route the service registers", () => {
    const registered = app.routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !r.endsWith(" /*") && r !== "GET /health" && !r.startsWith("ALL "));
    const covered = routes.map(
      ([m, p]) => `${m} ${p.replace("/p1/", "/:projectId/").replace("/s1", "/:sessionId")}`,
    );
    expect(registered.sort()).toEqual(covered.sort());
  });

  it.each(routes)("%s %s is refused before any handler runs", async (method, path) => {
    for (const headers of [
      {},
      { "x-user-id": "u1", "x-workspace-id": "w1" },
      { "X-Internal-Secret": "" },
      { "X-Internal-Secret": "wrong" },
      { "X-Internal-Secret": TEST_SECRET.slice(0, -1) },
      { "X-Internal-Secret": `${TEST_SECRET}x` },
    ]) {
      const res = await app.request(path, {
        method,
        headers: { ...JSON_HEADERS, ...headers },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    noStoreTouched();
    expect(mocks.projectWorkspaceId).not.toHaveBeenCalled();
  });

  it("leaves the health check open", async () => {
    expect((await app.request("/health")).status).toBe(200);
  });

  it("answers 503 when the service has no usable credential", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "changeme");
    const res = await app.request(`${P}/sessions`, {
      headers: { "X-Internal-Secret": "changeme" },
    });
    expect(res.status).toBe(503);
  });
});

describe("startup check", () => {
  it.each(["", "   ", "changeme", "dev-internal-secret"])("refuses %j", (value) => {
    vi.stubEnv("INTERNAL_API_SECRET", value);
    expect(() => assertInternalSecretConfigured()).toThrow("INTERNAL_API_SECRET");
  });
  it("accepts a generated value", () => {
    expect(() => assertInternalSecretConfigured()).not.toThrow();
  });
});

describe("identity on an authenticated call", () => {
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(path, { ...init, headers: { ...AUTH, ...JSON_HEADERS, ...init.headers } });

  it.each([
    ["GET", `${P}/sessions`],
    ["GET", `${P}/sessions/s1`],
    ["GET", `${P}/sessions/s1/messages`],
    ["DELETE", `${P}/sessions/s1`],
    ["POST", `${P}/sessions/s1/decisions`],
  ])("%s %s needs a user, and a system marker is not one", async (method, path) => {
    const body = method === "POST" ? "{}" : undefined;
    expect((await call(path, { method, body })).status).toBe(400);
    expect(
      (await call(path, { method, body, headers: { "x-agent-system-call": "1" } })).status,
    ).toBe(400);
    noStoreTouched();
  });

  it("message and create calls need a user or the system marker, not both or neither", async () => {
    for (const path of [`${P}/sessions`, `${P}/sessions/s1/messages`]) {
      const none = await call(path, { method: "POST", body: "{}" });
      const both = await call(path, {
        method: "POST",
        body: "{}",
        headers: { "x-user-id": "u1", "x-agent-system-call": "1" },
      });
      expect([none.status, both.status]).toEqual([400, 400]);
    }
    noStoreTouched();
  });

  it("creates a system session only when the call says it is one", async () => {
    const res = await call(`${P}/sessions`, {
      method: "POST",
      body: "{}",
      headers: { "x-agent-system-call": "1", "x-workspace-id": "w1" },
    });
    expect(res.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined }),
    );
  });

  it("uses the project's own workspace and rejects a different one", async () => {
    const ok = await call(`${P}/sessions`, {
      method: "POST",
      body: "{}",
      headers: { "x-user-id": "u1" },
    });
    expect(ok.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", userId: "u1" }),
    );

    mocks.createSession.mockClear();
    const mismatch = await call(`${P}/sessions`, {
      method: "POST",
      body: "{}",
      headers: { "x-user-id": "u1", "x-workspace-id": "w2" },
    });
    expect(mismatch.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("answers 404 for a project that does not exist", async () => {
    mocks.projectWorkspaceId.mockResolvedValue(null);
    const res = await call(`${P}/sessions`, {
      method: "POST",
      body: "{}",
      headers: { "x-user-id": "u1" },
    });
    expect(res.status).toBe(404);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("scopes reads and deletes to the user named on the authenticated call", async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.deleteSession.mockResolvedValue(null);
    expect((await call(`${P}/sessions/s1`, { headers: { "x-user-id": "intruder" } })).status).toBe(
      404,
    );
    expect(mocks.getSession).toHaveBeenCalledWith("s1", "intruder", "p1");
    expect(
      (await call(`${P}/sessions/s1`, { method: "DELETE", headers: { "x-user-id": "intruder" } }))
        .status,
    ).toBe(404);
    expect(mocks.deleteSession).toHaveBeenCalledWith("s1", "intruder", "p1");
  });
});
