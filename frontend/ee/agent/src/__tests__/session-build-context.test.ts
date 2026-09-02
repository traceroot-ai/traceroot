import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: { aISession: { findUnique: mocks.findUnique } },
}));

import { SessionManager } from "../session.js";
import { StreamPersister } from "../stream-persister.js";

const row = (id: string, role: string, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  role,
  content,
  createTime: new Date(`2026-01-01T00:00:0${id}Z`),
  model: null,
  provider: null,
  metadata: null,
  ...extra,
});

describe("SessionManager.buildContext", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
  });

  it("restores user AND assistant turns in order so the agent keeps its own answers", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "what failed?"),
        row("2", "assistant", "The checkout span timed out.", {
          model: "test-model",
          provider: "test-provider",
        }),
        row("3", "user", "why?"),
      ],
    });

    const context = await new SessionManager("s1").buildContext();

    expect(context.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistant = context[1] as {
      role: string;
      content: Array<{ type: string; text: string }>;
      stopReason: string;
      model: string;
    };
    expect(assistant.content).toEqual([{ type: "text", text: "The checkout span timed out." }]);
    expect(assistant.stopReason).toBe("stop");
    expect(assistant.model).toBe("test-model");
  });

  it("restores a fulfilled create as a factual record so a rebuilt agent does not re-execute it", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "add a p95 latency chart"),
        row("2", "tool_step", "", {
          metadata: {
            toolCallId: "t1",
            toolName: "create_widget",
            args: { title: "p95 latency", dashboard_id: "d1" },
            result: {
              content: [{ type: "text", text: 'Created widget "p95 latency" (id w1)' }],
              details: {
                kind: "resource_created",
                resourceType: "widget",
                resourceId: "w1",
                created: true,
              },
            },
            isError: false,
          },
        }),
        row("3", "assistant", "Done — added the chart."),
      ],
    });

    const context = await new SessionManager("s1").buildContext();

    expect(context.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const record = context[1] as { content: Array<{ type: string; text: string }> };
    const text = record.content[0].text;
    expect(text).toContain("create_widget");
    expect(text).toContain("p95 latency");
    expect(text).toContain("created");
    expect(text).toContain("w1");
  });

  it("labels reused, declined, and failed tool outcomes honestly", async () => {
    const toolRow = (id: string, metadata: Record<string, unknown>) =>
      row(id, "tool_step", "", { metadata });
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "set things up"),
        toolRow("2", {
          toolCallId: "t1",
          toolName: "create_dashboard",
          args: { name: "Ops" },
          result: {
            content: [{ type: "text", text: 'Dashboard "Ops" already exists (id d1)' }],
            details: {
              kind: "resource_created",
              resourceType: "dashboard",
              resourceId: "d1",
              created: false,
            },
          },
          isError: false,
        }),
        toolRow("3", {
          toolCallId: "t2",
          toolName: "create_widget",
          args: { title: "errors" },
          result: {
            content: [{ type: "text", text: "Skipped." }],
            details: { kind: "proposal_declined", outcome: "skipped" },
          },
          isError: false,
        }),
        toolRow("4", {
          toolCallId: "t3",
          toolName: "create_widget",
          args: { title: "costs" },
          result: {
            content: [{ type: "text", text: "Revise it." }],
            details: { kind: "proposal_declined", outcome: "revised" },
          },
          isError: false,
        }),
        toolRow("5", {
          toolCallId: "t4",
          toolName: "create_detector",
          args: { name: "latency" },
          result: { content: [{ type: "text", text: "API error 403: Not a member" }] },
          isError: true,
        }),
      ],
    });

    const context = await new SessionManager("s1").buildContext();
    const texts = context
      .slice(1)
      .map((m) => (m as { content: Array<{ text: string }> }).content[0].text);

    expect(texts[0]).toContain("reused");
    expect(texts[0]).toContain("d1");
    // Declined proposals must be unmistakable as NOT executed.
    expect(texts[1]).toContain("declined");
    expect(texts[1]).toContain("not executed");
    expect(texts[2]).toContain("revision");
    expect(texts[2]).toContain("not executed");
    expect(texts[3]).toContain("failed");
    expect(texts[3]).toContain("API error 403");
  });

  it("degrades a tool_step with absent or truncated metadata to a bare completion record", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "go"),
        row("2", "tool_step", "", { metadata: null }),
        row("3", "tool_step", "", {
          metadata: {
            toolCallId: "t1",
            toolName: "create_widget",
            args: { truncated: true, bytes: 90000, preview: "{" },
            result: { truncated: true, bytes: 90000, preview: "{" },
            isError: false,
          },
        }),
      ],
    });

    const context = await new SessionManager("s1").buildContext();
    const texts = context
      .slice(1)
      .map((m) => (m as { content: Array<{ text: string }> }).content[0].text);
    expect(texts[0]).toContain("a tool call completed");
    expect(texts[1]).toContain("a create_widget call completed");
    // A degraded record must never claim an outcome it cannot know.
    expect(texts[1]).not.toContain("created");
  });

  it("caps each restored tool record instead of dumping persisted payloads", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "go"),
        row("2", "tool_step", "", {
          metadata: {
            toolCallId: "t1",
            toolName: "get_traces",
            args: { query: "q" },
            result: { content: [{ type: "text", text: "x".repeat(7000) }] },
            isError: false,
          },
        }),
      ],
    });

    const context = await new SessionManager("s1").buildContext();
    const text = (context[1] as { content: Array<{ text: string }> }).content[0].text;
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("get_traces");
  });

  it("returns an empty context for a missing or empty session", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await new SessionManager("s1").buildContext()).toEqual([]);

    mocks.findUnique.mockResolvedValue({ id: "s1", messages: [] });
    expect(await new SessionManager("s1").buildContext()).toEqual([]);
  });

  it("rebuilds the same tool-outcome content the live stream persisted (live vs rebuilt parity)", async () => {
    // Drive a live run's events through the real StreamPersister, then feed
    // the rows it produced into buildContext: every completed tool call must
    // come back as a record carrying the outcome the live stream saw.
    const persisted: Array<{
      role: string;
      content: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const persister = new StreamPersister(async (role, content, metadata) => {
      persisted.push({ role, content, metadata });
    });
    persister.onEvent({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "create_widget",
      args: { title: "p95 latency", dashboard_id: "d1" },
    } as never);
    persister.onEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "create_widget",
      result: {
        content: [{ type: "text", text: 'Created widget "p95 latency" (id w1)' }],
        details: {
          kind: "resource_created",
          resourceType: "widget",
          resourceId: "w1",
          created: true,
        },
      },
      isError: false,
    } as never);
    await persister.finish();

    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "add a p95 chart"),
        ...persisted.map((p, i) => row(`${i + 2}`, p.role, p.content, { metadata: p.metadata })),
      ],
    });

    const context = await new SessionManager("s1").buildContext();
    const records = context.filter(
      (m) =>
        m.role === "assistant" &&
        (m as { content: Array<{ text: string }> }).content[0].text.includes("create_widget"),
    );
    expect(records).toHaveLength(1);
    const text = (records[0] as { content: Array<{ text: string }> }).content[0].text;
    for (const fragment of ["create_widget", "p95 latency", "created", "w1"]) {
      expect(text).toContain(fragment);
    }
  });

  it("skips content-less assistant rows (usage carriers of tool-only runs)", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "check the trace"),
        row("2", "assistant", "", { model: "test-model", provider: "test-provider" }),
      ],
    });

    const context = await new SessionManager("s1").buildContext();
    expect(context.map((m) => m.role)).toEqual(["user"]);
  });
});
