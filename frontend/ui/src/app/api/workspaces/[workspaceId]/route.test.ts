import { describe, it, expect, vi, beforeEach } from "vitest";

type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const workspaceUpdateMock = vi.fn();
const workspaceFindUniqueMock = vi.fn();
const workspaceDeleteMock = vi.fn();
const memberCountMock = vi.fn();
const auditCreateMock = vi.fn();

// The mutating handlers delegate to the write service, which runs its own
// membership check, its reads and its audit inside a transaction on this
// same client.
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  const client = {
    workspace: {
      findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args),
      update: (...args: unknown[]) => workspaceUpdateMock(...args),
      delete: (...args: unknown[]) => workspaceDeleteMock(...args),
    },
    workspaceMember: {
      findUnique: async () => ({ role: "ADMIN" }),
      count: (...args: unknown[]) => memberCountMock(...args),
    },
    project: { count: async () => 1 },
    auditLog: { create: (...args: unknown[]) => auditCreateMock(...args) },
    // The delete's locking read of the caller's user row.
    $queryRaw: async () => [{ id: "user-1" }],
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return {
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
    prisma: client,
  };
});

const requireAuthMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { PUT, DELETE } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PUT>[0];
}

function makeParams(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

beforeEach(() => {
  workspaceUpdateMock.mockReset();
  workspaceFindUniqueMock.mockReset();
  workspaceFindUniqueMock.mockResolvedValue({ id: "ws-1", name: "Old", createdBy: "user-1" });
  workspaceDeleteMock.mockReset();
  memberCountMock.mockReset();
  memberCountMock.mockResolvedValue(2);
  auditCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireWorkspaceMembershipMock.mockReset();
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
});

describe("PUT /api/workspaces/[workspaceId]", () => {
  it("renames the workspace and echoes the new name", async () => {
    const updateTime = new Date("2026-09-02T12:00:00Z");
    workspaceUpdateMock.mockResolvedValue({ id: "ws-1", name: "Renamed", updateTime });
    const res = (await PUT(makeRequest({ name: "Renamed" }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    expect(workspaceUpdateMock).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { name: "Renamed", updateTime: expect.any(Date) },
    });
    expect(await res.json()).toEqual({ id: "ws-1", name: "Renamed", update_time: updateTime });
  });

  it("maps a rename collision (Prisma P2002) to 409 instead of 500", async () => {
    workspaceUpdateMock.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = (await PUT(makeRequest({ name: "Taken" }), makeParams())) as MockResponse;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A workspace with this name already exists",
    );
  });

  it("propagates non-P2002 update failures", async () => {
    workspaceUpdateMock.mockRejectedValue(new Error("connection lost"));
    await expect(PUT(makeRequest({ name: "Renamed" }), makeParams())).rejects.toThrow(
      "connection lost",
    );
  });

  it("still requires a name, and answers the current name without a write", async () => {
    expect(((await PUT(makeRequest({}), makeParams())) as MockResponse).status).toBe(400);
    const res = (await PUT(makeRequest({ name: "Old" }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("records the rename on the audit log under the ui transport", async () => {
    workspaceUpdateMock.mockResolvedValue({ id: "ws-1", name: "Renamed", updateTime: new Date() });
    await PUT(makeRequest({ name: "Renamed" }), makeParams());
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "update_workspace",
        transport: "ui",
        summary: { changed: ["name"] },
      }),
    });
  });
});

describe("DELETE /api/workspaces/[workspaceId]", () => {
  it("deletes through the service with the current name as the typed confirmation when the app sends none", async () => {
    workspaceDeleteMock.mockResolvedValue({ id: "ws-1", name: "Old" });
    const res = (await DELETE(makeRequest(undefined), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(workspaceDeleteMock).toHaveBeenCalledWith({ where: { id: "ws-1" } });
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_workspace",
        transport: "ui",
        summary: { name: "Old", reason: "Deleted from the web app", cascaded: { projects: 1 } },
      }),
    });
  });

  it("honors a typed name and a reason when the app sends them", async () => {
    const res = (await DELETE(
      makeRequest({ name: "Wrong", reason: "closing the account" }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Workspace name does not match" });
    expect(workspaceDeleteMock).not.toHaveBeenCalled();
  });

  it("refuses the caller's only workspace with 409", async () => {
    memberCountMock.mockResolvedValue(1);
    const res = (await DELETE(makeRequest(undefined), makeParams())) as MockResponse;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Cannot delete your only workspace" });
  });

  it("404s a workspace that is gone", async () => {
    workspaceFindUniqueMock.mockResolvedValue(null);
    const res = (await DELETE(makeRequest(undefined), makeParams())) as MockResponse;
    expect(res.status).toBe(404);
  });
});
