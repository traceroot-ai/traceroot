import { describe, expect, it, vi } from "vitest";
import { repairAssignmentCopies } from "../projection.js";
import type { AssignmentRow } from "../backend-client.js";

function fixture() {
  const hit = {
    runId: "run",
    traceId: "trace",
    projectId: "project",
    detectorId: "detector",
    signalId: "original",
    embedding: [0.25, 0.75],
    score: 0.9 as number | null,
    criteriaVersion: 1 as number | null,
    assignedAt: new Date(1000),
    copyPending: true,
  };
  const db = {
    signalHit: {
      findMany: vi.fn(async () => (hit.copyPending ? [{ ...hit }] : [])),
      updateMany: vi.fn(async ({ where }: { where: { assignedAt: Date } }) => {
        if (hit.assignedAt.getTime() !== where.assignedAt.getTime()) return { count: 0 };
        hit.copyPending = false;
        return { count: 1 };
      }),
    },
  };
  return { hit, db };
}

describe("assignment projection repair", () => {
  it("retries a committed copy failure with the original embedding", async () => {
    const { hit, db } = fixture();
    const writeAssignments = vi
      .fn()
      .mockRejectedValueOnce(new Error("copy outage"))
      .mockResolvedValueOnce(undefined);
    await expect(
      repairAssignmentCopies(db as never, { writeAssignments }, "project", "detector"),
    ).rejects.toThrow("copy outage");
    expect(hit.copyPending).toBe(true);
    await repairAssignmentCopies(db as never, { writeAssignments }, "project", "detector");
    expect(writeAssignments.mock.calls[1][0]).toEqual([
      expect.objectContaining({ signal_id: "original", embedding: [0.25, 0.75] }),
    ]);
    expect(hit.copyPending).toBe(false);
  });

  it("an initial stale copy cannot acknowledge a placement moved during the write", async () => {
    const { hit, db } = fixture();
    const copies: AssignmentRow[] = [];
    const writeAssignments = vi.fn(async (rows: AssignmentRow[]) => {
      copies.push(...rows);
      if (copies.length === 1) {
        hit.signalId = "moved";
        hit.assignedAt = new Date(1001);
        hit.score = null;
        hit.criteriaVersion = null;
      }
    });
    await repairAssignmentCopies(db as never, { writeAssignments }, "project", "detector");
    expect(hit.copyPending).toBe(true);
    await repairAssignmentCopies(db as never, { writeAssignments }, "project", "detector");
    expect(copies.map((c) => [c.signal_id, c.assigned_at_ms])).toEqual([
      ["original", 1000],
      ["moved", 1001],
    ]);
    expect(hit.copyPending).toBe(false);
  });
});
