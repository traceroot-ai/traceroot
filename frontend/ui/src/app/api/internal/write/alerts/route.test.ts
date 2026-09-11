import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const createAlertMock = vi.fn();
vi.mock("@/lib/write-services/alerts", () => ({
  createAlert: (...args: unknown[]) => createAlertMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

const validBody = {
  actorUserId: "u1",
  projectId: "p1",
  name: "P99 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p99",
  filters: [],
  window: "10m",
  thresholdOperator: ">",
  threshold: 900,
  renotify: { mode: "OFF" },
  transport: "agent",
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  createAlertMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/write/alerts", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(createAlertMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(badRequest);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(createAlertMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the envelope is incomplete", async () => {
    const { projectId: _dropped, ...rest } = validBody;

    const res = await POST(makeRequest(rest));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required" });
    expect(createAlertMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error, including the cap conflict", async () => {
    createAlertMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "This project has reached its limit of 100 alerts",
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This project has reached its limit of 100 alerts",
    });
  });

  it("passes the whole body as the rule and forwards provenance", async () => {
    const alert = { id: "alert-1", name: "P99 latency" };
    createAlertMock.mockResolvedValue({ ok: true, created: true, data: alert });

    const body = { ...validBody, agentSessionId: "as1" };
    const res = await POST(makeRequest(body));

    expect(createAlertMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      rule: body,
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, alert });
  });

  it("normalizes an omitted agentSessionId to null for the service", async () => {
    createAlertMock.mockResolvedValue({ ok: true, created: true, data: { id: "alert-1" } });

    await POST(makeRequest({ ...validBody, transport: "public-api" }));

    expect(createAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { transport: "public-api", agentSessionId: null },
      }),
    );
  });
});
