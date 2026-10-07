/**
 * Retention gate on the shared run-summary read.
 *
 * The same function answers the internal route that serves every caller of the public run
 * read and the agent, so the gate is pinned here once: across the plan table, the
 * fail-closed paths and the one-hour boundary buffer.
 *
 * Prisma is mocked; `@traceroot/core` is spread from the real module so the plan table and
 * `getRetentionDays` are the shipped ones, not a second copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationRun: { findFirst: vi.fn() },
  evaluationResult: { groupBy: vi.fn(), aggregate: vi.fn() },
  $queryRaw: vi.fn(),
  dataset: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
}));

vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: prismaMock,
}));

import { readRunSummary } from "./run-read";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const agoMs = (ms: number) => new Date(Date.now() - ms);
const daysAgo = (days: number) => agoMs(days * DAY_MS);

function run(startedAt: Date, id = "run-1") {
  return {
    id,
    evaluationId: "eval-1",
    projectId: "p1",
    runNumber: 1,
    candidateVersion: "sonnet",
    environment: "evaluation",
    status: "completed",
    datasetId: "ds1",
    datasetVersionId: "dv1",
    caseCount: 0,
    scoredCount: 0,
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [],
    startedAt,
    completedAt: startedAt,
    evaluation: { name: "Billing routing", evaluationKey: null },
    results: [],
  };
}

/** Read a run started `startedAt` on a workspace holding `plan` (null → no workspace). */
async function read(plan: string | null, startedAt: Date) {
  prismaMock.evaluationRun.findFirst.mockImplementation(async ({ where }) =>
    where.id === "run-1" ? run(startedAt) : null,
  );
  prismaMock.project.findUnique.mockResolvedValue(
    plan === null ? { workspace: null } : { workspace: { billingPlan: plan } },
  );
  return readRunSummary({ projectId: "p1", runId: "run-1" });
}

beforeEach(() => {
  prismaMock.evaluationRun.findFirst.mockReset();
  prismaMock.project.findUnique.mockReset();
  prismaMock.dataset.findFirst.mockReset();
  prismaMock.evaluationResult.groupBy.mockReset();
  prismaMock.evaluationResult.groupBy.mockResolvedValue([]);
  prismaMock.evaluationResult.aggregate.mockReset();
  prismaMock.evaluationResult.aggregate.mockResolvedValue({
    _avg: { durationMs: null, cost: null },
    _count: { durationMs: 0, cost: 0 },
  });
  prismaMock.$queryRaw.mockReset();
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.dataset.findFirst.mockResolvedValue({ id: "ds1", clientDatasetId: null });
});

describe("retention gate on the run-summary read", () => {
  it("refuses an out-of-window run with 403 and does no further work", async () => {
    const result = await read("free", daysAgo(20));
    expect(result).toEqual({ ok: false, status: 403, error: "Data outside retention window" });
    // One run lookup, and no results or dataset: a refusal reads nothing else.
    expect(prismaMock.evaluationRun.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.evaluationResult.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.evaluationResult.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.dataset.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["free", 14, true],
    ["free", 16, false],
    ["starter", 29, true],
    ["starter", 31, false],
    ["pro", 89, true],
    ["pro", 91, false],
  ])("on %s, a run %i days old is readable: %s", async (plan, days, readable) => {
    const result = await read(plan, daysAgo(days));
    expect(result.ok).toBe(readable);
  });

  it("reads a five-year-old run on an unlimited plan", async () => {
    const result = await read("enterprise", daysAgo(5 * 365));
    expect(result.ok).toBe(true);
  });

  it("fails closed to the most restrictive window for an unknown plan", async () => {
    expect((await read("legacy-plan", daysAgo(20))).ok).toBe(false);
    expect((await read("", daysAgo(20))).ok).toBe(false);
  });

  it("fails closed when the project has no readable workspace", async () => {
    expect((await read(null, daysAgo(20))).ok).toBe(false);
    prismaMock.project.findUnique.mockResolvedValue(null);
    expect((await readRunSummary({ projectId: "p1", runId: "run-1" })).ok).toBe(false);
  });

  it("keeps a missing run a 404 and skips the plan lookup", async () => {
    prismaMock.evaluationRun.findFirst.mockResolvedValue(null);
    const result = await readRunSummary({ projectId: "p1", runId: "nope" });
    expect(result).toEqual({ ok: false, status: 404, error: "Evaluation run not found" });
    expect(prismaMock.project.findUnique).not.toHaveBeenCalled();
  });

  it("honours the one-hour boundary buffer", async () => {
    expect((await read("free", agoMs(15 * DAY_MS + 30 * 60_000))).ok).toBe(true);
    expect((await read("free", agoMs(15 * DAY_MS + 2 * HOUR_MS))).ok).toBe(false);
  });
});
