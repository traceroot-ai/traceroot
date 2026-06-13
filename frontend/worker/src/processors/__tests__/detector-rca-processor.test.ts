import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchProviderConfigMock = vi.fn();
const resolvePiModelMock = vi.fn();
const modelProviderFindMany = vi.fn().mockResolvedValue([]);

vi.mock("@traceroot/core/model-resolver", async () => ({
  fetchProviderConfig: (...args: any[]) => fetchProviderConfigMock(...args),
  resolvePiModel: (...args: any[]) => resolvePiModelMock(...args),
}));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      modelProvider: {
        ...actual.prisma.modelProvider,
        findMany: (...a: any[]) => modelProviderFindMany(...a),
      },
    },
  };
});

afterEach(() => {
  fetchProviderConfigMock.mockReset();
  resolvePiModelMock.mockReset();
  modelProviderFindMany.mockReset();
  modelProviderFindMany.mockResolvedValue([]);
});

describe("resolveProjectModel", () => {
  it("resolves a BYOK model via fetchProviderConfig and resolvePiModel", async () => {
    fetchProviderConfigMock.mockResolvedValue({
      adapter: "openai",
      key: "sk-xxx",
      baseUrl: null,
      config: null,
    });
    resolvePiModelMock.mockReturnValue({ id: "gpt-5.3", provider: "openai" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("gpt-5.3", "my-openai", "byok", "ws-123");

    expect(fetchProviderConfigMock).toHaveBeenCalledWith("ws-123", "my-openai");
    expect(resolvePiModelMock).toHaveBeenCalledWith("gpt-5.3", expect.any(Object));
    expect(res).toEqual({ model: "gpt-5.3", providerName: "openai", source: "byok" });
  });

  it("returns null when BYOK provider is not found or disabled", async () => {
    fetchProviderConfigMock.mockResolvedValue(null);

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("gpt-5.3", "missing-provider", "byok", "ws-123");

    expect(res).toBeNull();
    expect(resolvePiModelMock).not.toHaveBeenCalled();
  });

  it("resolves a system model via resolvePiModel", async () => {
    resolvePiModelMock.mockReturnValue({ id: "claude-sonnet-4-5", provider: "anthropic" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("claude-sonnet-4-5", null, null, "ws-123");

    expect(resolvePiModelMock).toHaveBeenCalledWith("claude-sonnet-4-5", null);
    expect(res).toEqual({
      model: "claude-sonnet-4-5",
      providerName: "anthropic",
      source: "system",
    });
  });

  it("resolves legacy BYOK via model provider lookup when rcaSource is null", async () => {
    modelProviderFindMany.mockResolvedValue([
      { provider: "my-deepseek", customModels: ["deepseek-chat"] },
    ]);
    fetchProviderConfigMock.mockResolvedValue({
      adapter: "deepseek",
      key: "sk-xxx",
      baseUrl: null,
      config: null,
    });
    resolvePiModelMock.mockReturnValue({ id: "deepseek-chat", provider: "openai" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("deepseek-chat", null, null, "ws-123");

    expect(modelProviderFindMany).toHaveBeenCalled();
    expect(fetchProviderConfigMock).toHaveBeenCalledWith("ws-123", "my-deepseek");
    expect(res).toEqual({ model: "deepseek-chat", providerName: "openai", source: "byok" });
  });

  it("returns null for unknown models not in system catalog", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("unknown-model", null, null, "ws-123");

    expect(res).toBeNull();
    expect(fetchProviderConfigMock).not.toHaveBeenCalled();
  });

  it("returns null for empty or undefined models", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    expect(await resolveProjectModel(null, null, null, "ws-123")).toBeNull();
    expect(await resolveProjectModel(undefined, null, null, "ws-123")).toBeNull();
  });

  it("handles errors in legacy BYOK provider lookup gracefully", async () => {
    modelProviderFindMany.mockRejectedValue(new Error("DB down"));

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("unknown-custom-model", null, null, "ws-123");

    expect(res).toBeNull();
    expect(modelProviderFindMany).toHaveBeenCalled();
  });
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("runRcaSession", () => {
  it("calls resolveProjectModel and builds message body", async () => {
    fetchProviderConfigMock.mockResolvedValue({
      adapter: "openai",
      key: "sk-xxx",
      baseUrl: null,
      config: null,
    });
    resolvePiModelMock.mockReturnValue({ id: "gpt-5.3", provider: "openai" });

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }),
        },
      });

    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    const { runRcaSession } = await import("../detector-rca-processor.js");
    const result = await runRcaSession({
      findingId: "f1",
      projectId: "p1",
      workspaceId: "ws1",
      traceId: "t1",
      findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
      hasGitHub: false,
      rcaModel: "gpt-5.3",
      rcaProvider: "my-openai",
      rcaSource: "byok",
    });

    expect(result.sessionId).toBe("s1");
    expect(fetchProviderConfigMock).toHaveBeenCalledWith("ws1", "my-openai");
  });
});

describe("processRcaJob", () => {
  it("reads rcaProvider and rcaSource from project select", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.workspace, "findUnique").mockResolvedValue({
      billingPlan: "pro",
      rcaBlocked: false,
    } as any);
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);
    vi.spyOn(p.detectorRca, "update").mockResolvedValue({} as any);
    vi.spyOn(p.gitHubInstallation, "count").mockResolvedValue(0);

    const projectFindUnique = vi.spyOn(p.project, "findUnique").mockResolvedValue({
      rcaModel: "gpt-5.3",
      rcaProvider: "my-openai",
      rcaSource: "byok",
      alertConfig: { emailAddresses: [""], slackChannelId: null, slackChannelName: null },
      workspace: { slackIntegration: null },
    } as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }),
        },
      });

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob({
      data: {
        findingId: "f1",
        projectId: "p1",
        traceId: "t1",
        workspaceId: "ws1",
        projectName: "test",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
      },
    } as any);

    expect(projectFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ rcaProvider: true, rcaSource: true }),
      }),
    );
  });

  it("skips RCA when workspace is free plan and rcaBlocked", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.workspace, "findUnique").mockResolvedValue({
      billingPlan: "free",
      rcaBlocked: true,
    } as any);
    const detectorRcaUpdate = vi.spyOn(p.detectorRca, "update").mockResolvedValue({} as any);
    const projectFindUnique = vi.spyOn(p.project, "findUnique");

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob({
      data: {
        findingId: "f1",
        projectId: "p1",
        traceId: "t1",
        workspaceId: "ws1",
        projectName: "test",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
      },
    } as any);

    expect(detectorRcaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { findingId: "f1" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(projectFindUnique).not.toHaveBeenCalled();
  });

  it("marks RCA as failed and rethrows on error", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.workspace, "findUnique").mockResolvedValue({
      billingPlan: "pro",
      rcaBlocked: false,
    } as any);
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);
    const detectorRcaUpdate = vi.spyOn(p.detectorRca, "update").mockResolvedValue({} as any);
    vi.spyOn(p.project, "findUnique").mockRejectedValue(new Error("Prisma error"));

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(
      processRcaJob({
        data: {
          findingId: "f1",
          projectId: "p1",
          traceId: "t1",
          workspaceId: "ws1",
          projectName: "test",
          findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        },
      } as any),
    ).rejects.toThrow("Prisma error");

    expect(detectorRcaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { findingId: "f1" },
        data: { status: "failed" },
      }),
    );
  });
});
