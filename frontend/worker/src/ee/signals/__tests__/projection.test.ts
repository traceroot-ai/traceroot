import { afterEach, describe, expect, it, vi } from "vitest";
import { runAssignmentRound } from "../round.js";
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
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the partition alive when an entire raw page consists of just-repaired copies", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { hit } = fixture();
    const pending = Array.from({ length: 200 }, (_, i) => ({ ...hit, runId: `r${i}` }));
    const rows = [
      ...pending.map((h) => ({
        run_id: h.runId,
        trace_id: h.traceId,
        finding_id: "f",
        timestamp_ms: 1000,
        trace_start_ms: 900,
        summary: "Failure",
        data: {},
      })),
      {
        run_id: "later",
        trace_id: "later",
        finding_id: "later",
        timestamp_ms: 1001,
        trace_start_ms: 900,
        summary: "Failure",
        data: {},
      },
    ];
    const embed = vi.fn();
    const models = vi.fn();
    const deps = {
      db: {
        signalHit: {
          findMany: vi.fn(async () => pending),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        detector: {
          findFirst: vi.fn(async () => ({
            name: "Failure",
            enableSignals: true,
            signalsEnabledAt: new Date(0),
            project: { workspaceId: "w" },
          })),
        },
      } as never,
      backend: {
        writeAssignments: vi.fn(async () => {}),
        waitingHits: vi.fn(async () => rows.slice(0, 200)),
        traceFindings: vi.fn(async () => []),
        unsettledRuns: vi.fn(async () => []),
      },
      embed,
      models,
      failures: { record: vi.fn(), clear: vi.fn() },
      startRcas: vi.fn(async () => 0),
      enqueueDigest: vi.fn(async () => {}),
      now: () => 2000,
    };
    const result = await runAssignmentRound(deps, "project", "detector");
    expect(result).toMatchObject({ waiting: 0, duplicate: 200, remaining: true });
    expect(embed).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
  });

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
