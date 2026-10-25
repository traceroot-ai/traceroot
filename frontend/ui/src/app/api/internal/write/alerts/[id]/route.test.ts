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

const updateAlertMock = vi.fn();
const deleteAlertMock = vi.fn();
vi.mock("@/lib/write-services/alerts", () => ({
  updateAlert: (...args: unknown[]) => updateAlertMock(...args),
  deleteAlert: (...args: unknown[]) => deleteAlertMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "alert-1" }) };
const patchBody = { actorUserId: "u1", projectId: "p1", transport: "public-api", threshold: 900 };
const deleteBody = { actorUserId: "u1", projectId: "p1", transport: "agent", reason: "replaced" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  updateAlertMock.mockReset();
  deleteAlertMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/alerts/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(401);
    expect(updateAlertMock).not.toHaveBeenCalled();
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
    const { projectId: _dropped, ...rest } = patchBody;
    const res = await PATCH(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required" });
  });

  it("maps a service failure to its status and error", async () => {
    updateAlertMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Invalid aggregation for measure",
    });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid aggregation for measure" });
  });

  it("passes the whole body as the patch with the id from the path, and answers with the reset flags", async () => {
    const alert = { id: "alert-1", name: "P99" };
    updateAlertMock.mockResolvedValue({
      ok: true,
      data: alert,
      changed: ["threshold"],
      stateReset: true,
      pageCleared: false,
    });
    const body = { ...patchBody, agentSessionId: "as1" };
    const res = await PATCH(makeRequest(body), params);
    expect(updateAlertMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      alertId: "alert-1",
      patch: body,
      provenance: { transport: "public-api", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updated: true,
      changed: ["threshold"],
      stateReset: true,
      pageCleared: false,
      alert,
    });
  });
});

describe("DELETE /api/internal/write/alerts/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(401);
    expect(deleteAlertMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the reason is missing", async () => {
    const { reason: _dropped, ...rest } = deleteBody;
    const res = await DELETE(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reason is required" });
  });

  it("maps a service failure to its status and error", async () => {
    deleteAlertMock.mockResolvedValue({ ok: false, status: 404, error: "Alert not found" });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Alert not found" });
  });

  it("forwards the id, reason and provenance, and answers deleted with the cleared page", async () => {
    deleteAlertMock.mockResolvedValue({
      ok: true,
      data: { id: "alert-1", name: "P99" },
      reason: "replaced",
      pageCleared: true,
    });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(deleteAlertMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      alertId: "alert-1",
      reason: "replaced",
      provenance: { transport: "agent", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: true,
      reason: "replaced",
      pageCleared: true,
      alert: { id: "alert-1", name: "P99" },
    });
  });
});
