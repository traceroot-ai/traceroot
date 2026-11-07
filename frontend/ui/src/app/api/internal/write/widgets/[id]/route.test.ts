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

const updateWidgetMock = vi.fn();
const deleteWidgetMock = vi.fn();
vi.mock("@/lib/write-services/dashboards", () => ({
  updateWidget: (...args: unknown[]) => updateWidgetMock(...args),
  deleteWidget: (...args: unknown[]) => deleteWidgetMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { PATCH, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "wid1" }) };
const patchBody = {
  actorUserId: "u1",
  projectId: "p1",
  transport: "public-api",
  title: "Renamed",
  displayConfig: null,
};
const deleteBody = { actorUserId: "u1", projectId: "p1", transport: "agent", reason: "obsolete" };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  updateWidgetMock.mockReset();
  deleteWidgetMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("PATCH /api/internal/write/widgets/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(updateWidgetMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await PATCH(
      {
        json: async () => {
          throw new SyntaxError("bad json");
        },
      } as unknown as Parameters<typeof PATCH>[0],
      params,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("returns 400 when the envelope is incomplete", async () => {
    const { projectId: _dropped, ...rest } = patchBody;
    const res = await PATCH(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required" });
    expect(updateWidgetMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    updateWidgetMock.mockResolvedValue({ ok: false, status: 404, error: "Widget not found" });
    const res = await PATCH(makeRequest(patchBody), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Widget not found" });
  });

  it("passes the id from the path, the patch fields and provenance, and answers updated + changed", async () => {
    const widget = { id: "wid1", title: "Renamed" };
    updateWidgetMock.mockResolvedValue({
      ok: true,
      data: widget,
      changed: ["title", "display_config"],
    });
    const res = await PATCH(makeRequest({ ...patchBody, agentSessionId: "as1" }), params);
    expect(updateWidgetMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      widgetId: "wid1",
      patch: { title: "Renamed", displayConfig: null },
      provenance: { transport: "public-api", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updated: true,
      changed: ["title", "display_config"],
      widget,
    });
  });

  it("forwards only the fields the caller sent, so absent stays untouched", async () => {
    updateWidgetMock.mockResolvedValue({ ok: true, data: {}, changed: [] });
    await PATCH(
      makeRequest({ actorUserId: "u1", projectId: "p1", transport: "ui", spec: { a: 1 } }),
      params,
    );
    expect(updateWidgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { spec: { a: 1 } },
        provenance: { transport: "ui", agentSessionId: null },
      }),
    );
  });
});

describe("DELETE /api/internal/write/widgets/[id]", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(401);
    expect(deleteWidgetMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the reason is missing from the body", async () => {
    const { reason: _dropped, ...rest } = deleteBody;
    const res = await DELETE(makeRequest(rest), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reason is required" });
    expect(deleteWidgetMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    deleteWidgetMock.mockResolvedValue({ ok: false, status: 404, error: "Widget not found" });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Widget not found" });
  });

  it("passes the id, reason and provenance, and answers deleted with the reason and the resource", async () => {
    deleteWidgetMock.mockResolvedValue({
      ok: true,
      data: { id: "wid1", name: "Costs" },
      reason: "obsolete",
    });
    const res = await DELETE(makeRequest(deleteBody), params);
    expect(deleteWidgetMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      widgetId: "wid1",
      reason: "obsolete",
      provenance: { transport: "agent", agentSessionId: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: true,
      reason: "obsolete",
      widget: { id: "wid1", name: "Costs" },
    });
  });
});
