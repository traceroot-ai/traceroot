/**
 * The internal run routes and the public run read must report the SAME per-case averages
 * for one run. Every route here reads one set of result rows through a fake Prisma that
 * aggregates them the way Postgres does (SUM and COUNT skip a NULL), so a route that
 * divided by anything other than the results that reported a value would disagree with
 * `readRunSummary`, which the CLI and the agent read.
 */
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

type Row = Record<string, any>;

const holder = vi.hoisted(() => ({ prisma: {} as Record<string | symbol, unknown> }));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: new Proxy({}, { get: (_t, prop) => holder.prisma[prop] }) };
});
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "u1" } }),
  requireProjectAccess: async () => ({ project: { id: "p1" } }),
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

import { GET as listRuns } from "./route";
import { GET as readRunDetail } from "./[runId]/route";
import { GET as listCaseRuns } from "../../datasets/[datasetId]/test-cases/[testCaseId]/runs/route";
import { readRunSummary } from "@/lib/eval/run-read";

// The issue's reproduction: registered against a 200-case version without case_count, so
// caseCount is 200; ten results, all with a duration, only half with a cost.
const RESULTS: Row[] = Array.from({ length: 10 }, (_, i) => ({
  id: `res_${i}`,
  runId: "run1",
  projectId: "p1",
  testCaseId: `case-${i}`,
  status: "not_scored",
  change: null,
  createTime: new Date("2026-09-27T00:00:10Z"),
  durationMs: 1000,
  cost: i < 5 ? 0.02 : null,
  traceId: null,
  scores: [],
}));

const RUN: Row = {
  id: "run1",
  projectId: "p1",
  evaluationId: "e1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber: 1,
  candidateVersion: "sonnet",
  environment: "evaluation",
  status: "completed",
  baselineRunId: null,
  caseCount: 200,
  datasetCaseCount: null,
  selectionMode: null,
  selectedCaseCount: null,
  sampleSeed: null,
  scoredCount: 0,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  scorers: [],
  startedAt: new Date(),
  completedAt: new Date(),
  evaluation: { name: "Billing routing", evaluationKey: "billing-routing" },
  datasetVersion: { label: "v1", createTime: new Date(), versionNumber: 1 },
  baselineRun: null,
};

function resultsFor(where: Row): Row[] {
  const runIds: string[] =
    typeof where.runId === "string" ? [where.runId] : (where.runId?.in ?? [RUN.id]);
  return RESULTS.filter((r) => runIds.includes(r.runId));
}

/** SUM, AVG and COUNT over one column, skipping NULLs as Postgres does. */
function column(rows: Row[], field: string) {
  const xs = rows.map((r) => r[field]).filter((x): x is number => x != null);
  const sum = xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  return { sum, avg: sum === null ? null : sum / xs.length, count: xs.length };
}

function aggregate(rows: Row[]) {
  const d = column(rows, "durationMs");
  const c = column(rows, "cost");
  return {
    _sum: { durationMs: d.sum, cost: c.sum },
    _avg: { durationMs: d.avg, cost: c.avg },
    _count: { _all: rows.length, durationMs: d.count, cost: c.count },
  };
}

beforeEach(() => {
  holder.prisma = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    $queryRaw: async () => [],
    project: { findUnique: async () => ({ workspace: { billingPlan: "enterprise" } }) },
    dataset: {
      findMany: async () => [{ id: "ds1", name: "support" }],
      findFirst: async () => ({ id: "ds1", name: "support", clientDatasetId: "ds1" }),
    },
    evaluationRun: {
      findMany: async () => [RUN],
      count: async () => 1,
      findFirst: async ({ where }: Row) =>
        where.id === RUN.id ? { ...RUN, results: resultsFor({ runId: RUN.id }) } : null,
    },
    evaluationResult: {
      groupBy: async ({ by, where }: Row) => {
        const groups = new Map<string, Row[]>();
        for (const r of resultsFor(where)) {
          const key = JSON.stringify(by.map((f: string) => r[f]));
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()].map((rows) => ({
          ...Object.fromEntries(by.map((f: string) => [f, rows[0][f]])),
          ...aggregate(rows),
        }));
      },
      aggregate: async ({ where }: Row) => aggregate(resultsFor(where)),
      // The test-case history reads the one result for its case, with its run.
      findMany: async () => [{ ...RESULTS[0], run: RUN }],
    },
  };
});

async function publicMetrics() {
  const read = await readRunSummary({ projectId: "p1", runId: "run1" });
  if (!read.ok) throw new Error(`expected a body, got ${read.status}`);
  return Object.fromEntries(read.body.metrics.map((m) => [m.name, m]));
}

it("serves the same averages as the public run read when some results have no cost", async () => {
  const metrics = await publicMetrics();
  // The public read: cost over the 5 results that reported it, duration over all 10.
  expect(metrics.cost).toMatchObject({ value: 0.02, observed_count: 5 });
  expect(metrics.duration).toMatchObject({ value: 1000, observed_count: 10 });

  const listed = (
    (await (
      await listRuns({ nextUrl: { searchParams: new URLSearchParams() } } as never, {
        params: Promise.resolve({ projectId: "p1" }),
      })
    ).json()) as { data: Row[] }
  ).data[0];
  const detail = (
    (await (
      await readRunDetail({} as never, {
        params: Promise.resolve({ projectId: "p1", runId: "run1" }),
      })
    ).json()) as { run: Row }
  ).run;
  const caseRun = (
    (await (
      await listCaseRuns({} as never, {
        params: Promise.resolve({ projectId: "p1", datasetId: "ds1", testCaseId: "case-0" }),
      })
    ).json()) as { data: Row[] }
  ).data[0];

  for (const [surface, row] of Object.entries({ listed, detail, caseRun })) {
    expect(row.avgCost, surface).toBeCloseTo(metrics.cost.value as number, 12);
    expect(row.costObservedCount, surface).toBe(metrics.cost.observed_count);
    expect(row.avgDurationMs, surface).toBe(metrics.duration.value);
    expect(row.durationObservedCount, surface).toBe(metrics.duration.observed_count);
  }
  // Not 0.10 / 200 (the declared caseCount), and not 0.10 / 10 (every result row).
  expect(listed.avgCost).not.toBeCloseTo(0.0005, 6);
  expect(listed.avgCost).not.toBeCloseTo(0.01, 6);
});
