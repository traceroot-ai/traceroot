import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const signalsForRunsMock = vi.fn();
vi.mock("@traceroot/core/signals", () => ({
  signalsForRuns: (...args: unknown[]) => signalsForRunsMock(...args),
}));

const workspaceFindUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args),
    },
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

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
}));

import { GET } from "./route";

const backendFetchMock = vi.fn();
vi.stubGlobal("fetch", backendFetchMock);

function makeRequest(query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  return { nextUrl: { searchParams: params } } as unknown as Parameters<typeof GET>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId: "det-1" }) };
}

/** Backend response double: status + JSON body. */
function backendResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A triggered run (carries a finding_id, so it is eligible for enrichment). */
function run(findingId: string | null, extra: Record<string, unknown> = {}) {
  return {
    run_id: `run-${findingId ?? "x"}`,
    trace_id: `trace-${findingId ?? "x"}`,
    finding_id: findingId,
    ...extra,
  };
}

beforeEach(() => {
  signalsForRunsMock.mockReset();
  workspaceFindUniqueMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  backendFetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-1" } });
  workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "free" });
});

describe("GET .../detectors/[detectorId]/runs — auth & proxy", () => {
  it("returns the auth error when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("returns the access error when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the backend is unreachable", async () => {
    backendFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(502);
    expect(signalsForRunsMock).not.toHaveBeenCalled();
  });

  it("passes a backend error through without attempting enrichment", async () => {
    const body = { detail: "boom" };
    backendFetchMock.mockResolvedValue(backendResponse(body, 500));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(body);
    expect(signalsForRunsMock).not.toHaveBeenCalled();
  });

  it("clamps limit to [1,200] and page to >=0, defaulting NaN", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    await GET(makeRequest({ limit: "999", page: "-5" }), makeParams());
    let url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("limit")).toBe("200");
    expect(url.searchParams.get("page")).toBe("0");

    backendFetchMock.mockClear();
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    await GET(makeRequest({ limit: "abc", page: "abc" }), makeParams());
    url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("page")).toBe("0");
  });

  it("forwards identified=true to the backend, and omits it otherwise", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    await GET(makeRequest({ identified: "true" }), makeParams());
    let url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("identified")).toBe("true");

    backendFetchMock.mockClear();
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    await GET(makeRequest(), makeParams());
    url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.has("identified")).toBe(false);
  });
});

describe("GET .../runs — retention clamp", () => {
  it("clamps start_after to retention cutoff when outside the free plan window", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
    const url = new URL(backendFetchMock.mock.calls[0][0] as string);
    const proxiedStart = url.searchParams.get("start_after")!;
    const cutoffMs = Date.now() - 15 * 86_400_000 - 3_600_000;
    expect(Math.abs(new Date(proxiedStart).getTime() - cutoffMs)).toBeLessThan(5000);
  });

  it("passes through when start_after is within the retention window", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    const res = await GET(makeRequest({ start_after: recent }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
    const url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("start_after")).toBe(recent);
  });

  it("clamps to retention cutoff when no start_after is provided", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(workspaceFindUniqueMock).toHaveBeenCalled();
    const url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.has("start_after")).toBe(true);
  });

  it("clamps malformed start_after to retention cutoff", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    const res = await GET(makeRequest({ start_after: "not-a-date" }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
    const url = new URL(backendFetchMock.mock.calls[0][0] as string);
    const proxiedStart = url.searchParams.get("start_after")!;
    const cutoffMs = Date.now() - 15 * 86_400_000 - 3_600_000;
    expect(Math.abs(new Date(proxiedStart).getTime() - cutoffMs)).toBeLessThan(5000);
  });

  it("allows wider window for enterprise plans", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ billingPlan: "enterprise" });
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    backendFetchMock.mockResolvedValue(backendResponse({ data: [], meta: {} }));
    const res = await GET(makeRequest({ start_after: old }), makeParams());
    expect(res.status).toBe(200);
    expect(backendFetchMock).toHaveBeenCalled();
    const url = new URL(backendFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("start_after")).toBe(old);
  });
});

describe("GET .../runs — signal enrichment", () => {
  it("attaches each triggered run's signal and its RCA's agent trace in one lookup", async () => {
    backendFetchMock.mockResolvedValue(
      backendResponse({ data: [run("f1"), run("f2"), run("f3")], meta: {} }),
    );
    signalsForRunsMock.mockResolvedValue([
      { runId: "run-f1", signalId: "s1", agentTraceId: "t1" },
      { runId: "run-f3", signalId: "s2", agentTraceId: null },
    ]);

    const res = await GET(makeRequest(), makeParams());
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    // A triggered run that is not (yet) a signal hit gets explicit nulls.
    expect(body.data.map((r) => [r.signal_id, r.agent_trace_id])).toEqual([
      ["s1", "t1"],
      [null, null],
      ["s2", null],
    ]);
    expect(signalsForRunsMock).toHaveBeenCalledTimes(1);
    expect(signalsForRunsMock.mock.calls[0][1]).toEqual({
      projectId: "proj-1",
      runIds: ["run-f1", "run-f2", "run-f3"],
    });
  });

  it("leaves runs that never triggered (null finding_id) untouched", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [run("f1"), run(null)], meta: {} }));
    signalsForRunsMock.mockResolvedValue([{ runId: "run-f1", signalId: "s1", agentTraceId: null }]);

    const res = await GET(makeRequest(), makeParams());
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(body.data[0].signal_id).toBe("s1");
    expect("signal_id" in body.data[1]).toBe(false);
    expect(signalsForRunsMock.mock.calls[0][1]).toMatchObject({ runIds: ["run-f1"] });
  });

  it("skips the lookup entirely when no run on the page triggered", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [run(null)], meta: {} }));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(signalsForRunsMock).not.toHaveBeenCalled();
  });

  it("leaves a malformed body untouched (data not an array)", async () => {
    const body = { data: "not-an-array", meta: {} };
    backendFetchMock.mockResolvedValue(backendResponse(body));
    const res = await GET(makeRequest(), makeParams());
    expect(await res.json()).toEqual(body);
    expect(signalsForRunsMock).not.toHaveBeenCalled();
  });

  it("leaves a null body untouched", async () => {
    backendFetchMock.mockResolvedValue(backendResponse(null));
    const res = await GET(makeRequest(), makeParams());
    expect(await res.json()).toBeNull();
    expect(signalsForRunsMock).not.toHaveBeenCalled();
  });

  it("returns the runs without signal fields when the lookup fails", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [run("f1")], meta: {} }));
    signalsForRunsMock.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(makeRequest(), makeParams());
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect("signal_id" in body.data[0]).toBe(false);
    spy.mockRestore();
  });
});
