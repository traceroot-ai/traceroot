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

const createWidgetMock = vi.fn();
vi.mock("@/lib/write-services/dashboards", () => ({
  createWidget: (...args: unknown[]) => createWidgetMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

const validBody = {
  actorUserId: "u1",
  projectId: "p1",
  dashboardId: "dash1",
  title: "Cost by model",
  type: "query",
  spec: { metric: "cost" },
  transport: "agent",
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  createWidgetMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/write/widgets", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(createWidgetMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(badRequest);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid JSON" });
    expect(createWidgetMock).not.toHaveBeenCalled();
  });

  it("returns 400 when dashboardId is missing", async () => {
    const { dashboardId: _dropped, ...rest } = validBody;

    const res = await POST(makeRequest(rest));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("dashboardId is required");
    expect(createWidgetMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    createWidgetMock.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Dashboard not found",
    });

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Dashboard not found" });
  });

  it("passes a service-level validation message through as 400", async () => {
    createWidgetMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: "spec must be a JSON object",
    });

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "spec must be a JSON object" });
  });

  it("returns the created widget and forwards provenance", async () => {
    const widget = { id: "wid1", dashboardId: "dash1", title: "Cost by model", type: "query" };
    createWidgetMock.mockResolvedValue({ ok: true, created: true, data: widget });

    const res = await POST(
      makeRequest({
        ...validBody,
        displayConfig: { compact: true },
        agentSessionId: "as1",
      }),
    );

    expect(createWidgetMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      dashboardId: "dash1",
      title: "Cost by model",
      type: "query",
      spec: { metric: "cost" },
      displayConfig: { compact: true },
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, widget });
  });

  it("normalizes an omitted agentSessionId to null for the service", async () => {
    const widget = { id: "wid1", dashboardId: "dash1", title: "Cost by model", type: "query" };
    createWidgetMock.mockResolvedValue({ ok: true, created: true, data: widget });

    const res = await POST(makeRequest({ ...validBody, transport: "public-api" }));

    expect(createWidgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { transport: "public-api", agentSessionId: null },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, widget });
  });
});
