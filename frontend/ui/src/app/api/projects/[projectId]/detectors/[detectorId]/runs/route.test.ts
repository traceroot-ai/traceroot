import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const rcaFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    detectorRca: {
      findMany: (...args: unknown[]) => rcaFindManyMock(...args),
    },
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
  rcaFindManyMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  backendFetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
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
    expect(rcaFindManyMock).not.toHaveBeenCalled();
  });

  it("passes a backend error through without attempting enrichment", async () => {
    const body = { detail: "boom" };
    backendFetchMock.mockResolvedValue(backendResponse(body, 500));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(body);
    expect(rcaFindManyMock).not.toHaveBeenCalled();
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

describe("GET .../runs — RCA status enrichment", () => {
  it("attaches each triggered run's stored RCA status; absent row maps to null (skipped)", async () => {
    backendFetchMock.mockResolvedValue(
      backendResponse({ data: [run("f1"), run("f2"), run("f3")], meta: {} }),
    );
    rcaFindManyMock.mockResolvedValue([
      { findingId: "f1", status: "done" },
      { findingId: "f3", status: "failed" },
    ]);

    const res = await GET(makeRequest(), makeParams());
    const body = (await res.json()) as { data: Array<{ rca_status: unknown }> };

    expect(res.status).toBe(200);
    expect(body.data.map((r) => r.rca_status)).toEqual(["done", null, "failed"]);
    // One batched lookup with all triggered ids — never one query per run.
    expect(rcaFindManyMock).toHaveBeenCalledTimes(1);
    expect(rcaFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { findingId: { in: ["f1", "f2", "f3"] } },
    });
  });

  it("leaves runs that never triggered (null finding_id) untouched", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [run("f1"), run(null)], meta: {} }));
    rcaFindManyMock.mockResolvedValue([{ findingId: "f1", status: "done" }]);

    const res = await GET(makeRequest(), makeParams());
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(body.data[0].rca_status).toBe("done");
    // The non-triggered run is never enriched — no rca_status key at all.
    expect("rca_status" in body.data[1]).toBe(false);
    expect(rcaFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { findingId: { in: ["f1"] } },
    });
  });

  it("skips the lookup entirely when no run on the page triggered", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [run(null)], meta: {} }));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(rcaFindManyMock).not.toHaveBeenCalled();
  });

  it("leaves a malformed body untouched (data not an array)", async () => {
    const body = { data: "not-an-array", meta: {} };
    backendFetchMock.mockResolvedValue(backendResponse(body));
    const res = await GET(makeRequest(), makeParams());
    expect(await res.json()).toEqual(body);
    expect(rcaFindManyMock).not.toHaveBeenCalled();
  });

  it("leaves a null body untouched", async () => {
    backendFetchMock.mockResolvedValue(backendResponse(null));
    const res = await GET(makeRequest(), makeParams());
    expect(await res.json()).toBeNull();
    expect(rcaFindManyMock).not.toHaveBeenCalled();
  });

  it("returns triggered runs WITHOUT rca_status when the lookup fails (absent, not Skipped)", async () => {
    backendFetchMock.mockResolvedValue(backendResponse({ data: [run("f1")], meta: {} }));
    rcaFindManyMock.mockRejectedValue(new Error("pg down"));

    const res = await GET(makeRequest(), makeParams());
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    // Field absent — the UI renders "—", never a misleading "Skipped".
    expect("rca_status" in body.data[0]).toBe(false);
  });
});
