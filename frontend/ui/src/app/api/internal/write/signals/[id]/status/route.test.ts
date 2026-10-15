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

const changeSignalStatusMock = vi.fn();
vi.mock("@/ee/features/signals/write-service", () => ({
  changeSignalStatus: (...args: unknown[]) => changeSignalStatusMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH } from "./route";

const params = { params: Promise.resolve({ id: "sig-1" }) };
const body = {
  actorUserId: "u1",
  projectId: "p1",
  transport: "public-api",
  change: { status: "resolved", reason: "fixed_by_pr" },
  expectedStatus: "open",
};

function makeRequest(payload: unknown) {
  return { json: async () => payload } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  changeSignalStatusMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/signals/[id]/status", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(body), params);
    expect(res.status).toBe(401);
    expect(changeSignalStatusMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the envelope is incomplete", async () => {
    const { projectId: _dropped, ...rest } = body;
    const res = await PATCH(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required" });
  });

  it("forwards the change, the expected status and the provenance", async () => {
    changeSignalStatusMock.mockResolvedValue({
      ok: true,
      changed: ["status"],
      data: { id: "sig-1", status: "resolved" },
    });
    const res = await PATCH(makeRequest(body), params);
    expect(changeSignalStatusMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      signalId: "sig-1",
      change: body.change,
      expectedStatus: "open",
      provenance: { transport: "public-api", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updated: true,
      changed: ["status"],
      signal: { id: "sig-1", status: "resolved" },
    });
  });

  it("forwards the agent session and reopen change", async () => {
    changeSignalStatusMock.mockResolvedValue({
      ok: true,
      changed: ["status"],
      data: { id: "sig-1", status: "open" },
    });
    await PATCH(
      makeRequest({ ...body, agentSessionId: "session-1", change: { status: "open" } }),
      params,
    );
    expect(changeSignalStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { status: "open" },
        provenance: { transport: "public-api", agentSessionId: "session-1" },
      }),
    );
  });

  it("returns 400 for invalid JSON", async () => {
    const request = makeRequest({});
    request.json = async () => {
      throw new SyntaxError("invalid");
    };
    expect((await PATCH(request, params)).status).toBe(400);
    expect(changeSignalStatusMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    changeSignalStatusMock.mockResolvedValue({ ok: false, status: 409, error: "changed" });
    const res = await PATCH(makeRequest(body), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "changed" });
  });
});
