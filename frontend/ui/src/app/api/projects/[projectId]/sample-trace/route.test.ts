import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@traceroot/core", () => ({ Role: { MEMBER: "MEMBER" } }));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { POST } from "./route";

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ trace_id: "trace-1", span_count: 4 }),
  }) as typeof fetch;
});

describe("POST .../sample-trace", () => {
  it("requires member project access before creating the sample trace", async () => {
    await POST({} as Request, makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
  });

  it("calls the internal sample-trace endpoint with the internal secret", async () => {
    const res = await POST({} as Request, makeParams());

    expect(res.status).toBe(201);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8000/api/v1/internal/projects/proj-1/sample-trace",
      {
        method: "POST",
        headers: { "X-Internal-Secret": "test-secret" },
      },
    );
    await expect(res.json()).resolves.toEqual({ trace_id: "trace-1", span_count: 4 });
  });
});
