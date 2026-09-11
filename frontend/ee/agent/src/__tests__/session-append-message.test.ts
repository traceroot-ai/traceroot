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
  it("writes the turn's attribution columns and the session's workspace", async () => {
    await new SessionManager("s1").appendMessage("assistant", "root cause…", {
      turnKind: "rca_execution",
      executionId: "exec-1",
      initiatorUserId: null,
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
      executionId: "exec-1",
      initiatorUserId: null,
    });
  });

  it("stores null for attribution fields the turn did not name", async () => {
    await new SessionManager("s1").appendMessage("user", "hi", {
      turnKind: "chat",
      initiatorUserId: "u1",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      turnKind: "chat",
      executionId: null,
      initiatorUserId: "u1",
    });
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
