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

const widgetFindFirstMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    widget: {
      findFirst: (...args: unknown[]) => widgetFindFirstMock(...args),
    },
  },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const CREATE_TIME = new Date("2026-08-01T00:00:00Z");
const UPDATE_TIME = new Date("2026-08-02T00:00:00Z");

beforeEach(() => {
  widgetFindFirstMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/project-widget", () => {
  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ projectId: "proj-1", widgetId: "w-1" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(widgetFindFirstMock).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON with a 400", async () => {
    const request = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("rejects a missing widgetId with a 400", async () => {
    const res = await POST(makeRequest({ projectId: "proj-1" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "widgetId is required" });
  });

  it("rejects a missing projectId with a 400", async () => {
    const res = await POST(makeRequest({ widgetId: "w-1" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required" });
  });

  it("returns the widget as stored with its dashboard's id and name", async () => {
    widgetFindFirstMock.mockResolvedValue({
      id: "w-1",
      title: "Cost over time",
      type: "query",
      spec: { view: "spans" },
      displayConfig: { color: "blue" },
      createTime: CREATE_TIME,
      updateTime: UPDATE_TIME,
      dashboard: { id: "dash-1", name: "Default" },
    });

    const res = await POST(makeRequest({ projectId: "proj-1", widgetId: "w-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      widget: {
        id: "w-1",
        title: "Cost over time",
        type: "query",
        spec: { view: "spans" },
        displayConfig: { color: "blue" },
        createTime: CREATE_TIME,
        updateTime: UPDATE_TIME,
        dashboard: { id: "dash-1", name: "Default" },
      },
    });
    // The lookup is scoped through the dashboard's project — a widget on
    // another project's dashboard simply isn't found.
    expect(widgetFindFirstMock.mock.calls[0][0]).toMatchObject({
      where: { id: "w-1", dashboard: { projectId: "proj-1" } },
      select: { dashboard: { select: { id: true, name: true } } },
    });
  });

  it("answers 404 for a widget outside the project", async () => {
    widgetFindFirstMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ projectId: "proj-1", widgetId: "foreign-widget" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Widget not found" });
  });
});
