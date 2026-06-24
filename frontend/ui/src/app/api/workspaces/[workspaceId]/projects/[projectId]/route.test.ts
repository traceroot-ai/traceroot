import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirst, update } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: { project: { findFirst, update } },
  };
});

// Auth/access helpers. The real module pulls in env-validated auth config, so
// stub the whole module: open the gates and reimplement the pure response
// helpers with NextResponse (their only behavior the handler relies on).
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () => ({ user: { id: "u1", email: null, name: null } }),
    requireWorkspaceMembership: async () => ({
      membership: { workspaceId: "w1", userId: "u1", role: "ADMIN" },
    }),
    errorResponse: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    successResponse: <T>(data: T, status = 200) => NextResponse.json(data, { status }),
  };
});

import { GET, PATCH } from "./route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://t/api", { method: "PATCH", body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ workspaceId: "w1", projectId: "p1" }) } as never,
  );
}

function get() {
  return GET(
    new Request("http://t/api") as never,
    {
      params: Promise.resolve({ workspaceId: "w1", projectId: "p1" }),
    } as never,
  );
}

describe("project PATCH alert_window", () => {
  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue({ id: "p1", name: "Proj" });
    update
      .mockReset()
      .mockResolvedValue({ id: "p1", alertConfig: { emailAddresses: [], alertWindow: "1h" } });
  });

  it("rejects an unknown window token with 400", async () => {
    const res = await patch({ alert_window: "24h" });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("persists a valid window via the alertConfig upsert", async () => {
    const res = await patch({ alert_window: "1h" });
    expect(res.status).toBe(200);
    const arg = update.mock.calls[0][0];
    expect(arg.data.alertConfig.upsert.create.alertWindow).toBe("1h");
    expect(arg.data.alertConfig.upsert.update.alertWindow).toBe("1h");
  });

  it("returns the persisted alert_window in the response", async () => {
    const res = await patch({ alert_window: "1h" });
    const json = await res.json();
    expect(json.alert_window).toBe("1h");
  });

  it("GET returns the project's alert_window (defaulting to off)", async () => {
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      traceTtlDays: null,
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
      alertConfig: { emailAddresses: [], alertWindow: "30m" },
      accessKeys: [],
      createTime: new Date(),
      updateTime: new Date(),
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).alert_window).toBe("30m");
  });
});
