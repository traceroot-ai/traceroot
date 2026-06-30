import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorCreateMock = vi.fn();
const detectorFindManyMock = vi.fn();
const detectorCountMock = vi.fn();
const transactionMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => transactionMock(...args),
    detector: {
      create: (...args: unknown[]) => detectorCreateMock(...args),
      findMany: (...args: unknown[]) => detectorFindManyMock(...args),
      count: (...args: unknown[]) => detectorCountMock(...args),
    },
  },
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { GET, POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function makeListRequest(url = "http://localhost/api/projects/proj-1/detectors") {
  return { nextUrl: new URL(url) } as unknown as Parameters<typeof GET>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

/** Minimal valid create payload — sampleRate intentionally omitted. */
function validBody(extra: Record<string, unknown> = {}) {
  return { name: "My detector", template: "failure", prompt: "Find failures", ...extra };
}

beforeEach(() => {
  detectorCreateMock.mockReset();
  detectorFindManyMock.mockReset();
  detectorCountMock.mockReset();
  transactionMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  detectorCreateMock.mockResolvedValue({ id: "det-1" });
  detectorFindManyMock.mockResolvedValue([]);
  detectorCountMock.mockResolvedValue(0);
  transactionMock.mockImplementation(async (operations: Promise<unknown>[]) =>
    Promise.all(operations),
  );
});

describe("GET .../detectors — access", () => {
  it("allows detector listing with project access only", async () => {
    const res = await GET(makeListRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1");
  });
});

describe("POST .../detectors — access", () => {
  it("requires MEMBER access to create detectors", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(201);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
  });

  it("does not create a detector when MEMBER access is denied", async () => {
    requireProjectAccessMock.mockResolvedValueOnce({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });
    const jsonMock = vi.fn().mockResolvedValue(validBody());

    const res = await POST(
      { json: jsonMock } as unknown as Parameters<typeof POST>[0],
      makeParams(),
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Requires MEMBER role or higher" });
    expect(jsonMock).not.toHaveBeenCalled();
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST .../detectors — sampleRate default", () => {
  it("defaults sampleRate to 25 when omitted", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock).toHaveBeenCalledTimes(1);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(25);
  });

  it("keeps an explicit sampleRate (100) instead of the default", async () => {
    const res = await POST(makeRequest(validBody({ sampleRate: 100 })), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(100);
  });

  it("rejects an out-of-range sampleRate", async () => {
    const res = await POST(makeRequest(validBody({ sampleRate: 101 })), makeParams());

    expect(res.status).toBe(400);
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});
