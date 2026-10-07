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

const updateDashboardMock = vi.fn();
const deleteDashboardMock = vi.fn();
vi.mock("@/lib/write-services/dashboards", () => ({
  updateDashboard: (...args: unknown[]) => updateDashboardMock(...args),
  deleteDashboard: (...args: unknown[]) => deleteDashboardMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "dash1" }) };
const patchBody = {
  actorUserId: "u1",
  projectId: "p1",
  transport: "public-api",
  name: "Costs",
  description: null,
};
const deleteBody = { actorUserId: "u1", projectId: "p1", transport: "agent", reason: "obsolete" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  updateDashboardMock.mockReset();
  deleteDashboardMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/dashboards/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(401);
    expect(updateDashboardMock).not.toHaveBeenCalled();
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

  it("does not expose layout, which stays the web app's drag interaction", async () => {
    updateDashboardMock.mockResolvedValue({ ok: true, data: {}, changed: [] });
    await PATCH(makeRequest({ ...patchBody, layout: [] }), params);
    expect(updateDashboardMock).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { name: "Costs", description: null } }),
    );
  });

  it("maps a service failure to its status and error", async () => {
    updateDashboardMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "A dashboard with this name already exists",
    });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A dashboard with this name already exists" });
  });

  it("forwards the id, the sent fields and provenance, and answers updated + changed", async () => {
    const dashboard = { id: "dash1", name: "Costs" };
    updateDashboardMock.mockResolvedValue({ ok: true, data: dashboard, changed: ["name"] });
    const res = await PATCH(makeRequest({ ...patchBody, agentSessionId: "as1" }), params);
    expect(updateDashboardMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      dashboardId: "dash1",
      patch: { name: "Costs", description: null },
      provenance: { transport: "public-api", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, changed: ["name"], dashboard });
  });
});

describe("DELETE /api/internal/write/dashboards/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(401);
    expect(deleteDashboardMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the reason is missing", async () => {
    const { reason: _dropped, ...rest } = deleteBody;
    const res = await DELETE(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reason is required" });
  });

  it("maps a service failure to its status and error, including the last-dashboard refusal", async () => {
    deleteDashboardMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Cannot delete a project's last dashboard",
    });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Cannot delete a project's last dashboard" });
  });

  it("forwards the id, reason and provenance, and answers deleted with the cascade", async () => {
    deleteDashboardMock.mockResolvedValue({
      ok: true,
      data: { id: "dash1", name: "Costs" },
      reason: "obsolete",
      cascaded: { widgets: 4 },
    });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(deleteDashboardMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      dashboardId: "dash1",
      reason: "obsolete",
      provenance: { transport: "agent", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: true,
      reason: "obsolete",
      cascaded: { widgets: 4 },
      dashboard: { id: "dash1", name: "Costs" },
    });
  });
});
