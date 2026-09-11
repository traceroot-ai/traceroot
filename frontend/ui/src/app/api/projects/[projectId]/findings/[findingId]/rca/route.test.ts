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

const call = () =>
  GET(new Request("http://x") as any, {
    params: Promise.resolve({ projectId: "p1", findingId: "f1" }),
  });

describe("GET /findings/:id/rca", () => {
  it("returns the current (highest-attempt) execution's trace fields", async () => {
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: "s1",
      status: "done",
      result: "x",
      completedAt: null,
      createTime: new Date(0),
      executions: [{ sessionId: "s2", traceId: "abc", traceStatus: "available", attempt: 2 }],
    });
    const body = await (await call()).json();
    expect(body.rca).toMatchObject({
      status: "done",
      sessionId: "s2",
      traceId: "abc",
      traceStatus: "available",
      attempt: 2,
    });
    // Newest first, and only the four fields the response uses.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          executions: {
            orderBy: { attempt: "desc" },
            select: { sessionId: true, traceId: true, traceStatus: true, attempt: true },
          },
        },
      }),
    );
  });

  it("keeps the previous attempt's available trace while a retry is pending", async () => {
    // Status, attempt and session follow the current (highest) attempt; the
    // trace link follows the newest attempt whose trace is actually available,
    // so a retry does not blank out a link that still works.
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: "s1",
      status: "running",
      result: "answer from attempt 1",
      completedAt: null,
      createTime: new Date(0),
      executions: [
        { sessionId: null, traceId: "t2", traceStatus: "pending", attempt: 2 },
        { sessionId: "s1", traceId: "t1", traceStatus: "available", attempt: 1 },
      ],
    });
    expect((await (await call()).json()).rca).toMatchObject({
      status: "running",
      attempt: 2,
      sessionId: null,
      traceId: "t1",
      traceStatus: "available",
    });
  });

  it("reports the current attempt's pending trace when no attempt has an available one", async () => {
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: null,
      status: "running",
      result: null,
      completedAt: null,
      createTime: new Date(0),
      executions: [
        { sessionId: null, traceId: "t2", traceStatus: "pending", attempt: 2 },
        { sessionId: "s1", traceId: "t1", traceStatus: "failed", attempt: 1 },
      ],
    });
    expect((await (await call()).json()).rca).toMatchObject({
      attempt: 2,
      traceId: "t2",
      traceStatus: "pending",
    });
  });

  it("does not fall back to the legacy session when the current execution has none", async () => {
    // A re-run is the highest attempt while it runs; if it has no chat yet the
    // answer is "no session", not the previous attempt's — that would open the
    // wrong run's conversation.
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: "session-from-attempt-1",
      status: "running",
      result: null,
      completedAt: null,
      createTime: new Date(0),
      executions: [{ sessionId: null, traceId: "t2", traceStatus: "pending", attempt: 2 }],
    });
    expect((await (await call()).json()).rca).toMatchObject({ sessionId: null, attempt: 2 });
  });

  it("is null-safe for legacy rows without an execution", async () => {
    findFirst.mockResolvedValue({
      id: "r1",
      findingId: "f1",
      sessionId: "legacy-session",
      status: "failed",
      result: null,
      completedAt: null,
      createTime: new Date(0),
      executions: [],
    });
    expect((await (await call()).json()).rca).toMatchObject({
      sessionId: "legacy-session",
      traceId: null,
      traceStatus: null,
      attempt: null,
    });
  });
});
