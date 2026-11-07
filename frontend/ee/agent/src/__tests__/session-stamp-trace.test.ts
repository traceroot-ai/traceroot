import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    aIMessage: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import { stampTraceStatus } from "../session.js";

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue({});
});

describe("stampTraceStatus", () => {
  it("replaces the pending status and keeps the rest of the row's metadata", async () => {
    findUnique.mockResolvedValue({
      metadata: { traceId: "f".repeat(32), traceStatus: "pending", tokenUsage: { total: 3 } },
    });
    await stampTraceStatus("m1", "available");
    expect(update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        metadata: { traceId: "f".repeat(32), traceStatus: "available", tokenUsage: { total: 3 } },
      },
    });
  });

  it("does nothing for a row that is gone", async () => {
    findUnique.mockResolvedValue(null);
    await stampTraceStatus("m1", "failed");
    expect(update).not.toHaveBeenCalled();
  });
});
