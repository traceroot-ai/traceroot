import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ deleteMany: vi.fn(), requireProjectAccess: vi.fn() }));

vi.mock("@traceroot/core", () => ({
  Role: { MEMBER: "MEMBER" },
  prisma: { projectLabel: { deleteMany: mocks.deleteMany } },
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

import { DELETE } from "./route";

function deleteLabel() {
  return DELETE(
    new NextRequest("http://ui.test/api/projects/project-a/labels/label-a", { method: "DELETE" }),
    { params: Promise.resolve({ projectId: "project-a", labelId: "label-a" }) },
  );
}

beforeEach(() => vi.resetAllMocks());

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
