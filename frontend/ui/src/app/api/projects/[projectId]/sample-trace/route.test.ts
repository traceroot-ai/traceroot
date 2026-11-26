import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
}));
vi.mock("@traceroot/core", () => ({ Role: { MEMBER: "MEMBER" } }));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

import { POST } from "./route";

const fetchMock = vi.fn();
const call = () =>
  POST({} as Parameters<typeof POST>[0], { params: Promise.resolve({ projectId: "proj_1" }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue({ user: { id: "user_sam" } });
  requireProjectAccessMock.mockReset().mockResolvedValue({ project: { id: "proj_1" } });
  fetchMock.mockReset().mockResolvedValue(Response.json({ trace_id: "abc" }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/projects/[projectId]/sample-trace", () => {
  it("adds the sample for a member, using the internal secret", async () => {
    const response = await call();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ trace_id: "abc" });
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user_sam", "proj_1", "MEMBER");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/internal/projects/proj_1/sample-trace");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "X-Internal-Secret": "test-secret" });
  });

  it("writes nothing for someone below member", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    expect((await call()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, 409],
    [500, 502],
  ])("turns a backend %i into %i", async (backend, expected) => {
    fetchMock.mockResolvedValue(new Response("{}", { status: backend }));

    expect((await call()).status).toBe(expected);
  });

  it("answers 502 when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    expect((await call()).status).toBe(502);
  });
});
