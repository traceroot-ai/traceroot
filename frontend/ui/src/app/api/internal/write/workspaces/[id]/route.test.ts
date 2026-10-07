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

const updateWorkspaceMock = vi.fn();
const deleteWorkspaceMock = vi.fn();
vi.mock("@/lib/write-services/workspaces", () => ({
  updateWorkspace: (...args: unknown[]) => updateWorkspaceMock(...args),
  deleteWorkspace: (...args: unknown[]) => deleteWorkspaceMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "w1" }) };
const patchBody = { actorUserId: "u1", transport: "public-api", name: "Acme Corp" };
const deleteBody = { actorUserId: "u1", transport: "public-api", name: "Acme", reason: "moved" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  updateWorkspaceMock.mockReset();
  deleteWorkspaceMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/workspaces/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(401);
    expect(updateWorkspaceMock).not.toHaveBeenCalled();
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
    const res = await PATCH(makeRequest({ transport: "public-api", name: "x" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "actorUserId is required" });
  });

  it("maps a service failure to its status and error", async () => {
    updateWorkspaceMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "A workspace with this name already exists",
    });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A workspace with this name already exists" });
  });

  it("forwards the id, the sent fields and provenance, and answers updated + changed", async () => {
    // The public proxy reads `role` off this row, so the fixture carries it.
    const workspace = { id: "w1", name: "Acme Corp", role: "ADMIN" };
    updateWorkspaceMock.mockResolvedValue({ ok: true, data: workspace, changed: ["name"] });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(updateWorkspaceMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      workspaceId: "w1",
      patch: { name: "Acme Corp" },
      provenance: { transport: "public-api", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, changed: ["name"], workspace });
  });
});

describe("DELETE /api/internal/write/workspaces/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(401);
    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the typed name or the reason is missing", async () => {
    const { name: _name, ...noName } = deleteBody;
    const noNameRes = await DELETE(makeRequest(noName), params);
    expect(noNameRes.status).toBe(400);
    expect(await noNameRes.json()).toEqual({ error: "name is required" });
    const { reason: _reason, ...noReason } = deleteBody;
    const noReasonRes = await DELETE(makeRequest(noReason), params);
    expect(noReasonRes.status).toBe(400);
    expect(await noReasonRes.json()).toEqual({ error: "reason is required" });
    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error, including the name mismatch", async () => {
    deleteWorkspaceMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Workspace name does not match",
    });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Workspace name does not match" });
  });

  it("forwards the id, typed name, reason and provenance, and answers deleted with the cascade", async () => {
    deleteWorkspaceMock.mockResolvedValue({
      ok: true,
      data: { id: "w1", name: "Acme" },
      reason: "moved",
      cascaded: { projects: 2 },
    });
    const res = await DELETE(
      makeRequest({ ...deleteBody, transport: "agent", agentSessionId: "as1" }),
      params,
    );
    expect(deleteWorkspaceMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Acme",
      reason: "moved",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: true,
      reason: "moved",
      cascaded: { projects: 2 },
      workspace: { id: "w1", name: "Acme" },
    });
  });
});
