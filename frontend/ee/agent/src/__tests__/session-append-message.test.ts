import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findUnique = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    aIMessage: { create: (...a: unknown[]) => create(...a) },
    aISession: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { SessionManager } from "../session.js";

beforeEach(() => {
  create.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue({ workspaceId: "w" });
});

describe("appendMessage attribution", () => {
  it("writes the turn's kind and the session's workspace", async () => {
    await new SessionManager("s1").appendMessage("assistant", "root cause…", {
      turnKind: "rca_execution",
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" }, select: { workspaceId: true } }),
    );
    expect(create.mock.calls[0][0].data).toMatchObject({
      sessionId: "s1",
      workspaceId: "w",
      role: "assistant",
      content: "root cause…",
      turnKind: "rca_execution",
    });
    expect(create.mock.calls[0][0].data).not.toHaveProperty("executionId");
    expect(create.mock.calls[0][0].data).not.toHaveProperty("initiatorUserId");
  });

  it("records a follow-up's author on the user row's metadata, nowhere else", async () => {
    // The RCA session has no user of its own, so this is the one record of who
    // asked; the turn's other rows are the agent's and carry nothing.
    const m = new SessionManager("s1");
    await m.appendMessage("user", "and then?", { turnKind: "rca_followup", initiatorUserId: "u1" });
    await m.appendMessage("assistant", "then…", {
      turnKind: "rca_followup",
      initiatorUserId: "u1",
    });
    expect(create.mock.calls[0][0].data.metadata).toEqual({ initiatorUserId: "u1" });
    expect(create.mock.calls[1][0].data.metadata).toBeUndefined();
  });

  it("keeps the user row's other metadata beside the author", async () => {
    await new SessionManager("s1").appendMessage(
      "user",
      "hi",
      { turnKind: "rca_followup", initiatorUserId: "u1" },
      { attachments: 1 },
    );
    expect(create.mock.calls[0][0].data.metadata).toEqual({
      attachments: 1,
      initiatorUserId: "u1",
    });
  });

  it("writes no author for a chat turn: the session's user already is", async () => {
    await new SessionManager("s1").appendMessage("user", "hi", { turnKind: "chat" });
    expect(create.mock.calls[0][0].data.metadata).toBeUndefined();
  });

  // `kind` is what usage metering still groups by; it must keep the pre-attribution
  // values so a turn's billing bucket does not change with this column.
  it.each([
    ["rca_execution", "rca"],
    ["rca_followup", "rca"],
    ["chat", "chat"],
    ["detector", "detector"],
    ["digest", "digest-summary"],
  ] as const)("derives the legacy kind for %s → %s", async (turnKind, kind) => {
    await new SessionManager("s1").appendMessage("assistant", "…", { turnKind });
    expect(create.mock.calls[0][0].data).toMatchObject({ turnKind, kind });
  });

  it("throws when the session does not exist rather than writing an orphan row", async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      new SessionManager("missing").appendMessage("user", "hi", { turnKind: "chat" }),
    ).rejects.toThrow("AISession not found: missing");
    expect(create).not.toHaveBeenCalled();
  });
});
