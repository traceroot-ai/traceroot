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

const setAlertStatusMock = vi.fn();
vi.mock("@/lib/write-services/alerts", () => ({
  setAlertStatus: (...args: unknown[]) => setAlertStatusMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH } from "./route";

const params = { params: Promise.resolve({ id: "alert-1" }) };
const body = { actorUserId: "u1", projectId: "p1", transport: "agent", status: "PAUSED" };

function makeRequest(payload: unknown) {
  return { json: async () => payload } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  setAlertStatusMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/alerts/[id]/status", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(body), params);
    expect(res.status).toBe(401);
    expect(setAlertStatusMock).not.toHaveBeenCalled();
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

  it("returns 400 when the envelope is incomplete or the status is missing", async () => {
    const { actorUserId: _dropped, ...rest } = body;
    expect((await PATCH(makeRequest(rest), params)).status).toBe(400);
    const res = await PATCH(
      makeRequest({ actorUserId: "u1", projectId: "p1", transport: "agent" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "status is required" });
    expect(setAlertStatusMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error, including the parked refusal", async () => {
    setAlertStatusMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "This alert was parked by the evaluator; resume it to run it again.",
    });
    const res = await PATCH(makeRequest(body), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This alert was parked by the evaluator; resume it to run it again.",
    });
  });

  it("forwards the status with the id from the path and answers with the reset flags", async () => {
    const alert = { id: "alert-1", status: "ACTIVE" };
    setAlertStatusMock.mockResolvedValue({
      ok: true,
      data: alert,
      changed: ["status"],
      stateReset: true,
      pageCleared: false,
    });
    const res = await PATCH(
      makeRequest({ ...body, status: "ACTIVE", agentSessionId: "as1" }),
      params,
    );
    expect(setAlertStatusMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      alertId: "alert-1",
      status: "ACTIVE",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updated: true,
      changed: ["status"],
      stateReset: true,
      pageCleared: false,
      alert,
    });
  });
});
