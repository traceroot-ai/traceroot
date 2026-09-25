import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  signJWT: vi.fn(),
  resolveSession: vi.fn(),
  rateLimitOk: vi.fn(() => true),
  updateMany: vi.fn(),
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
  prisma: { session: { updateMany: (...args: unknown[]) => mocks.updateMany(...args) } },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { signJWT: (...args: unknown[]) => mocks.signJWT(...args) } },
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
  mocks.signJWT.mockReset();
  mocks.resolveSession.mockReset();
  mocks.rateLimitOk.mockReset();
  mocks.rateLimitOk.mockReturnValue(true);
  mocks.updateMany.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/cli/token", () => {
  it("mints a JWT for a valid session token, carrying sub/email/aud/sid explicitly", async () => {
    mocks.resolveSession.mockResolvedValue({
      sessionId: "sess-1",
      user: { id: "u1", email: "u@example.com" },
    });
    mocks.signJWT.mockResolvedValue({ token: "the.jwt.token" });

    const res = await POST(makeRequest({ authorization: "Bearer sess-abc" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ accessToken: "the.jwt.token", tokenType: "Bearer", expiresIn: 600 });
    expect(mocks.resolveSession).toHaveBeenCalledWith("sess-abc");

    // sub must be in the payload — auth.api.signJWT only sets it when present.
    const payload = mocks.signJWT.mock.calls[0][0].body.payload;
    expect(payload.sub).toBe("u1");
    expect(payload.email).toBe("u@example.com");
    expect(payload.aud).toBe("traceroot-api");
    // sid carries the session row id for the future write-path revocation check.
    expect(payload.sid).toBe("sess-1");

    // The session's expiry is slid forward on mint, guarded by updateAge (the
    // where clause) so an active CLI writes at most once/day. expiresAt lands ~7
    // days out — the inactivity window, not a fixed time from login.
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    const refresh = mocks.updateMany.mock.calls[0][0];
    const DAY = 24 * 60 * 60 * 1000;
    expect(refresh.where.token).toBe("sess-abc");
    // The guard only slides a session older than updateAge (~1 day back), so an
    // active CLI minting every ~10 min writes at most once/day. Pin the sign +
    // magnitude so flipping the guard or changing SESSION_UPDATE_AGE is caught.
    expect(refresh.where.updatedAt.lt.getTime()).toBeGreaterThan(Date.now() - DAY - 5000);
    expect(refresh.where.updatedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - DAY + 5000);
    expect(refresh.data.updatedAt).toBeInstanceOf(Date);
    // expiresAt lands ~7 days out — the inactivity window, not a fixed time from login.
    expect(refresh.data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(refresh.data.expiresAt.getTime()).toBeLessThan(Date.now() + 8 * DAY);
  });

  it("still mints when the session refresh write fails (best-effort, non-fatal)", async () => {
    mocks.resolveSession.mockResolvedValue({
      sessionId: "sess-1",
      user: { id: "u1", email: "u@example.com" },
    });
    mocks.signJWT.mockResolvedValue({ token: "the.jwt.token" });
    mocks.updateMany.mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeRequest({ authorization: "Bearer sess-abc" }));

    expect(res.status).toBe(200);
    expect((await res.json()).accessToken).toBe("the.jwt.token");
    // The failure is swallowed but logged, not silently dropped.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("401s when no bearer token is present, without a lookup or refresh", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(mocks.resolveSession).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("401s when the session is invalid or expired, without minting or refreshing", async () => {
    mocks.resolveSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
    expect(mocks.signJWT).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("429s when rate limited, before touching the session lookup", async () => {
    mocks.rateLimitOk.mockReturnValue(false);
    const res = await POST(makeRequest({ authorization: "Bearer sess-abc" }));
    expect(res.status).toBe(429);
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });
});
