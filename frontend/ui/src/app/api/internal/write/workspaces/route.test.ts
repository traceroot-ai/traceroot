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

const createWorkspaceMock = vi.fn();
vi.mock("@/lib/write-services/workspaces", () => ({
  createWorkspace: (...args: unknown[]) => createWorkspaceMock(...args),
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
  createWorkspaceMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/write/workspaces", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ actorUserId: "u1", name: "Acme", transport: "agent" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
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
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("returns 400 when actorUserId is missing", async () => {
    const res = await POST(makeRequest({ name: "Acme", transport: "agent" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("actorUserId is required");
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("returns 400 when transport is omitted", async () => {
    const res = await POST(makeRequest({ actorUserId: "u1", name: "Acme" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    createWorkspaceMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "actor is not allowed to create workspaces",
    });

    const res = await POST(
      makeRequest({ actorUserId: "u1", name: "Acme", transport: "public-api" }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "actor is not allowed to create workspaces" });
  });

  it("returns the created workspace and forwards provenance", async () => {
    createWorkspaceMock.mockResolvedValue({
      ok: true,
      created: true,
      data: { id: "w1", name: "Acme", role: "ADMIN" },
    });

    const res = await POST(
      makeRequest({
        actorUserId: "u1",
        name: "Acme",
        transport: "agent",
        agentSessionId: "as1",
      }),
    );

    expect(createWorkspaceMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: true,
      workspace: { id: "w1", name: "Acme", role: "ADMIN" },
    });
  });

  it("normalizes an omitted agentSessionId to null for the service", async () => {
    createWorkspaceMock.mockResolvedValue({
      ok: true,
      created: false,
      data: { id: "w1", name: "Acme", role: "ADMIN" },
    });

    const res = await POST(
      makeRequest({ actorUserId: "u1", name: "Acme", transport: "public-api" }),
    );

    expect(createWorkspaceMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "public-api", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: false,
      workspace: { id: "w1", name: "Acme", role: "ADMIN" },
    });
  });
});
