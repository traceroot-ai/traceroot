import { beforeEach, describe, expect, it, vi } from "vitest";

// session.ts reaches prisma at call time, so a module mock is enough — no client
// generation or database needed.
vi.mock("@traceroot/core", () => ({
  prisma: {
    aISession: { findUnique: vi.fn() },
    aIMessage: { create: vi.fn() },
  },
}));

import { SessionManager } from "../session.ts";
import { prisma } from "@traceroot/core";

const findUnique = prisma.aISession.findUnique as ReturnType<typeof vi.fn>;
const create = prisma.aIMessage.create as ReturnType<typeof vi.fn>;

// The session an automatic RCA runs in: created by the worker with no user, so
// userId is null. Every Alert-panel follow-up is typed into this same row.
const SYSTEM_SESSION = { workspaceId: "ws-1", userId: null };

describe("SessionManager.appendMessage — which meter a turn lands in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue(SYSTEM_SESSION);
    create.mockResolvedValue({});
  });

  it("persists the kind the caller supplies", async () => {
    await new SessionManager("s-1").appendMessage("user", "why did this fail?", "chat");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "chat", role: "user", workspaceId: "ws-1" }),
      }),
    );
  });

  it("records a user follow-up in a system session as chat, not rca", async () => {
    // The bug this replaces: kind was read off the session, and a system session
    // (userId null) forced "rca" on every turn it ever held. A person's follow-up
    // was then billed as auto-RCA and never counted against the AI-run quota.
    const manager = new SessionManager("s-1");
    await manager.appendMessage("user", "and the retry?", "chat");
    await manager.appendMessage("assistant", "the retry hit the same timeout", "chat");

    const kinds = create.mock.calls.map((call) => call[0].data.kind);
    expect(kinds).toEqual(["chat", "chat"]);
  });

  it("still records the automatic turn as rca in that same session", async () => {
    const manager = new SessionManager("s-1");
    await manager.appendMessage("user", "[RCA] investigate this finding", "rca");
    await manager.appendMessage("assistant", "root cause: unbounded retry", "rca");

    const kinds = create.mock.calls.map((call) => call[0].data.kind);
    expect(kinds).toEqual(["rca", "rca"]);
  });

  it("carries token usage through unchanged", async () => {
    await new SessionManager("s-1").appendMessage("assistant", "answer", "chat", undefined, {
      model: "claude-opus-4-8",
      provider: "anthropic",
      isByok: false,
      inputTokens: 120,
      outputTokens: 40,
      cost: 0.0021,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "chat",
          model: "claude-opus-4-8",
          inputTokens: 120,
          outputTokens: 40,
          cost: 0.0021,
        }),
      }),
    );
  });

  it("fails loudly when the session is gone", async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      new SessionManager("missing").appendMessage("user", "hello", "chat"),
    ).rejects.toThrow("AISession not found: missing");
    expect(create).not.toHaveBeenCalled();
  });
});
