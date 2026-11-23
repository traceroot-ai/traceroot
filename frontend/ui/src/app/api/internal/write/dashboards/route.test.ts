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

const createDashboardMock = vi.fn();
vi.mock("@/lib/write-services/dashboards", () => ({
  createDashboard: (...args: unknown[]) => createDashboardMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

const validBody = {
  actorUserId: "u1",
  projectId: "p1",
  name: "Cost overview",
  transport: "agent",
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  createDashboardMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/write/dashboards", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(createDashboardMock).not.toHaveBeenCalled();
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
    expect(createDashboardMock).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const { name: _dropped, ...rest } = validBody;

    const res = await POST(makeRequest(rest));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("name is required");
    expect(createDashboardMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    createDashboardMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Requires MEMBER role or higher" });
  });

  it("passes a service-level validation message through as 400", async () => {
    createDashboardMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: "description must be at most 500 chars",
    });

    const res = await POST(makeRequest({ ...validBody, description: "x" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "description must be at most 500 chars" });
  });

  it("returns the created dashboard and forwards provenance", async () => {
    const dashboard = { id: "dash1", name: "Cost overview", projectId: "p1" };
    createDashboardMock.mockResolvedValue({ ok: true, created: true, data: dashboard });

    const res = await POST(
      makeRequest({
        ...validBody,
        description: "Spend at a glance",
        agentSessionId: "as1",
      }),
    );

    expect(createDashboardMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      name: "Cost overview",
      description: "Spend at a glance",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, dashboard });
  });

  it("passes the service's renamedFrom through so the agent can say what it renamed", async () => {
    const dashboard = { id: "dash2", name: "Cost overview (2)", projectId: "p1" };
    createDashboardMock.mockResolvedValue({
      ok: true,
      created: true,
      data: dashboard,
      renamedFrom: "Cost overview",
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, dashboard, renamedFrom: "Cost overview" });
  });

  it("leaves renamedFrom off the response when the requested name was used", async () => {
    const dashboard = { id: "dash1", name: "Cost overview", projectId: "p1" };
    createDashboardMock.mockResolvedValue({ ok: true, created: true, data: dashboard });

    const res = await POST(makeRequest(validBody));

    expect(await res.json()).toStrictEqual({ created: true, dashboard });
  });

  it("normalizes an omitted agentSessionId to null for the service", async () => {
    const dashboard = { id: "dash1", name: "Cost overview", projectId: "p1" };
    createDashboardMock.mockResolvedValue({ ok: true, created: false, data: dashboard });

    const res = await POST(makeRequest({ ...validBody, transport: "public-api" }));

    expect(createDashboardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { transport: "public-api", agentSessionId: null },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: false, dashboard });
  });
});
