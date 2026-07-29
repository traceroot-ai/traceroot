import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));

import { GET } from "./route";

const backendFetchMock = vi.fn();
vi.stubGlobal("fetch", backendFetchMock);

const EMPTY = { state: null, detector_ids: [] };

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", traceId: "trace-1" }) };
}

function backendResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  backendFetchMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({ project: { workspaceId: "ws-1" } });
});

describe("GET .../traces/[traceId]/detection-state", () => {
  it("returns the auth error when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await GET({} as Parameters<typeof GET>[0], makeParams());
    expect(res.status).toBe(401);
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("returns the access error when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = await GET({} as Parameters<typeof GET>[0], makeParams());
    expect(res.status).toBe(403);
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("passes the backend state through, with the internal secret", async () => {
    const state = { state: "pending", detector_ids: ["d1", "d2"] };
    backendFetchMock.mockResolvedValue(backendResponse(state));

    const res = await GET({} as Parameters<typeof GET>[0], makeParams());
    expect(await res.json()).toEqual(state);

    const [url, init] = backendFetchMock.mock.calls[0];
    expect(url).toContain("/traces/trace-1/detection-state");
    expect(url).toContain("project_id=proj-1");
    expect(init.headers["X-Internal-Secret"]).toBe("test-secret");
  });

  it("reports an empty state when the backend errors", async () => {
    // Fail soft: the trace page treats this as "no signal" and falls back to its
    // own wait, rather than surfacing an error for what is only a hint.
    backendFetchMock.mockResolvedValue(backendResponse({ detail: "boom" }, 500));
    const res = await GET({} as Parameters<typeof GET>[0], makeParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });

  it("reports an empty state when the backend is unreachable", async () => {
    backendFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET({} as Parameters<typeof GET>[0], makeParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });
});
