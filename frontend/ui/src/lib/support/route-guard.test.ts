import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { impersonationDenial } from "./policy";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("./session", () => ({ impersonationContext: mocks.context }));
vi.mock("@traceroot/core", () => ({
  prisma: { auditLog: { create: mocks.create, update: mocks.update } },
}));
import { withImpersonationPolicy } from "./route-guard";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({
    user: { id: "customer", email: "customer@example.com" },
    session: { id: "sid", impersonatedBy: "staff" },
  });
  mocks.context.mockResolvedValue({
    valid: true,
    actor: { id: "staff", email: "staff@traceroot.ai", role: "support" },
  });
  mocks.create.mockResolvedValue({ id: "audit" });
  mocks.update.mockResolvedValue({});
});
describe("support policy", () => {
  it.each(["support", "admin"])("blocks all credential escapes for %s", (role) => {
    for (const [path, method] of [
      ["/api/github/token", "GET"],
      ["/api/auth/device/approve", "POST"],
      ["/api/auth/token", "GET"],
      ["/api/cli/token", "POST"],
      ["/api/projects/p/api-keys", "POST"],
      ["/api/github/callback", "GET"],
    ])
      expect(impersonationDenial(path, method, role)).toBeTruthy();
  });
  it("allows reads but blocks support writes before the handler", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withImpersonationPolicy(handler);
    expect((await route(new NextRequest("http://localhost/api/workspaces"))).status).toBe(200);
    handler.mockClear();
    expect(
      (await route(new NextRequest("http://localhost/api/workspaces", { method: "POST" }))).status,
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
  it("denies reads after expiry or revocation", async () => {
    mocks.context.mockResolvedValue({ valid: false });
    const handler = vi.fn();
    expect(
      (await withImpersonationPolicy(handler)(new NextRequest("http://localhost/api/workspaces")))
        .status,
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
  it("fails closed when durable write intent cannot be saved", async () => {
    mocks.context.mockResolvedValue({
      valid: true,
      actor: { id: "staff", email: "staff@traceroot.ai", role: "admin" },
    });
    mocks.create.mockRejectedValue(new Error("audit offline"));
    const handler = vi.fn();
    await expect(
      withImpersonationPolicy(handler)(
        new NextRequest("http://localhost/api/workspaces", { method: "POST" }),
      ),
    ).rejects.toThrow("audit offline");
    expect(handler).not.toHaveBeenCalled();
  });
  it("attributes writes to staff and preserves success on outcome-write failure", async () => {
    mocks.context.mockResolvedValue({
      valid: true,
      actor: { id: "staff", email: "staff@traceroot.ai", role: "admin" },
    });
    mocks.update.mockRejectedValue(new Error("offline"));
    const handler = vi.fn(async () => NextResponse.json({ id: "new" }, { status: 201 }));
    expect(
      (
        await withImpersonationPolicy(handler)(
          new NextRequest("http://localhost/api/workspaces", { method: "POST" }),
        )
      ).status,
    ).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "staff",
        targetUserId: "customer",
        impersonationSessionId: "sid",
        outcome: "pending",
      }),
    });
  });
  it("covers every cookie-authenticated route export", () => {
    const root = join(process.cwd(), "src/app/api");
    function walk(directory: string) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) walk(path);
        else if (item.name === "route.ts") {
          const relative = path.slice(root.length + 1);
          if (
            /^(auth|internal|public|cli|support)\//.test(relative) ||
            relative === "billing/webhook/route.ts" ||
            relative === "health/route.ts"
          )
            continue;
          const source = readFileSync(path, "utf8");
          expect(source, relative).toContain("withImpersonationPolicy");
          expect(source, relative).not.toMatch(/export async function (GET|POST|PUT|PATCH|DELETE)/);
        }
      }
    }
    walk(root);
  });
});
