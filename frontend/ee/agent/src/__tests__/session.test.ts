import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@traceroot/core", () => ({
  prisma: {
    aISession: { findUnique: vi.fn() },
    aIMessage: { create: vi.fn() },
  },
}));

import { prisma } from "@traceroot/core";
import { SessionManager, resolveMessageKind } from "../session.js";

describe("resolveMessageKind", () => {
  it('empty userId (no x-user-id header — the worker\'s automatic RCA turn) resolves to "rca"', () => {
    expect(resolveMessageKind("")).toBe("rca");
  });

  it('non-empty userId (an authenticated request — a human follow-up) resolves to "chat"', () => {
    expect(resolveMessageKind("user-123")).toBe("chat");
  });

  it('documents current truthy-based semantics: whitespace-only userId resolves to "chat"', () => {
    // Not a real-world input (the header is either the proxy's authenticated
    // user.id or omitted entirely) — this pins today's behavior explicitly
    // so a future `.trim()` "cleanup" here is a conscious decision, not a
    // silent flip of RCA-session billing.
    expect(resolveMessageKind("   ")).toBe("chat");
  });
});

describe("SessionManager.appendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists kind='chat' for a follow-up in a system-owned RCA session (userId: null)", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue({
      workspaceId: "ws-1",
      userId: null,
    });

    const manager = new SessionManager("sess-rca");
    await manager.appendMessage("user", "what caused this?", "chat");

    expect(prisma.aIMessage.create).toHaveBeenCalledTimes(1);
    const data = (prisma.aIMessage.create as any).mock.calls[0][0].data;
    expect(data.kind).toBe("chat");
  });

  it("persists kind='rca' for the automatic first turn in a user-owned session (userId set)", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue({
      workspaceId: "ws-1",
      userId: "u1",
    });

    const manager = new SessionManager("sess-user");
    await manager.appendMessage("assistant", "here's the analysis", "rca");

    expect(prisma.aIMessage.create).toHaveBeenCalledTimes(1);
    const data = (prisma.aIMessage.create as any).mock.calls[0][0].data;
    expect(data.kind).toBe("rca");
  });

  it("still pulls workspaceId from the session row", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue({
      workspaceId: "ws-42",
      userId: null,
    });

    const manager = new SessionManager("sess-1");
    await manager.appendMessage("user", "hi", "rca");

    const data = (prisma.aIMessage.create as any).mock.calls[0][0].data;
    expect(data.workspaceId).toBe("ws-42");
  });

  it("still merges tokenUsage fields onto the created row when passed", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue({
      workspaceId: "ws-1",
      userId: "u1",
    });

    const manager = new SessionManager("sess-1");
    await manager.appendMessage("assistant", "reply", "chat", undefined, {
      model: "gpt-5",
      provider: "openai",
      isByok: false,
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.01,
    });

    const data = (prisma.aIMessage.create as any).mock.calls[0][0].data;
    expect(data.model).toBe("gpt-5");
    expect(data.provider).toBe("openai");
    expect(data.inputTokens).toBe(10);
    expect(data.outputTokens).toBe(20);
    expect(data.cost).toBe(0.01);
  });

  it("throws when the session isn't found", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue(null);

    const manager = new SessionManager("missing-session");
    await expect(manager.appendMessage("user", "hi", "chat")).rejects.toThrow(
      "AISession not found: missing-session",
    );
  });

  it("does not confuse metadata with kind now that kind is a new positional argument", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue({
      workspaceId: "ws-1",
      userId: null,
    });

    const manager = new SessionManager("sess-1");
    await manager.appendMessage("user", "hi", "chat", { traceId: "t1", toolCalls: 2 });

    const data = (prisma.aIMessage.create as any).mock.calls[0][0].data;
    expect(data.kind).toBe("chat");
    expect(data.metadata).toEqual({ traceId: "t1", toolCalls: 2 });
  });

  it("leaves token/cost fields absent on the row when tokenUsage isn't passed", async () => {
    (prisma.aISession.findUnique as any).mockResolvedValue({
      workspaceId: "ws-1",
      userId: "u1",
    });

    const manager = new SessionManager("sess-1");
    await manager.appendMessage("user", "hi", "chat");

    const data = (prisma.aIMessage.create as any).mock.calls[0][0].data;
    expect(data.model).toBeUndefined();
    expect(data.provider).toBeUndefined();
    expect(data.cost).toBeUndefined();
  });

  it("looks up the specific session this instance was constructed with, not a fixed id", async () => {
    (prisma.aISession.findUnique as any)
      .mockResolvedValueOnce({ workspaceId: "ws-a", userId: null })
      .mockResolvedValueOnce({ workspaceId: "ws-b", userId: null });

    await new SessionManager("session-aaa").appendMessage("user", "hi", "rca");
    await new SessionManager("session-bbb").appendMessage("user", "hi", "rca");

    const findUniqueCalls = (prisma.aISession.findUnique as any).mock.calls;
    expect(findUniqueCalls[0][0].where).toEqual({ id: "session-aaa" });
    expect(findUniqueCalls[1][0].where).toEqual({ id: "session-bbb" });

    const createCalls = (prisma.aIMessage.create as any).mock.calls;
    expect(createCalls[0][0].data.sessionId).toBe("session-aaa");
    expect(createCalls[0][0].data.workspaceId).toBe("ws-a");
    expect(createCalls[1][0].data.sessionId).toBe("session-bbb");
    expect(createCalls[1][0].data.workspaceId).toBe("ws-b");
  });
});
