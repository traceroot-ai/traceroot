import { describe, it, expect, vi, afterEach } from "vitest";

const fetchProviderConfigMock = vi.fn();
const resolvePiModelMock = vi.fn();
const modelProviderFindMany = vi.fn().mockResolvedValue([]);
const digestAddMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@traceroot/core/model-resolver", async () => ({
  fetchProviderConfig: (...args: any[]) => fetchProviderConfigMock(...args),
  resolvePiModel: (...args: any[]) => resolvePiModelMock(...args),
}));

vi.mock("../../queues/digest-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../queues/digest-queue.js")>();
  return { ...actual, createDetectorDigestQueue: () => ({ add: digestAddMock }) };
});

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
  mockFetch.mockReset();
  modelProviderFindMany.mockReset();
  modelProviderFindMany.mockResolvedValue([]);
  digestAddMock.mockReset().mockResolvedValue(undefined);
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
    expect(res).toEqual({
      kind: "resolved",
      model: "gpt-5.3",
      providerName: "my-openai",
      source: "byok",
    });
  });

  it("returns invalid when BYOK provider is not found or disabled", async () => {
    fetchProviderConfigMock.mockResolvedValue(null);

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("gpt-5.3", "missing-provider", "byok", "ws-123");

    expect(res).toEqual({
      kind: "invalid",
      error: 'BYOK provider "missing-provider" was not found or is disabled',
    });
    expect(resolvePiModelMock).not.toHaveBeenCalled();
  });

  it("resolves a system model via resolvePiModel", async () => {
    resolvePiModelMock.mockReturnValue({ id: "claude-sonnet-4-5", provider: "anthropic" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("claude-sonnet-4-5", null, null, "ws-123");

    expect(resolvePiModelMock).toHaveBeenCalledWith("claude-sonnet-4-5", null);
    expect(res).toEqual({
      kind: "resolved",
      model: "claude-sonnet-4-5",
      providerName: "anthropic",
      source: "system",
    });
  });

  it("does not scan workspace BYOK providers for legacy null-source RCA models", async () => {
    modelProviderFindMany.mockResolvedValue([
      { provider: "my-deepseek", customModels: ["deepseek-chat"] },
    ]);

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("deepseek-chat", null, null, "ws-123");

    expect(res).toEqual({
      kind: "invalid",
      error: 'RCA model "deepseek-chat" is not available for source "system"',
    });
    expect(modelProviderFindMany).not.toHaveBeenCalled();
    expect(fetchProviderConfigMock).not.toHaveBeenCalled();
  });

  it("returns invalid for unknown models not in system catalog", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("unknown-model", null, null, "ws-123");

    expect(res).toEqual({
      kind: "invalid",
      error: 'RCA model "unknown-model" is not available for source "system"',
    });
    expect(fetchProviderConfigMock).not.toHaveBeenCalled();
  });

  it("returns unset for empty or undefined models when no tuple fields are configured", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    expect(await resolveProjectModel(null, null, null, "ws-123")).toEqual({ kind: "unset" });
    expect(await resolveProjectModel(undefined, null, null, "ws-123")).toEqual({ kind: "unset" });
  });

  it("returns invalid for empty models with stale partial tuple fields", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel(null, "my-openai", "byok", "ws-123");

    expect(res).toEqual({
      kind: "invalid",
      error: "RCA model configuration is incomplete; model is missing",
    });
  });

  it("returns invalid for BYOK RCA models without an explicit provider", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("gpt-5.3", null, "byok", "ws-123");

    expect(res).toEqual({
      kind: "invalid",
      error: 'BYOK RCA model "gpt-5.3" has no provider',
    });
    expect(modelProviderFindMany).not.toHaveBeenCalled();
    expect(fetchProviderConfigMock).not.toHaveBeenCalled();
  });

  it("returns invalid for explicit system provider/model mismatches", async () => {
    resolvePiModelMock.mockReturnValue({ id: "claude-sonnet-4-5", provider: "anthropic" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("claude-sonnet-4-5", "openai", "system", "ws-123");

    expect(res).toEqual({
      kind: "invalid",
      error: 'System provider "openai" does not match model provider "anthropic"',
    });
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
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Internal-Secret": expect.any(String) }),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Internal-Secret": expect.any(String) }),
        body: expect.stringContaining('"providerName":"my-openai"'),
      }),
    );
  });

  it("rejects invalid BYOK RCA configuration before creating an agent session", async () => {
    fetchProviderConfigMock.mockResolvedValue(null);

    const { prisma: p } = await import("@traceroot/core");
    const upsertSpy = vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    const { runRcaSession } = await import("../detector-rca-processor.js");
    await expect(
      runRcaSession({
        findingId: "f1",
        projectId: "p1",
        workspaceId: "ws1",
        traceId: "t1",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        hasGitHub: false,
        rcaModel: "gpt-5.3",
        rcaProvider: "missing-provider",
        rcaSource: "byok",
      }),
    ).rejects.toThrow(
      'Invalid RCA model configuration: BYOK provider "missing-provider" was not found or is disabled',
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe("processRcaJob", () => {
  it("reads rcaProvider and rcaSource from project select", async () => {
    fetchProviderConfigMock.mockResolvedValue({
      adapter: "openai",
      key: "sk-xxx",
      baseUrl: null,
      config: null,
    });
    resolvePiModelMock.mockReturnValue({ id: "gpt-5.3", provider: "openai" });

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

describe("processRcaJob — digest scheduling at the flush seam", () => {
  // Drive a full successful RCA run so scheduleDigestFlush fires in the try path.
  // alertConfig is the only variable across the cases below; pass null to model
  // a project with no explicit window (should fall back to DEFAULT_ALERT_WINDOW).
  async function runWithAlertConfig(
    alertConfig: { alertWindow: string } | null,
    findingTimestamp: number | undefined,
  ) {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.workspace, "findUnique").mockResolvedValue({
      billingPlan: "pro",
      rcaBlocked: false,
    } as any);
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);
    vi.spyOn(p.detectorRca, "update").mockResolvedValue({} as any);
    vi.spyOn(p.gitHubInstallation, "count").mockResolvedValue(0);
    vi.spyOn(p.project, "findUnique").mockResolvedValue({
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
      alertConfig,
    } as any);

    // Agent session create + empty SSE stream → RCA completes with "".
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
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        findingTimestamp,
      },
    } as any);
  }

  it("enqueues one deduped flush job for the configured window", async () => {
    await runWithAlertConfig({ alertWindow: "30m" }, 1_700_000_123_456);

    expect(digestAddMock).toHaveBeenCalledTimes(1);
    expect(digestAddMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        projectId: "p1",
        windowMs: 1_800_000,
        windowStart: Math.floor(1_700_000_123_456 / 1_800_000) * 1_800_000,
      }),
      expect.objectContaining({ jobId: expect.stringMatching(/^digest:p1:\d+$/) }),
    );
  });

  it("falls back to the 10m default window when the project has no alert config", async () => {
    await runWithAlertConfig(null, 1_700_000_123_456);

    expect(digestAddMock).toHaveBeenCalledTimes(1);
    expect(digestAddMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        projectId: "p1",
        windowMs: 600_000,
        windowStart: Math.floor(1_700_000_123_456 / 600_000) * 600_000,
      }),
      expect.objectContaining({ jobId: expect.stringMatching(/^digest:p1:\d+$/) }),
    );
  });

  it("falls back to a current-window key when a legacy job carries no findingTimestamp", async () => {
    await runWithAlertConfig({ alertWindow: "30m" }, undefined);

    expect(digestAddMock).toHaveBeenCalledTimes(1);
    const [, payload, opts] = digestAddMock.mock.calls[0];
    // No NaN leaks into the window key, jobId, or flush payload.
    expect(Number.isFinite(payload.windowStart)).toBe(true);
    expect(payload.windowStart % 1_800_000).toBe(0);
    expect(opts.jobId).toMatch(/^digest:p1:\d+$/);
  });

  it("does not revert a completed RCA to failed when the digest enqueue throws", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.workspace, "findUnique").mockResolvedValue({
      billingPlan: "pro",
      rcaBlocked: false,
    } as any);
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);
    const updateSpy = vi.spyOn(p.detectorRca, "update").mockResolvedValue({} as any);
    vi.spyOn(p.gitHubInstallation, "count").mockResolvedValue(0);
    vi.spyOn(p.project, "findUnique").mockResolvedValue({
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
      alertConfig: { alertWindow: "30m" },
    } as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }),
        },
      });

    // RCA completes, then the digest enqueue fails on the success path.
    digestAddMock.mockRejectedValueOnce(new Error("redis down"));

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(
      processRcaJob({
        data: {
          findingId: "f1",
          projectId: "p1",
          traceId: "t1",
          workspaceId: "ws1",
          findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
          findingTimestamp: 1_700_000_123_456,
        },
      } as any),
    ).rejects.toThrow("redis down"); // propagates so BullMQ retries

    // The RCA was marked done; the enqueue failure must NOT flip it to failed.
    const statuses = updateSpy.mock.calls.map((c) => (c[0] as any)?.data?.status);
    expect(statuses).toContain("done");
    expect(statuses).not.toContain("failed");
  });
});
