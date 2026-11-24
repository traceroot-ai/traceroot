import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Policy behavior is covered by the shared guard tests and impersonation E2E.
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "secret" } }));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "u1" } }),
  requireProjectAccess: async () => ({ project: { id: "p1", workspaceId: "w1" } }),
  successResponse: (body: unknown) => new Response(JSON.stringify(body), { status: 200 }),
  errorResponse: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
}));
// The factory below runs while resolving the mocked module's imports, which
// (per ESM import hoisting) happens before this file's own top-level `const`
// declarations run. Wrapping the mock in a closure defers reading `findFirst`
// until the wrapped function is actually invoked, avoiding a TDZ ReferenceError
// (see the sibling detectors/runs route.test.ts for the same pattern).
const findFirst = vi.fn();
const workspaceFindUnique = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    detectorRca: { findFirst: (...args: unknown[]) => findFirst(...args) },
    workspace: { findUnique: (...args: unknown[]) => workspaceFindUnique(...args) },
  },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  getRetentionDays: (plan: string) => {
    const days: Record<string, number | null> = {
      free: 15,
      starter: 30,
      pro: 90,
      enterprise: null,
    };
    return Object.prototype.hasOwnProperty.call(days, plan) ? days[plan] : 15;
  },
}));

import { GET } from "./route";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const NOW = new Date("2026-06-01T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const backendResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const sampleRow = (overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  findingId: "f1",
  sessionId: "s1",
  status: "done",
  result: "root cause text",
  completedAt: null,
  createTime: new Date(0),
  executions: [{ sessionId: "s2", traceId: "abc", traceStatus: "available", attempt: 2 }],
  ...overrides,
});

const call = (findingId = "f1") =>
  GET(new Request("http://x") as unknown as Parameters<typeof GET>[0], {
    params: Promise.resolve({ projectId: "p1", findingId }),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  findFirst.mockReset();
  workspaceFindUnique.mockReset();
  fetchMock.mockReset();
  workspaceFindUnique.mockResolvedValue({ billingPlan: "free" });
  fetchMock.mockResolvedValue(
    backendResponse({
      trace_id: "trace-1",
      trace_start_time: daysAgo(1),
      timestamp: daysAgo(1),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
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

describe("GET /findings/:id/rca — retention gate", () => {
  it("returns 403 without rca when trace started 400 days ago on free plan", async () => {
    findFirst.mockResolvedValue(sampleRow());
    fetchMock.mockResolvedValue(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: daysAgo(400),
        timestamp: daysAgo(400),
      }),
    );

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Data outside retention window" });
    expect("rca" in body).toBe(false);
  });

  it("judges retention by trace_start_time rather than the finding timestamp", async () => {
    findFirst.mockResolvedValue(sampleRow());
    fetchMock.mockResolvedValue(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: daysAgo(400),
        timestamp: daysAgo(1),
      }),
    );

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Data outside retention window" });
    expect("rca" in body).toBe(false);
  });

  it("falls back to timestamp when trace_start_time is null", async () => {
    findFirst.mockResolvedValue(sampleRow());
    fetchMock.mockResolvedValueOnce(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: null,
        timestamp: daysAgo(400),
      }),
    );

    const oldRes = await call();
    expect(oldRes.status).toBe(403);
    expect(await oldRes.json()).toEqual({ error: "Data outside retention window" });

    fetchMock.mockResolvedValueOnce(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: null,
        timestamp: daysAgo(1),
      }),
    );

    const recentRes = await call();
    const recentBody = await recentRes.json();
    expect(recentRes.status).toBe(200);
    expect(recentBody.rca).toMatchObject({
      id: "r1",
      findingId: "f1",
      result: "root cause text",
    });
  });

  it("returns 200 with RCA fields when inside the retention window", async () => {
    findFirst.mockResolvedValue(sampleRow());
    fetchMock.mockResolvedValue(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: daysAgo(1),
        timestamp: daysAgo(1),
      }),
    );

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rca).toMatchObject({
      id: "r1",
      findingId: "f1",
      sessionId: "s2",
      status: "done",
      result: "root cause text",
      traceId: "abc",
      traceStatus: "available",
      attempt: 2,
    });
  });

  it("returns 200 without calling fetch on enterprise (unlimited retention)", async () => {
    findFirst.mockResolvedValue(sampleRow());
    workspaceFindUnique.mockResolvedValue({ billingPlan: "enterprise" });

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rca).toMatchObject({ id: "r1", result: "root cause text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns { rca: null } without calling fetch when no RCA row exists", async () => {
    findFirst.mockResolvedValue(null);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rca: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 { rca: null } when the backend responds 404", async () => {
    findFirst.mockResolvedValue(sampleRow());
    fetchMock.mockResolvedValue(backendResponse({ detail: "Finding not found" }, 404));

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rca: null });
  });

  it("fails closed with 502 and no rca on backend 500, fetch rejection, or unparseable date", async () => {
    findFirst.mockResolvedValue(sampleRow());

    fetchMock.mockResolvedValueOnce(backendResponse({ detail: "boom" }, 500));
    const res500 = await call();
    const body500 = await res500.json();
    expect(res500.status).toBe(502);
    expect("rca" in body500).toBe(false);

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const resErr = await call();
    const bodyErr = await resErr.json();
    expect(resErr.status).toBe(502);
    expect("rca" in bodyErr).toBe(false);

    fetchMock.mockResolvedValueOnce(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: "not-a-date",
        timestamp: daysAgo(1),
      }),
    );
    const resBadDate = await call();
    const bodyBadDate = await resBadDate.json();
    expect(resBadDate.status).toBe(502);
    expect("rca" in bodyBadDate).toBe(false);
  });

  it("calls the backend with the percent-encoded stored findingId, project_id, and secret header", async () => {
    findFirst.mockResolvedValue(sampleRow({ findingId: "f1-stored/part 2" }));

    const res = await call("f1dashless");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/api/v1/internal/findings/f1-stored%2Fpart%202/trace-start");
    expect(url.searchParams.get("project_id")).toBe("p1");
    expect(init.headers).toEqual({ "X-Internal-Secret": "secret" });
  });

  it("looks up the plan on the project's workspace", async () => {
    findFirst.mockResolvedValue(sampleRow());

    await call();

    expect(workspaceFindUnique).toHaveBeenCalledWith({
      where: { id: "w1" },
      select: { billingPlan: true },
    });
  });

  it("holds a workspace with no plan to the free window", async () => {
    findFirst.mockResolvedValue(sampleRow());
    workspaceFindUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: daysAgo(20),
        timestamp: daysAgo(20),
      }),
    );

    const res = await call();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Data outside retention window" });
  });

  it("enforces per-plan retention windows (starter 30d allows 20d, pro 90d blocks 100d)", async () => {
    findFirst.mockResolvedValue(sampleRow());

    workspaceFindUnique.mockResolvedValueOnce({ billingPlan: "starter" });
    fetchMock.mockResolvedValueOnce(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: daysAgo(20),
        timestamp: daysAgo(20),
      }),
    );
    const starterRes = await call();
    expect(starterRes.status).toBe(200);
    expect((await starterRes.json()).rca).toMatchObject({ id: "r1" });

    workspaceFindUnique.mockResolvedValueOnce({ billingPlan: "pro" });
    fetchMock.mockResolvedValueOnce(
      backendResponse({
        trace_id: "trace-1",
        trace_start_time: daysAgo(100),
        timestamp: daysAgo(100),
      }),
    );
    const proRes = await call();
    expect(proRes.status).toBe(403);
    expect(await proRes.json()).toEqual({ error: "Data outside retention window" });
  });
});
