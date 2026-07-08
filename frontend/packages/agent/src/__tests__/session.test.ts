import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  aISession: {
    findUnique: vi.fn(),
  },
  aIMessage: {
    create: vi.fn(),
  },
}));

vi.mock("@traceroot/core", () => ({
  prisma: mockPrisma,
}));

import { SessionManager } from "../session.js";

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists tool results as compact tool messages with replay metadata", async () => {
    mockPrisma.aISession.findUnique.mockResolvedValue({
      workspaceId: "workspace-1",
      userId: "user-1",
    });

    const manager = new SessionManager("session-1");

    await manager.appendToolResult({
      toolCallId: "call-1",
      toolName: "download_traces",
      args: { traceIds: ["trace-1"], label: "inspect trace" },
      result: {
        content: [
          {
            type: "text",
            text: "Downloaded 1/1 traces:\ntrace-1 -> /workspace/traces/trace-1_demo/",
          },
        ],
        details: undefined,
      },
      isError: false,
    });

    expect(mockPrisma.aIMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        kind: "chat",
        role: "tool",
        content: expect.stringContaining("/workspace/traces/trace-1_demo/"),
        metadata: expect.objectContaining({
          toolCallId: "call-1",
          toolName: "download_traces",
          args: { traceIds: ["trace-1"], label: "inspect trace" },
          resultSummary: expect.stringContaining("Downloaded 1/1 traces"),
          isError: false,
        }),
      }),
    });
  });

  it("handles non-text tool result blocks, circular args, and long summaries", async () => {
    mockPrisma.aISession.findUnique.mockResolvedValue({
      workspaceId: "workspace-1",
      userId: null,
    });

    const circularArgs: Record<string, unknown> = { traceId: "trace-1" };
    circularArgs.self = circularArgs;
    const longText = "x".repeat(8100);

    const manager = new SessionManager("session-1");
    await manager.appendToolResult({
      toolCallId: "call-2",
      toolName: "read",
      args: circularArgs,
      result: {
        content: [
          { type: "image", mimeType: "image/png", data: "base64" },
          { type: "custom", payload: { ok: true } },
          { type: "text", text: longText },
        ],
      },
      isError: true,
    });

    const createData = mockPrisma.aIMessage.create.mock.calls[0][0].data;
    expect(createData.kind).toBe("rca");
    expect(createData.metadata.args).toBe("[object Object]");
    expect(createData.metadata.resultSummary).toContain("[image: image/png]");
    expect(createData.metadata.resultSummary).toContain('"payload"');
    expect(createData.metadata.resultSummary).toContain("[truncated");
    expect(createData.metadata.isError).toBe(true);
  });

  it("summarizes string tool results for older result payload shapes", async () => {
    mockPrisma.aISession.findUnique.mockResolvedValue({
      workspaceId: "workspace-1",
      userId: "user-1",
    });

    const manager = new SessionManager("session-1");
    await manager.appendToolResult({
      toolCallId: "call-3",
      toolName: "legacy_tool",
      args: {},
      result: "legacy plain text result",
      isError: false,
    });

    const createData = mockPrisma.aIMessage.create.mock.calls[0][0].data;
    expect(createData.content).toContain("legacy_tool");
    expect(createData.content).toContain("legacy plain text result");
    expect(createData.metadata.resultSummary).toBe("legacy plain text result");
  });

  it("falls back to stored tool content when replay metadata is incomplete", async () => {
    const circularMetadata: Record<string, unknown> = { toolName: "read" };
    circularMetadata.args = circularMetadata;

    mockPrisma.aISession.findUnique.mockResolvedValue({
      messages: [
        {
          role: "tool",
          content: "raw stored tool result",
          metadata: circularMetadata,
          createTime: new Date("2026-07-08T00:00:03.000Z"),
        },
      ],
    });

    const manager = new SessionManager("session-1");
    const context = await manager.buildContext();
    const replayContent = context[0].role === "user" ? context[0].content : [];
    const replayText =
      Array.isArray(replayContent) && replayContent[0]?.type === "text"
        ? replayContent[0].text
        : "";

    expect(replayText).toContain("read");
    expect(replayText).toContain("[object Object]");
    expect(replayText).toContain("raw stored tool result");
  });

  it("replays user and tool messages in database order", async () => {
    mockPrisma.aISession.findUnique.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "Investigate this trace",
          metadata: null,
          createTime: new Date("2026-07-08T00:00:00.000Z"),
        },
        {
          role: "tool",
          content: "Tool succeeded: download_traces",
          metadata: {
            toolCallId: "call-1",
            toolName: "download_traces",
            args: { traceIds: ["trace-1"] },
            resultSummary: "Downloaded to /workspace/traces/trace-1_demo/",
            isError: false,
          },
          createTime: new Date("2026-07-08T00:00:01.000Z"),
        },
        {
          role: "assistant",
          content: "The failure came from the tool response.",
          metadata: null,
          createTime: new Date("2026-07-08T00:00:02.000Z"),
        },
      ],
    });

    const manager = new SessionManager("session-1");
    const context = await manager.buildContext();

    expect(context).toHaveLength(2);
    expect(context[0]).toMatchObject({
      role: "user",
      timestamp: new Date("2026-07-08T00:00:00.000Z").getTime(),
    });
    expect(context[0].content).toEqual([{ type: "text", text: "Investigate this trace" }]);

    expect(context[1]).toMatchObject({
      role: "user",
      timestamp: new Date("2026-07-08T00:00:01.000Z").getTime(),
    });
    const replayContent = context[1].role === "user" ? context[1].content : [];
    const replayText =
      Array.isArray(replayContent) && replayContent[0]?.type === "text"
        ? replayContent[0].text
        : "";
    expect(replayText).toContain("[Previous tool result]");
    expect(replayText).toContain("download_traces");
    expect(replayText).toContain('"trace-1"');
    expect(replayText).toContain("/workspace/traces/trace-1_demo/");
    expect(replayText).toContain("rerun this tool");
  });
});
