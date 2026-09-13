import { describe, it, expect, vi } from "vitest";

import { writeAudit } from "./audit";

describe("writeAudit", () => {
  it("writes one auditLog row with the entry fields and never throws to the caller", async () => {
    const create = vi.fn().mockResolvedValue({});
    await writeAudit({ auditLog: { create } } as never, {
      actorUserId: "u1",
      operation: "create_detector",
      resourceType: "detector",
      resourceId: "d1",
      projectId: "p1",
      summary: { name: "latency" },
      transport: "public-api",
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "create_detector",
        resourceId: "d1",
        transport: "public-api",
        agentSessionId: null,
        workspaceId: null,
      }),
    });
  });

  it("swallows a database error (audit must not fail the write)", async () => {
    const create = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      writeAudit({ auditLog: { create } } as never, {
        actorUserId: "u1",
        operation: "create_workspace",
        resourceType: "workspace",
        resourceId: "w1",
        summary: {},
        transport: "agent",
        agentSessionId: "as-1",
      }),
    ).resolves.toBeUndefined();
  });
});
