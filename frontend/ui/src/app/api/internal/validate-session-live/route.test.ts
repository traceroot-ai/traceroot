import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const findUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { session: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  findUniqueMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/validate-session-live", () => {
  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ sessionId: "s1" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(badRequest);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid JSON" });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("returns 400 when sessionId is missing", async () => {
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("sessionId is required");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("returns live:true for a session row whose expiry is in the future", async () => {
    findUniqueMock.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });

    const res = await POST(makeRequest({ sessionId: "s1" }));

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "s1" },
      select: { expiresAt: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });

  it("returns live:false when no session row exists (revoked)", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ sessionId: "s-gone" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: false });
  });

  it("returns live:false for a session row that has already expired", async () => {
    findUniqueMock.mockResolvedValue({ expiresAt: new Date(Date.now() - 1_000) });

    const res = await POST(makeRequest({ sessionId: "s-old" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: false });
  });
});
