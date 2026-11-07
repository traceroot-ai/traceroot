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

const updateProjectMock = vi.fn();
const deleteProjectMock = vi.fn();
vi.mock("@/lib/write-services/projects", () => ({
  updateProject: (...args: unknown[]) => updateProjectMock(...args),
  deleteProject: (...args: unknown[]) => deleteProjectMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "p1" }) };
const patchBody = {
  actorUserId: "u1",
  transport: "public-api",
  name: "Checkout",
  traceTtlDays: null,
};
const deleteBody = { actorUserId: "u1", transport: "public-api", reason: "decommissioned" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  updateProjectMock.mockReset();
  deleteProjectMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/projects/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(401);
    expect(updateProjectMock).not.toHaveBeenCalled();
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
    const res = await PATCH(makeRequest({ transport: "agent", name: "x" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "actorUserId is required" });
  });

  it("exposes only name and traceTtlDays: the RCA and alert settings stay the web app's", async () => {
    updateProjectMock.mockResolvedValue({ ok: true, data: {}, changed: [] });
    await PATCH(makeRequest({ ...patchBody, rcaModel: "x", alertEmails: [] }), params);
    expect(updateProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { name: "Checkout", traceTtlDays: null } }),
    );
  });

  it("maps a service failure to its status and error", async () => {
    updateProjectMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Requires ADMIN role or higher",
    });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Requires ADMIN role or higher" });
  });

  it("forwards the id, the sent fields (null included) and provenance, and answers updated + changed", async () => {
    const project = { id: "p1", name: "Checkout" };
    updateProjectMock.mockResolvedValue({ ok: true, data: project, changed: ["trace_ttl_days"] });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(updateProjectMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      patch: { name: "Checkout", traceTtlDays: null },
      provenance: { transport: "public-api", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, changed: ["trace_ttl_days"], project });
  });
});

describe("DELETE /api/internal/write/projects/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(401);
    expect(deleteProjectMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the reason is missing", async () => {
    const { reason: _dropped, ...rest } = deleteBody;
    const res = await DELETE(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reason is required" });
  });

  it("maps a service failure to its status and error", async () => {
    deleteProjectMock.mockResolvedValue({ ok: false, status: 404, error: "Project not found" });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
  });

  it("forwards the id, reason and provenance, and answers deleted with the reason and the resource", async () => {
    deleteProjectMock.mockResolvedValue({
      ok: true,
      data: { id: "p1", name: "Checkout" },
      reason: "decommissioned",
    });
    const res = await DELETE(
      makeRequest({ ...deleteBody, transport: "agent", agentSessionId: "as1" }),
      params,
    );
    expect(deleteProjectMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      reason: "decommissioned",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: true,
      reason: "decommissioned",
      project: { id: "p1", name: "Checkout" },
    });
  });
});
