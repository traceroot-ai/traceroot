import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "customer" } }),
  requireProjectAccess: async () => ({}),
}));
import { GET } from "./route";
afterEach(() => vi.unstubAllGlobals());
it("forwards the signed browser cookie instead of an untrusted user header", async () => {
  const fetch = vi.fn(async () => new Response("data: {}\n\n"));
  vi.stubGlobal("fetch", fetch);
  const request = new NextRequest("http://localhost/api/projects/p/traces/t/live", {
    headers: { cookie: "better-auth.session_token=signed" },
  });
  const response = await GET(request, {
    params: Promise.resolve({ projectId: "p", traceId: "t" }),
  });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/projects/p/traces/t/live"), {
    headers: { cookie: "better-auth.session_token=signed" },
    signal: request.signal,
  });
  expect(await response.text()).toBe("data: {}\n\n");
});
