import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  rateLimitOk: vi.fn(() => true),
  deleteMany: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

vi.mock("@traceroot/core", () => ({
  prisma: { session: { deleteMany: (...args: unknown[]) => mocks.deleteMany(...args) } },
}));

vi.mock("@/lib/internal-session", () => ({
  resolveSessionFromToken: (...args: unknown[]) => mocks.resolveSession(...args),
}));

vi.mock("@/lib/mint-rate-limit", () => ({
  checkMintRateLimit: () => mocks.rateLimitOk(),
  rateLimitClientKey: () => "test-key",
}));

import { POST } from "./route";

function makeRequest(headers?: Record<string, string>) {
  return { headers: new Headers(headers ?? {}) } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  mocks.resolveSession.mockReset();
  mocks.rateLimitOk.mockReset();
  mocks.rateLimitOk.mockReturnValue(true);
  mocks.deleteMany.mockReset();
  mocks.deleteMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/cli/logout", () => {
  it("revokes the presenting session and returns revoked:true", async () => {
    mocks.resolveSession.mockResolvedValue({
      sessionId: "sess-1",
      user: { id: "u1", email: "u@example.com" },
    });

    const res = await POST(makeRequest({ authorization: "Bearer sess-abc" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(mocks.resolveSession).toHaveBeenCalledWith("sess-abc");
    // Scoped to ONLY the presented token — the delete can never target another
    // session, which is why bearer() stays off.
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMany.mock.calls[0][0]).toEqual({ where: { token: "sess-abc" } });
  });

  it("is idempotent: an unknown/expired token returns revoked:false without a delete", async () => {
    mocks.resolveSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ authorization: "Bearer nope" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("401s when no bearer token is present, without a lookup or delete", async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(401);
    expect(mocks.resolveSession).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("429s when rate limited, before touching the session lookup or delete", async () => {
    mocks.rateLimitOk.mockReturnValue(false);

    const res = await POST(makeRequest({ authorization: "Bearer sess-abc" }));

    expect(res.status).toBe(429);
    expect(mocks.resolveSession).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("surfaces a delete failure instead of reporting a false revoke", async () => {
    // The delete IS the logout, so unlike the mint route's best-effort slide a
    // deleteMany failure must propagate (a 500 to the caller), never be swallowed
    // into revoked:true. A future try/catch around the delete would break this.
    mocks.resolveSession.mockResolvedValue({
      sessionId: "sess-1",
      user: { id: "u1", email: "u@example.com" },
    });
    mocks.deleteMany.mockRejectedValue(new Error("db down"));

    await expect(POST(makeRequest({ authorization: "Bearer sess-abc" }))).rejects.toThrow(
      "db down",
    );
  });
});
