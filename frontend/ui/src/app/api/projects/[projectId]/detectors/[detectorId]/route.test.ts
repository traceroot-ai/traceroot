import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorUpdateMock = vi.fn();
const detectorFindFirstMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: {
      update: (...args: unknown[]) => detectorUpdateMock(...args),
      findFirst: (...args: unknown[]) => detectorFindFirstMock(...args),
    },
  },
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

import { PATCH } from "./route";

function makeReq(bodyObj: Record<string, unknown>) {
  return {
    json: async () => bodyObj,
  } as unknown as Request;
}

const PARAMS = { params: Promise.resolve({ projectId: "p1", detectorId: "d1" }) };

describe("PATCH /api/projects/[projectId]/detectors/[detectorId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockResolvedValue({ user: { id: "u1" } });
    requireProjectAccessMock.mockResolvedValue({ error: null });
    detectorFindFirstMock.mockResolvedValue({ id: "d1", projectId: "p1" });
    detectorUpdateMock.mockResolvedValue({ id: "d1", name: "updated" });
  });

  it("updates filterSpanName when provided a string", async () => {
    const res = await PATCH(makeReq({ filterSpanName: "test-span" }), PARAMS);
    expect(res.status).toBe(200);
    
    expect(detectorUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ filterSpanName: "test-span" }),
      })
    );
  });

  it("clears filterSpanName when provided an empty string", async () => {
    const res = await PATCH(makeReq({ filterSpanName: "" }), PARAMS);
    expect(res.status).toBe(200);
    
    expect(detectorUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ filterSpanName: null }),
      })
    );
  });

  it("rejects non-string filterSpanName with 400", async () => {
    const res = await PATCH(makeReq({ filterSpanName: 123 }), PARAMS);
    expect(res.status).toBe(400);
    
    const json = await res.json();
    expect(json.error).toMatch(/must be a string/);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("leaves filterSpanName untouched when omitted", async () => {
    const res = await PATCH(makeReq({ name: "just-name" }), PARAMS);
    expect(res.status).toBe(200);
    
    const callData = detectorUpdateMock.mock.calls[0][0].data;
    expect("filterSpanName" in callData).toBe(false);
  });
});
