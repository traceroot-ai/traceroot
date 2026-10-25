import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  stop: vi.fn(),
  context: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mocks.session, supportStop: mocks.stop } },
}));
vi.mock("@/lib/support/session", () => ({ impersonationContext: mocks.context }));
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({ GET: mocks.get, POST: mocks.post }),
}));
import { GET, POST } from "./route";
beforeEach(() => vi.resetAllMocks());
it("propagates failed recovery without reporting the dead session as active", async () => {
  mocks.session.mockResolvedValue({ session: { impersonatedBy: "staff" } });
  mocks.context.mockResolvedValue({ valid: false });
  mocks.stop.mockResolvedValue(new Response("Unavailable", { status: 503 }));
  const response = await GET(new NextRequest("http://localhost/api/auth/get-session"));
  expect(response.status).toBe(503);
  expect(mocks.get).not.toHaveBeenCalled();
});
it("routes the legacy exit URL through support recovery", async () => {
  mocks.stop.mockResolvedValue(Response.json({ restored: true }));
  const response = await POST(
    new NextRequest("http://localhost/api/auth/admin/stop-impersonating", { method: "POST" }),
  );
  expect(response.status).toBe(200);
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.post).not.toHaveBeenCalled();
});
it("keeps legacy unaudited starts blocked", async () => {
  expect(
    (
      await POST(
        new NextRequest("http://localhost/api/auth/admin/impersonate-user", { method: "POST" }),
      )
    ).status,
  ).toBe(403);
});
it("recovers an expired session on get-session using only a restore-cookie hint", async () => {
  mocks.session.mockResolvedValue(null);
  mocks.stop.mockResolvedValue(
    new Response(null, { headers: { "set-cookie": "better-auth.session_token=restored; Path=/" } }),
  );
  mocks.get.mockResolvedValue(Response.json({ user: { id: "staff" } }));
  const response = await GET(
    new NextRequest("http://localhost/api/auth/get-session", {
      headers: { cookie: "better-auth.support_original=signed" },
    }),
  );
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.get.mock.calls[0][0].headers.get("cookie")).toContain(
    "better-auth.session_token=restored",
  );
  expect(response.headers.get("set-cookie")).toContain("session_token=restored");
});
