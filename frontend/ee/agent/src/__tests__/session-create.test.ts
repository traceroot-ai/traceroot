import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { aISession: { create: (...a: unknown[]) => create(...a) } },
}));

import { createSession } from "../session.js";

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ id: "s1" });
});

describe("createSession", () => {
  it("links a system session (no user) to the execution the worker opened it for", async () => {
    await createSession({ projectId: "p1", workspaceId: "w1", executionId: "exec-1" });
    expect(create.mock.calls[0][0].data).toMatchObject({ userId: null, executionId: "exec-1" });
  });

  it("never links a user's own chat to an execution, whatever the caller sent", async () => {
    await createSession({
      projectId: "p1",
      workspaceId: "w1",
      userId: "u1",
      executionId: "exec-1",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ userId: "u1", executionId: null });
  });
});
