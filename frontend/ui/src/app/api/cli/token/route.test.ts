import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  signJWT: vi.fn(),
  resolveSession: vi.fn(),
  rateLimitOk: vi.fn(() => true),
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
  });

  it("401s when no bearer token is present, without a lookup", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it("401s when the session is invalid or expired, without minting", async () => {
    mocks.resolveSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
    expect(mocks.signJWT).not.toHaveBeenCalled();
  });

  it("429s when rate limited, before touching the session lookup", async () => {
    mocks.rateLimitOk.mockReturnValue(false);
    const res = await POST(makeRequest({ authorization: "Bearer sess-abc" }));
    expect(res.status).toBe(429);
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });
});
