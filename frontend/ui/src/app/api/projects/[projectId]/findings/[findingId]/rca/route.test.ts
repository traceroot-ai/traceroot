import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "u1" } }),
  requireProjectAccess: async () => ({ project: { id: "p1", workspaceId: "w1" } }),
  successResponse: (body: unknown) => new Response(JSON.stringify(body), { status: 200 }),
}));
// The factory below runs while resolving the mocked module's imports, which
// (per ESM import hoisting) happens before this file's own top-level `const`
// declarations run. Wrapping the mock in a closure defers reading `findFirst`
// until the wrapped function is actually invoked, avoiding a TDZ ReferenceError
// (see the sibling detectors/runs route.test.ts for the same pattern).
const findFirst = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { detectorRca: { findFirst: (...args: unknown[]) => findFirst(...args) } },
}));

import { GET } from "./route";

describe("GET /findings/:id/rca", () => {
  it("returns the latest execution's trace fields", async () => {
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: "s1",
      status: "done",
      result: "x",
      completedAt: null,
      createTime: new Date(0),
      latestExecution: { traceId: "abc", traceStatus: "available", attempt: 2 },
    });
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ projectId: "p1", findingId: "f1" }),
    });
    const body = await res.json();
    expect(body.rca).toMatchObject({
      status: "done",
      traceId: "abc",
      traceStatus: "available",
      attempt: 2,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: { latestExecution: true } }),
    );
  });
  it("does not fall back to the legacy session when the latest execution has none", async () => {
    // A re-run opens a new session; if that run has no chat yet, the answer is
    // "no session", not the previous attempt's. Falling back would open the
    // wrong run's conversation.
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: "session-from-attempt-1",
      status: "running",
      result: null,
      completedAt: null,
      createTime: new Date(0),
      latestExecution: {
        sessionId: null,
        traceId: "t2",
        traceStatus: "pending",
        attempt: 2,
      },
    });
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ projectId: "p1", findingId: "f1" }),
    });
    expect((await res.json()).rca).toMatchObject({ sessionId: null, attempt: 2 });
  });

  it("is null-safe for legacy rows without an execution", async () => {
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: null,
      status: "failed",
      result: null,
      completedAt: null,
      createTime: new Date(0),
      latestExecution: null,
    });
    const res = await GET(new Request("http://x") as any, {
      params: Promise.resolve({ projectId: "p1", findingId: "f1" }),
    });
    expect((await res.json()).rca).toMatchObject({
      traceId: null,
      traceStatus: null,
      attempt: null,
    });
  });
});
