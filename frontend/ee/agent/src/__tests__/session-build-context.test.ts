import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: { aISession: { findUnique: mocks.findUnique } },
}));

import { SessionManager } from "../session.js";

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

  it("skips tool_step rows — the agent re-invokes tools rather than replaying results", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "s1",
      messages: [
        row("1", "user", "check the trace"),
        row("2", "tool_step", "", {
          metadata: { toolCallId: "t1", toolName: "get_traces", args: {} },
        }),
        row("3", "assistant", "Looked it up."),
      ],
    });

    const context = await new SessionManager("s1").buildContext();
    expect(context.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("returns an empty context for a missing or empty session", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await new SessionManager("s1").buildContext()).toEqual([]);

    mocks.findUnique.mockResolvedValue({ id: "s1", messages: [] });
    expect(await new SessionManager("s1").buildContext()).toEqual([]);
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
