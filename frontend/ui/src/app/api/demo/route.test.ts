import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { impersonationDenial } from "@/lib/support/policy";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  project: vi.fn(),
  membership: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: mocks.auth,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown) => Response.json(data),
}));
vi.mock("@traceroot/core", () => ({
  Role: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
  prisma: {
    project: { findFirst: mocks.project },
    workspaceMember: {
      findUnique: mocks.membership,
      upsert: mocks.upsert,
      deleteMany: mocks.remove,
    },
  },
}));
import { GET, POST, DELETE } from "./route";
const request = (method = "GET") => new NextRequest("http://localhost/api/demo", { method });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo-workspace");
  mocks.auth.mockResolvedValue({ user: { id: "visitor" } });
  mocks.project.mockResolvedValue({ id: "demo-project" });
  mocks.membership.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({ role: "VIEWER" });
  mocks.remove.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([GET, POST, DELETE])("requires a real authenticated caller", async (handler) => {
  mocks.auth.mockResolvedValue({
    error: Response.json({ error: "Unauthorized" }, { status: 401 }),
  });
  expect((await handler(request())).status).toBe(401);
  expect(mocks.project).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it("reports availability without joining or returning configuration", async () => {
  const response = await GET(request());
  expect(await response.json()).toEqual({ available: true, joined: false, canLeave: false });
  expect(mocks.upsert).not.toHaveBeenCalled();
  expect(mocks.project).toHaveBeenCalledWith({
    where: { workspaceId: "demo-workspace", deleteTime: null },
    orderBy: { createTime: "asc" },
    select: { id: true },
  });
});

it.each(["VIEWER", "ADMIN"])("reports the caller's own %s membership", async (role) => {
  mocks.membership.mockResolvedValue({ role });
  expect(await (await GET(request())).json()).toEqual({
    available: true,
    joined: true,
    canLeave: role === "VIEWER",
  });
  expect(mocks.membership).toHaveBeenCalledWith({
    where: { workspaceId_userId: { workspaceId: "demo-workspace", userId: "visitor" } },
    select: { role: true },
  });
});

it("has no demo when configuration is absent", async () => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "");
  expect(await (await GET(request())).json()).toEqual({
    available: false,
    joined: false,
    canLeave: false,
  });
  expect((await POST(request("POST"))).status).toBe(404);
  expect((await DELETE(request("DELETE"))).status).toBe(404);
  expect(mocks.project).not.toHaveBeenCalled();
});

it("does not join a demo with no active project", async () => {
  mocks.project.mockResolvedValue(null);
  expect(await (await GET(request())).json()).toEqual({
    available: false,
    joined: false,
    canLeave: false,
  });
  expect((await POST(request("POST"))).status).toBe(404);
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it("still lets a visitor leave when the demo's last project was retired", async () => {
  mocks.project.mockResolvedValue(null);
  mocks.membership.mockResolvedValue({ role: "VIEWER" });
  expect(await (await GET(request())).json()).toEqual({
    available: false,
    joined: true,
    canLeave: true,
  });
  expect((await DELETE(request("DELETE"))).status).toBe(200);
});

it("joins only the caller to the configured workspace and preserves existing roles", async () => {
  const forged = new NextRequest("http://localhost/api/demo", {
    method: "POST",
    body: JSON.stringify({ userId: "someone-else", workspaceId: "private", role: "ADMIN" }),
  });
  for (let i = 0; i < 2; i++) {
    expect(await (await POST(forged)).json()).toEqual({ projectId: "demo-project" });
  }
  expect(mocks.upsert).toHaveBeenCalledTimes(2);
  expect(mocks.upsert).toHaveBeenLastCalledWith({
    where: { workspaceId_userId: { workspaceId: "demo-workspace", userId: "visitor" } },
    update: {},
    create: {
      id: expect.any(String),
      workspaceId: "demo-workspace",
      userId: "visitor",
      role: "VIEWER",
    },
  });
});

it("reports a failed join instead of returning a successful destination", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.upsert.mockRejectedValue(new Error("database unavailable"));
  const response = await POST(request("POST"));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Could not join the demo. Please try again." });
});

it("leaves only the caller's VIEWER membership, including a concurrent role change guard", async () => {
  mocks.membership.mockResolvedValue({ role: "VIEWER" });
  expect(await (await DELETE(request("DELETE"))).json()).toEqual({ left: true });
  expect(mocks.remove).toHaveBeenCalledWith({
    where: { workspaceId: "demo-workspace", userId: "visitor", role: "VIEWER" },
  });
});

it("leaving is idempotent when already absent", async () => {
  expect((await DELETE(request("DELETE"))).status).toBe(200);
});

it.each(["ADMIN", "MEMBER"])("cannot remove a maintainer with role %s", async (role) => {
  mocks.membership.mockResolvedValue({ role });
  expect((await DELETE(request("DELETE"))).status).toBe(403);
  expect(mocks.remove).not.toHaveBeenCalled();
});

it.each(["admin", "support"])("forbids membership writes while impersonating as %s", (role) => {
  expect(impersonationDenial("/api/demo", "POST", role)).toBeTruthy();
  expect(impersonationDenial("/api/demo/", "POST", role)).toBeTruthy();
  expect(impersonationDenial("/api/demo", "DELETE", role)).toBeTruthy();
  expect(impersonationDenial("/api/demo", "GET", role)).toBeNull();
});
