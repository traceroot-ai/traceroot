import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirst, update, modelProviderFindFirst } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  modelProviderFindFirst: vi.fn(),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      project: { findFirst, update },
      modelProvider: { findFirst: modelProviderFindFirst },
    },
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
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    findFirst.mockReset().mockResolvedValue({ id: "p1", name: "Proj" });
    modelProviderFindFirst.mockReset().mockResolvedValue({
      provider: "anthropic",
      adapter: "anthropic",
      customModels: ["claude-haiku-4-5"],
    });
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

  it("GET returns the project's configured alert_window", async () => {
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

  it("rejects partial RCA model tuple updates", async () => {
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    });
    const res = await patch({ rca_model: "claude-haiku-4-5" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "RCA model, provider, and source must be provided together",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("normalizes valid system RCA selections before persisting", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    });
    const res = await patch({
      rca_model: "claude-haiku-4-5",
      rca_provider: "anthropic",
      rca_source: "system",
    });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rcaModel: "claude-haiku-4-5",
          rcaProvider: "Anthropic",
          rcaSource: "system",
        }),
      }),
    );
  });

  it("rejects unavailable BYOK RCA selections", async () => {
    modelProviderFindFirst.mockResolvedValueOnce(null);
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    });
    const res = await patch({
      rca_model: "claude-haiku-4-5",
      rca_provider: "missing",
      rca_source: "byok",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected BYOK provider is not available for this workspace",
    });
    expect(update).not.toHaveBeenCalled();
  });
});
