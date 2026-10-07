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
vi.mock("@/env", () => ({ env: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("./session", () => ({ impersonationContext: mocks.context }));
vi.mock("@traceroot/core", () => ({
  prisma: { auditLog: { create: mocks.create, update: mocks.update } },
}));
import { withImpersonationPolicy } from "./route-guard";
import { requireAuth } from "@/lib/auth-helpers";
import { supportRequest } from "./request-context";

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
  it.each(["ordinary", "impersonated", "anonymous"])(
    "shares one session resolution with requireAuth for %s requests",
    async (kind) => {
      if (kind === "ordinary")
        mocks.session.mockResolvedValue({ user: { id: "employee" }, session: { id: "login" } });
      if (kind === "anonymous") mocks.session.mockResolvedValue(null);
      const route = withImpersonationPolicy(async () => {
        const first = await requireAuth();
        const second = await requireAuth();
        expect(second).toEqual(first);
        expect(!!supportRequest.getStore()?.impersonation).toBe(kind === "impersonated");
        return first.error ?? NextResponse.json({ id: first.user.id });
      });
      const response = await route(new NextRequest("http://localhost/api/workspaces"));
      expect(response.status).toBe(kind === "anonymous" ? 401 : 200);
      expect(mocks.session).toHaveBeenCalledTimes(1);
      expect(supportRequest.getStore()).toBeUndefined();
    },
  );
  it("isolates concurrent authenticated requests", async () => {
    mocks.session.mockImplementation(async ({ headers }) => {
      const id = headers.get("x-test-user");
      return { user: { id }, session: { id } };
    });
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const route = withImpersonationPolicy(async () => {
      if (++entered === 2) release();
      await both;
      const result = await requireAuth();
      return NextResponse.json({ id: result.user?.id });
    });
    const responses = await Promise.all(
      ["alice", "bob"].map((id) =>
        route(
          new NextRequest("http://localhost/api/workspaces", { headers: { "x-test-user": id } }),
        ),
      ),
    );
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { id: "alice" },
      { id: "bob" },
    ]);
    expect(mocks.session).toHaveBeenCalledTimes(2);
  });
  it.each(["support", "admin"])("blocks all credential escapes for %s", (role) => {
    for (const [path, method] of [
      ["/api/github/token", "GET"],
      ["/api/auth/device/approve", "POST"],
      ["/api/auth/token", "GET"],
      ["/api/cli/token", "POST"],
      ["/api/projects/p/api-keys", "POST"],
      ["/api/github/callback", "GET"],
      ["/api/workspaces/w/slack", "DELETE"],
      ["/api/workspaces/w/slack/channels", "GET"],
      ["/api/workspaces/w/slack/test-message", "POST"],
      ["/api/workspaces/w/slack/install", "GET"],
      ["/api/workspaces/w/slack/channel", "POST"],
      ["/api/workspaces/w/model-providers/test", "POST"],
      ["/api/workspaces/w/model-providers/p", "PATCH"],
      ["/api/workspaces/w/model-providers/p", "DELETE"],
      ["/api/workspaces/w/model-providers", "POST"],
    ])
      expect(impersonationDenial(path, method, role)).toBeTruthy();
  });
  it("still permits masked provider reads", () => {
    expect(impersonationDenial("/api/workspaces/w/model-providers", "GET", "support")).toBeNull();
  });
  it("does not finalize a streaming write at response headers", async () => {
    mocks.context.mockResolvedValue({ valid: true, actor: { id: "staff", role: "admin" } });
    const response = await withImpersonationPolicy(
      async () =>
        new Response("event: done\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    )(new NextRequest("http://localhost/api/workspaces/w/action", { method: "POST" }));
    expect(mocks.update).not.toHaveBeenCalled();
    await response.text();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: "success" }) }),
    );
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
