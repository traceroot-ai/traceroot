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

const createProjectMock = vi.fn();
vi.mock("@/lib/write-services/projects", () => ({
  createProject: (...args: unknown[]) => createProjectMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  createProjectMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/write/projects", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(
      makeRequest({
        actorUserId: "u1",
        workspaceId: "w1",
        name: "Checkout",
        transport: "agent",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(createProjectMock).not.toHaveBeenCalled();
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
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("returns 400 when actorUserId is missing", async () => {
    const res = await POST(
      makeRequest({ workspaceId: "w1", name: "Checkout", transport: "agent" }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("actorUserId is required");
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("returns 400 when workspaceId is missing", async () => {
    const res = await POST(
      makeRequest({ actorUserId: "u1", name: "Checkout", transport: "agent" }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("workspaceId is required");
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("returns 400 when name is empty", async () => {
    const res = await POST(
      makeRequest({ actorUserId: "u1", workspaceId: "w1", name: "", transport: "agent" }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("name is required");
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("returns 400 when transport is omitted", async () => {
    const res = await POST(
      makeRequest({ actorUserId: "u1", workspaceId: "w1", name: "Checkout" }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("returns 400 when traceTtlDays is out of range", async () => {
    const res = await POST(
      makeRequest({
        actorUserId: "u1",
        workspaceId: "w1",
        name: "Checkout",
        traceTtlDays: 0,
        transport: "agent",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    createProjectMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });

    const res = await POST(
      makeRequest({
        actorUserId: "u1",
        workspaceId: "w1",
        name: "Checkout",
        transport: "public-api",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Requires MEMBER role or higher" });
  });

  it("returns the created project and forwards provenance", async () => {
    createProjectMock.mockResolvedValue({
      ok: true,
      created: true,
      data: { id: "p1", name: "Checkout", workspaceId: "w1" },
    });

    const res = await POST(
      makeRequest({
        actorUserId: "u1",
        workspaceId: "w1",
        name: "Checkout",
        traceTtlDays: 30,
        transport: "agent",
        agentSessionId: "as1",
      }),
    );

    expect(createProjectMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      traceTtlDays: 30,
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: true,
      project: { id: "p1", name: "Checkout", workspaceId: "w1" },
    });
  });

  it("normalizes an omitted agentSessionId to null for the service", async () => {
    createProjectMock.mockResolvedValue({
      ok: true,
      created: false,
      data: { id: "p1", name: "Checkout", workspaceId: "w1" },
    });

    const res = await POST(
      makeRequest({
        actorUserId: "u1",
        workspaceId: "w1",
        name: "Checkout",
        transport: "public-api",
      }),
    );

    expect(createProjectMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      traceTtlDays: undefined,
      provenance: { transport: "public-api", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: false,
      project: { id: "p1", name: "Checkout", workspaceId: "w1" },
    });
  });
});
