import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findUnique = vi.fn();
const count = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    aIMessage: {
      create: (...a: unknown[]) => create(...a),
      count: (...a: unknown[]) => count(...a),
    },
    aISession: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { SessionManager } from "../session.js";

beforeEach(() => {
  create.mockReset();
  findUnique.mockReset();
  count.mockReset();
});

describe("appendMessage attribution", () => {
  it("system session + executionId + first assistant turn → rca_execution", async () => {
    findUnique.mockResolvedValue({ workspaceId: "w", userId: null, executionId: "exec-1" });
    count.mockResolvedValue(0);
    await new SessionManager("s1").appendMessage("assistant", "root cause…");
    expect(create.mock.calls[0][0].data).toMatchObject({
      turnKind: "rca_execution",
      executionId: "exec-1",
      initiatorUserId: null,
      kind: "rca",
    });
  });
  it("system session, later turn with a user → rca_followup", async () => {
    findUnique.mockResolvedValue({ workspaceId: "w", userId: null, executionId: "exec-1" });
    count.mockResolvedValue(1);
    await new SessionManager("s1").appendMessage("user", "why?", undefined, undefined, {
      turnKind: "rca_followup",
      initiatorUserId: "u9",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      turnKind: "rca_followup",
      initiatorUserId: "u9",
      kind: "rca",
    });
  });
  it("user session → chat with the session owner as initiator", async () => {
    findUnique.mockResolvedValue({ workspaceId: "w", userId: "u1", executionId: null });
    await new SessionManager("s2").appendMessage("user", "hi");
    expect(create.mock.calls[0][0].data).toMatchObject({
      turnKind: "chat",
      initiatorUserId: "u1",
      kind: "chat",
    });
  });
});
