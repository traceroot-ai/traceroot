import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  env: { LIFECYCLE_PAUSE_SECRET: "lead-service-test-secret" },
  findUnique: vi.fn(),
}));
vi.mock("@/env", () => ({ env: m.env }));
vi.mock("@traceroot/core", () => ({ prisma: { workspaceMember: { findUnique: m.findUnique } } }));

import { POST } from "./route";

const check = (body: unknown, token: string | null = "lead-service-test-secret") =>
  POST(
    new NextRequest("http://localhost/api/internal/workspace-members/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token !== null && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  m.env.LIFECYCLE_PAUSE_SECRET = "lead-service-test-secret";
  m.findUnique.mockReset();
});

describe("POST /api/internal/workspace-members/check", () => {
  it("says a current member is one, from the membership table", async () => {
    m.findUnique.mockResolvedValue({ role: "MEMBER" });
    const response = await check({ userId: "u1", workspaceId: "w1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: "u1",
      workspaceId: "w1",
      member: true,
      role: "MEMBER",
    });
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "w1", userId: "u1" } },
      select: { role: true },
    });
  });

  it("says someone removed from the workspace is no longer a member", async () => {
    m.findUnique.mockResolvedValue(null);
    const response = await check({ userId: "u1", workspaceId: "w1" });
    expect(await response.json()).toMatchObject({ member: false, role: null });
  });

  it("answers an error, never 'not a member', when the read fails", async () => {
    m.findUnique.mockRejectedValue(new Error("db down"));
    await expect(check({ userId: "u1", workspaceId: "w1" })).rejects.toThrow("db down");
  });

  it.each([
    ["no token", null],
    ["a wrong token", "nope"],
  ])("refuses %s, and reads nothing", async (_case, token) => {
    expect((await check({ userId: "u1", workspaceId: "w1" }, token)).status).toBe(401);
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it("is off when the lead service's secret is not set", async () => {
    m.env.LIFECYCLE_PAUSE_SECRET = "";
    expect((await check({ userId: "u1", workspaceId: "w1" }, "")).status).toBe(401);
  });

  it.each([{}, { userId: "u1" }, { userId: "u1", workspaceId: "w1", extra: 1 }])(
    "refuses a malformed request %j",
    async (body) => {
      expect((await check(body)).status).toBe(400);
      expect(m.findUnique).not.toHaveBeenCalled();
    },
  );
});
