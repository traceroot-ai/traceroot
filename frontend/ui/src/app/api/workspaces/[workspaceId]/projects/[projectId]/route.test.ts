import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      ...((actual.prisma as Record<string, unknown>) ?? {}),
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
    vi.unstubAllEnvs();
    findFirst.mockReset().mockResolvedValue({
      id: "p1",
      name: "Proj",
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    });
    modelProviderFindFirst.mockReset().mockResolvedValue(null);
    update
      .mockReset()
      .mockResolvedValue({ id: "p1", alertConfig: { emailAddresses: [], alertWindow: "1h" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("does not revalidate or rewrite untouched legacy RCA tuples", async () => {
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      rcaModel: "legacy-custom-model",
      rcaProvider: null,
      rcaSource: null,
    });

    const res = await patch({ alert_window: "1h" });

    expect(res.status).toBe(200);
    expect(modelProviderFindFirst).not.toHaveBeenCalled();
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("rcaModel");
    expect(data).not.toHaveProperty("rcaProvider");
    expect(data).not.toHaveProperty("rcaSource");
  });

  it("canonicalizes and validates system RCA model tuples before persisting", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    const res = await patch({
      rca_model: "claude-sonnet-4-6",
      rca_provider: "Anthropic",
      rca_source: "system",
    });

    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].data).toMatchObject({
      rcaModel: "claude-sonnet-4-6",
      rcaProvider: "anthropic",
      rcaSource: "system",
    });
  });

  it("rejects RCA system models when the provider env var is unavailable", async () => {
    const res = await patch({
      rca_model: "claude-sonnet-4-6",
      rca_provider: "anthropic",
      rca_source: "system",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Selected system provider is not available for this workspace",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("validates BYOK RCA tuples against workspace provider config", async () => {
    modelProviderFindFirst.mockResolvedValueOnce({
      adapter: "openai",
      customModels: ["gpt-5.5"],
    });

    const res = await patch({
      rca_model: "gpt-5.5",
      rca_provider: "workspace-openai",
      rca_source: "byok",
    });

    expect(res.status).toBe(200);
    expect(modelProviderFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "w1", provider: "workspace-openai", enabled: true },
      select: { adapter: true, customModels: true },
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      rcaModel: "gpt-5.5",
      rcaProvider: "workspace-openai",
      rcaSource: "byok",
    });
  });

  it("rejects ambiguous RCA model-only legacy tuples on touched updates", async () => {
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      rcaModel: "custom-model",
      rcaProvider: null,
      rcaSource: null,
    });

    const res = await patch({ rca_model: "custom-model" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "source is required for model selection" });
    expect(update).not.toHaveBeenCalled();
  });

  it("clears RCA model settings only when the tuple is explicitly cleared", async () => {
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      rcaModel: "gpt-5.5",
      rcaProvider: "workspace-openai",
      rcaSource: "byok",
    });

    const res = await patch({ rca_model: null, rca_provider: null, rca_source: "system" });

    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].data).toMatchObject({
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
    });
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
});
