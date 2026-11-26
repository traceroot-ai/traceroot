import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  Role: { MEMBER: "MEMBER" },
  prisma: { projectLabel: { create: mocks.create, findMany: mocks.findMany } },
}));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireProjectAccess: mocks.requireProjectAccess,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown, status: number) => Response.json(data, { status }),
}));

import { GET, POST } from "./route";

const url = "http://ui.test/api/projects/project-1/labels";
const context = { params: Promise.resolve({ projectId: "project-1" }) };
const label = { id: "label-1", name: "Needs review", description: null };

function createLabel(body: object) {
  return POST(new NextRequest(url, { method: "POST", body: JSON.stringify(body) }), context);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: "project-1" } });
});

it("lists labels scoped to the project without requiring a write role", async () => {
  mocks.findMany.mockResolvedValue([label]);

  const response = await GET(new NextRequest(url), context);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ labels: [label] });
  expect(mocks.requireProjectAccess).toHaveBeenCalledWith("user-1", "project-1", undefined);
  expect(mocks.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { projectId: "project-1" } }),
  );
});

it("requires MEMBER before creating a label", async () => {
  mocks.requireProjectAccess.mockResolvedValue({ error: new Response(null, { status: 403 }) });

  expect((await createLabel({ name: label.name })).status).toBe(403);
  expect(mocks.requireProjectAccess).toHaveBeenCalledWith("user-1", "project-1", "MEMBER");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("rejects invalid names before creating a label", async () => {
  expect((await createLabel({ name: " " })).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("creates a project label from the trimmed name and authenticated author", async () => {
  mocks.create.mockResolvedValue(label);

  const response = await createLabel({ name: " Needs review " });

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ label });
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { projectId: "project-1", name: label.name, description: null, createdBy: "user-1" },
    }),
  );
});

it("returns 409 when a project label name already exists", async () => {
  mocks.create.mockRejectedValue({ code: "P2002" });

  const response = await createLabel({ name: label.name });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "That label already exists" });
});
