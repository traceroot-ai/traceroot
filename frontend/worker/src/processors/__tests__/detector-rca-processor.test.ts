import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    expect(res).toEqual({ model: "gpt-5.3", providerName: "my-openai", source: "byok" });
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
    expect(res).toEqual({ model: "deepseek-chat", providerName: "my-deepseek", source: "byok" });
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

// Encodes SSE frames the way hono's streamSSE/writeSSE does: event: <name>\n
// data: <json>\n\n.
function sseText(frames: Array<{ event?: string; data: unknown }>): string {
  return frames
    .map((f) => `${f.event ? `event: ${f.event}\n` : ""}data: ${JSON.stringify(f.data)}\n\n`)
    .join("");
}

// Delivers pre-split string chunks one per reader.read() call, then a
// terminal `done` read — lets tests simulate SSE bytes arriving split at
// arbitrary (including hostile) boundaries across the underlying TCP stream.
function chunkedSseBody(chunks: string[]) {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          if (i < encoded.length) {
            const value = encoded[i];
            i += 1;
            return Promise.resolve({ done: false, value });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}

// Single-chunk delivery — the common case exercised by most tests below.
function sseBody(frames: Array<{ event?: string; data: unknown }>) {
  return chunkedSseBody([sseText(frames)]);
}

const textDeltaFrame = {
  event: "message_update",
  data: {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Root cause: found it." },
  },
};

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
      .mockResolvedValueOnce(sseBody([textDeltaFrame]));

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

  it("throws with the agent's message when the stream carries an `event: error` frame", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseBody([{ event: "error", data: { message: "Invalid API key for provider" } }]),
      );

    const { runRcaSession } = await import("../detector-rca-processor.js");
    await expect(
      runRcaSession({
        findingId: "f1",
        projectId: "p1",
        workspaceId: "ws1",
        traceId: "t1",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        hasGitHub: false,
      }),
    ).rejects.toThrow(/Invalid API key for provider/);
  });

  it('throws when message_end reports stopReason "error"', async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseBody([
          {
            event: "message_end",
            data: {
              type: "message_end",
              message: { stopReason: "error", errorMessage: "Model overloaded" },
            },
          },
        ]),
      );

    const { runRcaSession } = await import("../detector-rca-processor.js");
    await expect(
      runRcaSession({
        findingId: "f1",
        projectId: "p1",
        workspaceId: "ws1",
        traceId: "t1",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        hasGitHub: false,
      }),
    ).rejects.toThrow(/Model overloaded/);
  });

  it("throws when the stream ends with no accumulated text", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseBody([
          {
            event: "message_end",
            data: { type: "message_end", message: { stopReason: "end_turn" } },
          },
        ]),
      );

    const { runRcaSession } = await import("../detector-rca-processor.js");
    await expect(
      runRcaSession({
        findingId: "f1",
        projectId: "p1",
        workspaceId: "ws1",
        traceId: "t1",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        hasGitHub: false,
      }),
    ).rejects.toThrow(/no output/i);
  });

  it("returns accumulated text unchanged for a healthy stream (regression guard)", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseBody([
          textDeltaFrame,
          {
            event: "message_update",
            data: {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: " Code location: foo.ts:12." },
            },
          },
          {
            event: "message_end",
            data: { type: "message_end", message: { stopReason: "end_turn" } },
          },
          // The real producer's onDone handler writes this terminal frame
          // (frontend/packages/agent/src/index.ts) after a successful run.
          { event: "done", data: {} },
        ]),
      );

    const { runRcaSession } = await import("../detector-rca-processor.js");
    const result = await runRcaSession({
      findingId: "f1",
      projectId: "p1",
      workspaceId: "ws1",
      traceId: "t1",
      findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
      hasGitHub: false,
    });

    expect(result.result).toBe("Root cause: found it. Code location: foo.ts:12.");
    expect(result.sessionId).toBe("s1");
  });

  it("accumulates identical text when the same frames arrive split across multiple chunks at hostile boundaries", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    const frame1 = textDeltaFrame;
    const frame2 = {
      event: "message_update",
      data: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " Code location: foo.ts:12." },
      },
    };
    const frame3 = {
      event: "message_end",
      data: { type: "message_end", message: { stopReason: "end_turn" } },
    };
    const frame4 = { event: "done", data: {} };
    const frames = [frame1, frame2, frame3, frame4];

    // Split hostilely: (1) frame1's `event:` line from its `data:` line, and
    // (2) frame2's `data:` line mid-JSON, inside the delta string itself.
    const f1Text = sseText([frame1]);
    const f1SplitAt = f1Text.indexOf("data: ");
    const f2Json = JSON.stringify(frame2.data);
    const f2SplitInJson = f2Json.indexOf("Code location") + 5;

    const chunks = [
      f1Text.slice(0, f1SplitAt), // "event: message_update\n" only
      f1Text.slice(f1SplitAt) + // rest of frame1
        "event: message_update\ndata: " +
        f2Json.slice(0, f2SplitInJson), // frame2's event + data prefix + half its JSON
      f2Json.slice(f2SplitInJson) + "\n\n" + sseText([frame3, frame4]), // rest of frame2 + frame3 + frame4
    ];

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(chunkedSseBody(chunks))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s2" }) })
      .mockResolvedValueOnce(sseBody(frames));

    const { runRcaSession } = await import("../detector-rca-processor.js");
    const chunkedResult = await runRcaSession({
      findingId: "f1",
      projectId: "p1",
      workspaceId: "ws1",
      traceId: "t1",
      findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
      hasGitHub: false,
    });
    const singleChunkResult = await runRcaSession({
      findingId: "f1",
      projectId: "p1",
      workspaceId: "ws1",
      traceId: "t1",
      findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
      hasGitHub: false,
    });

    expect(chunkedResult.result).toBe("Root cause: found it. Code location: foo.ts:12.");
    expect(chunkedResult.result).toBe(singleChunkResult.result);
  });

  it("throws with the agent's message when an `event: error` frame is split across chunks", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    const errorText = sseText([
      { event: "error", data: { message: "Invalid API key for provider" } },
    ]);
    const splitAt = errorText.indexOf("data: ");
    const chunks = [errorText.slice(0, splitAt), errorText.slice(splitAt)];

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(chunkedSseBody(chunks));

    const { runRcaSession } = await import("../detector-rca-processor.js");
    await expect(
      runRcaSession({
        findingId: "f1",
        projectId: "p1",
        workspaceId: "ws1",
        traceId: "t1",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        hasGitHub: false,
      }),
    ).rejects.toThrow(/Invalid API key for provider/);
  });

  it("resets the current event name at the blank line so an event-less frame after an error isn't misread as another error", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseBody([
          { event: "error", data: { message: "Invalid API key for provider" } },
          // No `event:` line — if the blank line terminating the previous
          // frame failed to reset currentEventName, this would be
          // misclassified as another "error" data payload and its lack of a
          // `message` field would overwrite the real error with
          // "unknown agent error".
          {
            data: {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "some text" },
            },
          },
        ]),
      );

    const { runRcaSession } = await import("../detector-rca-processor.js");
    await expect(
      runRcaSession({
        findingId: "f1",
        projectId: "p1",
        workspaceId: "ws1",
        traceId: "t1",
        findings: [{ detectorName: "d1", summary: "s1", detectorId: "did1" }],
        hasGitHub: false,
      }),
    ).rejects.toThrow(/Invalid API key for provider/);
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
      .mockResolvedValueOnce(sseBody([textDeltaFrame]));

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
        data: expect.objectContaining({
          status: "failed",
          result: expect.stringContaining("Prisma error"),
          completedAt: expect.any(Date),
        }),
      }),
    );
    // A failed RCA must still alert: scheduleDigestFlush runs from the catch
    // block so the finding isn't silently dropped from the digest.
    expect(digestAddMock).toHaveBeenCalledTimes(1);
  });

  it("records the RCA agent's error message into result when the agent stream fails", async () => {
    const { prisma: p } = await import("@traceroot/core");
    vi.spyOn(p.workspace, "findUnique").mockResolvedValue({
      billingPlan: "pro",
      rcaBlocked: false,
    } as any);
    vi.spyOn(p.detectorRca, "upsert").mockResolvedValue({} as any);
    const detectorRcaUpdate = vi.spyOn(p.detectorRca, "update").mockResolvedValue({} as any);
    vi.spyOn(p.gitHubInstallation, "count").mockResolvedValue(0);
    vi.spyOn(p.project, "findUnique").mockResolvedValue({
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
      alertConfig: { alertWindow: "30m" },
    } as any);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseBody([{ event: "error", data: { message: "Invalid API key for provider" } }]),
      );

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
    ).rejects.toThrow(/Invalid API key for provider/);

    expect(detectorRcaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { findingId: "f1" },
        data: expect.objectContaining({
          status: "failed",
          result: expect.stringContaining("Invalid API key for provider"),
          completedAt: expect.any(Date),
        }),
      }),
    );
    // A failed RCA must still alert: scheduleDigestFlush runs from the catch
    // block so the finding isn't silently dropped from the digest.
    expect(digestAddMock).toHaveBeenCalledTimes(1);
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

    // Agent session create + a healthy SSE stream → RCA completes with text.
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(sseBody([textDeltaFrame]));

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
      .mockResolvedValueOnce(sseBody([textDeltaFrame]));

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
