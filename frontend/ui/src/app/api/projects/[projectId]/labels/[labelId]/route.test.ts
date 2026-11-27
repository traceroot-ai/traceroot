import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  update: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  Role: { MEMBER: "MEMBER" },
  prisma: { projectLabel: { deleteMany: mocks.deleteMany, update: mocks.update } },
}));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "member-a" } }),
  requireProjectAccess: mocks.requireProjectAccess,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown) => Response.json(data),
}));

import { DELETE, PATCH } from "./route";

function deleteLabel() {
  return DELETE(
    new NextRequest("http://ui.test/api/projects/project-a/labels/label-a", { method: "DELETE" }),
    { params: Promise.resolve({ projectId: "project-a", labelId: "label-a" }) },
  );
}

beforeEach(() => vi.resetAllMocks());

describe("PATCH project label", () => {
  function editLabel(body: object) {
    return PATCH(
      new NextRequest("http://ui.test/api/projects/project-a/labels/label-a", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId: "project-a", labelId: "label-a" }) },
    );
  }

  it("updates only the description of the requested project label", async () => {
    const label = { id: "label-a", name: "Needs review", description: "New description" };
    mocks.requireProjectAccess.mockResolvedValue({ project: { id: "project-a" } });
    mocks.update.mockResolvedValue(label);

    const response = await editLabel({ description: " New description " });

    expect(await response.json()).toEqual({ label });
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("member-a", "project-a", "MEMBER");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "label-a", projectId: "project-a" },
      data: { description: "New description" },
      select: { id: true, name: true, description: true },
    });
  });

  it("rejects a rename and returns 404 when the project label is missing", async () => {
    mocks.requireProjectAccess.mockResolvedValue({ project: { id: "project-a" } });
    expect((await editLabel({ name: "New name", description: null })).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.update.mockRejectedValue({ code: "P2025" });
    expect((await editLabel({ description: null })).status).toBe(404);
  });
});

describe("DELETE project label", () => {
  it("requires member access before touching project labels", async () => {
    mocks.requireProjectAccess.mockResolvedValue({ error: new Response(null, { status: 403 }) });

    expect((await deleteLabel()).status).toBe(403);
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("member-a", "project-a", "MEMBER");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only the requested project label and treats a repeated request as success", async () => {
    mocks.requireProjectAccess.mockResolvedValue({ project: { id: "project-a" } });
    mocks.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const first = await deleteLabel();
    const retry = await deleteLabel();

    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect(retry.status).toBe(204);
    expect(mocks.deleteMany.mock.calls).toEqual([
      [{ where: { id: "label-a", projectId: "project-a" } }],
      [{ where: { id: "label-a", projectId: "project-a" } }],
    ]);
  });
});
