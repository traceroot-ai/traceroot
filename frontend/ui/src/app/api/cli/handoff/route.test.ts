import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The business handler is what is under test; the shared impersonation policy
// has its own coverage in support/route-guard.test.ts. (It matters here: that
// policy is what stops an impersonating employee minting a handoff, because
// impersonationDenial refuses every /api/cli/* path.)
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const ORIGIN = "https://app.traceroot.ai";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  project: vi.fn(),
  membership: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  rateLimitOk: vi.fn((_key: string, _max: number, _windowMs: number) => true),
}));

vi.mock("@/env", () => ({ env: { BETTER_AUTH_URL: "https://app.traceroot.ai/" } }));
vi.mock("@/lib/request-session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/mint-rate-limit", () => ({
  checkMintRateLimit: (key: string, max: number, windowMs: number) =>
    mocks.rateLimitOk(key, max, windowMs),
  rateLimitClientKey: () => "test-client",
}));
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  hasMinRole: (role: string, min: string) =>
    ["VIEWER", "MEMBER", "ADMIN"].indexOf(role) >= ["VIEWER", "MEMBER", "ADMIN"].indexOf(min),
  prisma: {
    project: { findUnique: (...a: unknown[]) => mocks.project(...a) },
    workspaceMember: { findUnique: (...a: unknown[]) => mocks.membership(...a) },
    cliHandoff: {
      deleteMany: (...a: unknown[]) => mocks.deleteMany(...a),
      create: (...a: unknown[]) => mocks.create(...a),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        cliHandoff: {
          deleteMany: (...a: unknown[]) => mocks.deleteMany(...a),
          create: (...a: unknown[]) => mocks.create(...a),
        },
      }),
  },
}));

import { POST } from "./route";

function request(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return {
    headers: new Headers(headers),
    json: async () => {
      if (body === "malformed") throw new SyntaxError("bad json");
      return body;
    },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimitOk.mockReturnValue(true);
  mocks.session.mockResolvedValue({
    user: { id: "u1", email: "u@example.com", name: null },
    session: { id: "browser-session" },
  });
  mocks.project.mockResolvedValue({ id: "p1", workspaceId: "w1", name: "Proj" });
  mocks.membership.mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "MEMBER" });
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "handoff-1",
    ...data,
  }));
});

describe("POST /api/cli/handoff", () => {
  it("mints a trh_ ticket bound to the user, the project and the issuing tab", async () => {
    const before = Date.now();
    const res = await POST(request({ projectId: "p1" }));
    const body = (await res.json()) as { code: string; expiresIn: number; expiresAt: string };

    expect(res.status).toBe(200);
    // base64url of 32 bytes is 43 characters of [A-Za-z0-9_-], which the
    // hand-back step can print unquoted on a shell line.
    expect(body.code).toMatch(/^trh_[A-Za-z0-9_-]{43}$/);
    // camelCase, matching /api/cli/token -- not the RFC 8628 snake_case of the
    // device endpoints, which this is not.
    expect(body.expiresIn).toBe(600);
    const expiresAt = Date.parse(body.expiresAt);
    expect(body.expiresAt).toBe(new Date(expiresAt).toISOString());
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiresAt).toBeLessThan(before + 600_000 + 5000);

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.userId).toBe("u1");
    expect(data.issuedBySessionId).toBe("browser-session");
    expect(data.projectId).toBe("p1");
    expect(data.workspaceId).toBe("w1");
    expect(data.expiresAt.getTime()).toBe(expiresAt);
  });

  it("stores only the SHA-256 of the code, never the code", async () => {
    const res = await POST(request({ projectId: "p1" }));
    const { code } = (await res.json()) as { code: string };

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.codeHash).toBe(createHash("sha256").update(code).digest("hex"));
    expect(data.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // A read of the table must not yield a usable credential.
    expect(JSON.stringify(data)).not.toContain(code);
  });

  it("issues a different code every time", async () => {
    const first = (await (await POST(request({ projectId: "p1" }))).json()) as { code: string };
    const second = (await (await POST(request({ projectId: "p1" }))).json()) as { code: string };
    expect(first.code).not.toBe(second.code);
  });

  it("keeps one live handoff per user: the mint drops the rest in the same transaction", async () => {
    const order: string[] = [];
    mocks.deleteMany.mockImplementation(async () => {
      order.push("delete");
      return { count: 2 };
    });
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      order.push("create");
      return { id: "handoff-1", ...data };
    });

    await POST(request({ projectId: "p1" }));

    // Scoped to this user and to UNREDEEMED rows: a code the user's own
    // terminal claimed a moment ago keeps its provenance.
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", redeemedAt: null },
    });
    expect(order).toEqual(["delete", "create"]);
  });

  it("401s without a session, writing nothing", async () => {
    mocks.session.mockResolvedValue(null);
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("403s for a project the user is not a member of", async () => {
    mocks.membership.mockResolvedValue(null);
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("403s when the user is below MEMBER on the project's workspace", async () => {
    mocks.membership.mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "VIEWER" });
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("404s for a project that does not exist", async () => {
    mocks.project.mockResolvedValue(null);
    const res = await POST(request({ projectId: "nope" }));
    expect(res.status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("400s on a missing or malformed body", async () => {
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request("malformed"))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin POST before touching the session", async () => {
    const res = await POST(request({ projectId: "p1" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();

    const missing = await POST(request({ projectId: "p1" }, {}));
    expect(missing.status).toBe(403);
  });

  it("rate limits on its own budget, not the one /api/cli/token spends", async () => {
    mocks.rateLimitOk.mockReturnValue(false);
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(429);
    expect(mocks.rateLimitOk).toHaveBeenCalledWith("cli-handoff-mint:test-client", 10, 60_000);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
