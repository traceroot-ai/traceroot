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

const updateDetectorMock = vi.fn();
const deleteDetectorMock = vi.fn();
vi.mock("@/lib/write-services/detectors", () => ({
  updateDetector: (...args: unknown[]) => updateDetectorMock(...args),
  deleteDetector: (...args: unknown[]) => deleteDetectorMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "det1" }) };
const patchBody = {
  actorUserId: "u1",
  projectId: "p1",
  transport: "public-api",
  sampleRate: 50,
  detectionModel: null,
  triggerConditions: [],
};
const deleteBody = { actorUserId: "u1", projectId: "p1", transport: "agent", reason: "obsolete" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  updateDetectorMock.mockReset();
  deleteDetectorMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/detectors/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(401);
    expect(updateDetectorMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await PATCH(
      {
        json: async () => {
          throw new SyntaxError("bad json");
        },
      } as unknown as Parameters<typeof PATCH>[0],
      params,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("returns 400 when the envelope is incomplete", async () => {
    const { actorUserId: _dropped, ...rest } = patchBody;
    const res = await PATCH(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "actorUserId is required" });
  });

  it("maps a service failure to its status and error", async () => {
    updateDetectorMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "A detector with this name already exists",
    });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A detector with this name already exists" });
  });

  it("forwards the id, the sent fields (null included) and provenance, and answers updated + changed", async () => {
    const detector = { id: "det1", name: "Timeouts" };
    updateDetectorMock.mockResolvedValue({ ok: true, data: detector, changed: ["sample_rate"] });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(updateDetectorMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      detectorId: "det1",
      patch: { sampleRate: 50, detectionModel: null, triggerConditions: [] },
      provenance: { transport: "public-api", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, changed: ["sample_rate"], detector });
  });
});

describe("DELETE /api/internal/write/detectors/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(401);
    expect(deleteDetectorMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the reason is missing", async () => {
    const { reason: _dropped, ...rest } = deleteBody;
    const res = await DELETE(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reason is required" });
  });

  it("maps a service failure to its status and error", async () => {
    deleteDetectorMock.mockResolvedValue({ ok: false, status: 404, error: "Detector not found" });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Detector not found" });
  });

  it("forwards the id, reason and provenance, and answers deleted with the reason and the resource", async () => {
    deleteDetectorMock.mockResolvedValue({
      ok: true,
      data: { id: "det1", name: "Timeouts" },
      reason: "obsolete",
    });
    const res = await DELETE(makeRequest({ ...deleteBody, agentSessionId: "as1" }), params);
    expect(deleteDetectorMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      detectorId: "det1",
      reason: "obsolete",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: true,
      reason: "obsolete",
      detector: { id: "det1", name: "Timeouts" },
    });
  });
});
